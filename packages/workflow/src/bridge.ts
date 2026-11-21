/**
 * What the parent does for the script: every request of the child
 * becomes a step of the invocation the run is, under the key the child gave it.
 *
 * A step with that key is the main step of the request, and the steps it needs besides — the
 * clock, the mark of the journal, the arming of a wake — are `<key>~now`, `<key>~mark` and
 * `<key>~arm`. They are all a function of the key, never of the order the requests arrive in, so
 * two branches that finish in another order on a replay keep their own answers.
 */

import { CANCEL_STEPS_ACTION, CORE_TYPES, CatchableError, DeniedError, NOW_ACTION, RANDOM_ACTION, WAIT_ACTION, action, actionName, currentInvocation, grantId, jsonOf, keyUnder, record, recordId, seq, stableJson, timestamp } from "@niwa-labs/core";
import type { Action, ActionTarget, AuthorizeHow, JournalReader, Principal, RecordType, Step, Verb } from "@niwa-labs/core";
import { owner } from "@niwa-labs/core";
import { AskAnswered, answeredBy, QuestionName, RequestCancelled, RequestExpired, requestAsk } from "@niwa-labs/requests/records";
import { TimerSlept, sleepKey, timerSleepRequest } from "@niwa-labs/timer/records";
import { z } from "zod";

import { valueOf } from "./ask.ts";
import { ScopeClosed, ScopeOpened, ScopeSettled } from "./records.ts";
import type { RunId } from "./records.ts";
import type { ScriptRequest } from "./language.ts";
import { holds } from "@niwa-labs/core";
import { sameCall } from "./revise.ts";
import type { RecordedCall } from "./revise.ts";
import type { CallRequest } from "./runner.ts";

/** The action the host serves for reading the journal. */
const RECORDS_READ = actionName("niwa.records.read");

/** What the bridge is given by the run. */
export interface BridgeDeps {
  /** The step of the invocation the run is. */
  step: Step;
  /** The run, as a principal: what a script calls is called as it, never as the handler that runs it. */
  run: Principal;
  /** The id of the run. */
  runId: RunId;
  /** The most branches a group of the run runs at once, set from outside the script. */
  concurrency?: number;
  /** Run `fn` when the clock of the host reaches `at`; the function returned forgets it. */
  schedule(at: number, fn: () => void): () => void;
  /** The journal, when the host is serving. */
  journal(): JournalReader;
  /** The action an agent call of that harness goes to. */
  agentAction(harness: string | undefined): Action<any, any> | undefined;
  /** The name of that action, for the message when there is none. */
  agentName(harness: string | undefined): string;
  /** The record types the script declares in `emits`, by their short name: it may emit only these. */
  emits: ReadonlyMap<string, RecordType<unknown>>;
  /** The calls the earlier starts of the run recorded, by key. */
  earlier: ReadonlyMap<string, RecordedCall>;
  /** What an earlier start of the run emitted under a key: the type and the data, when it did. */
  emitted(key: string): { type: string; data: unknown } | undefined;
  /** A call was recorded with another input: it is shown, not rerun. */
  shown(key: string): void;
  /** A step of the script did not complete. */
  failed(): void;
  /** Hold the run to its grant for what the script is about to do: it throws when the grant does not allow it. */
  authorize(verb: Verb, name: string, how?: AuthorizeHow): Promise<void>;
  /** The actions a session of the run is to see must lie within the grant of the run: it throws when they do not. */
  visible(masks: readonly string[]): void;
}

/** The actions a call asks a session to see: `visible` of an agent call, `visible.actions` of the sessions module's own. */
const Visible = z.object({
  visible: z.union([z.array(z.string()), z.object({ actions: z.array(z.string()).optional() })]).optional(),
});

/** What a call of a session start asks its session to see; nothing for any other call. */
function visibleOf(name: string, input: unknown): readonly string[] {
  if (name !== "session.start" && !name.startsWith("session.start.") && name !== "session.resume") return [];
  const asked = Visible.safeParse(input);
  const visible = asked.success ? asked.data.visible : undefined;
  return (Array.isArray(visible) ? visible : visible?.actions) ?? [];
}

/** The wait of a script: a record of a type, or the end of its timeout. */
const WaitInput = z.object({
  type: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  /** The sleeping place whose wake is the timeout. */
  place: z.string().optional(),
  /** The wait looks for the records after this position. */
  since: z.number().optional(),
});

/** The data of a state change, as the journal holds it. */
const StateChange = z.object({ name: z.string(), value: z.unknown() });

/**
 * The wait as an action: it waits for the record, or for the wake of its timeout.
 *
 * A wake that belongs to another sleep must not end this wait: the wake is waited for with the
 * key of this wait's sleeping place, and the answer names the type that arrived.
 */
export const WAIT = action("workflow.script.wait", {
  description: "Wait for a record of a type whose data holds the filter, or for the end of the timeout.",
  input: WaitInput,
  output: z.union([z.object({ data: z.unknown(), at: z.number() }), z.object({ timedOut: z.literal(true) })]),
  // The wait reads and waits: it may be entered again.
  recovery: "repeat",
  run: async (input, ctx) => {
    const wanted = { type: record(input.type, z.unknown()), ...(input.filter === undefined ? {} : { filter: input.filter }) };
    const from = input.since === undefined ? {} : { from: seq(input.since) };
    if (input.place === undefined) {
      const got = await ctx.wait(wanted.type, { ...wanted, ...from });
      return { data: got.data, at: got.at };
    }
    const got = await ctx.waitAnyOf([wanted, { type: TimerSlept, filter: { key: input.place } }] as const, from);
    return got.type === TimerSlept.name && input.type !== TimerSlept.name ? { timedOut: true as const } : { data: got.data, at: got.at };
  },
});

/** The actions that read the journal: they are made with it, so the host's own is not needed. */
function readers(journal: () => JournalReader) {
  return {
    mark: action("workflow.mark", {
      description: "Where the journal is now: a read as a step, so a replay reads the same position.",
      input: z.object({}),
      output: z.object({ seq: z.number() }),
      recovery: "repeat",
      run: () => ({ seq: journal().last() }),
    }),
    state: action("workflow.read.state", {
      description: "The state of a plugin: its values by name, as the journal holds them now.",
      input: z.object({ plugin: z.string().min(1) }),
      output: z.record(z.string(), z.unknown()),
      recovery: "repeat",
      run: (input) => {
        const values: Record<string, unknown> = {};
        for (const row of journal().find({ type: CORE_TYPES.stateChanged, field: "plugin", equals: input.plugin })) {
          const change = StateChange.safeParse(row.data);
          if (change.success) values[change.data.name] = change.data.value;
        }
        return values;
      },
    }),
  };
}

/** What the grant of the run said of one verb on one name: the denial as data, so a replay says the same without asking again. */
const Authorized = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  denied: z.object({ grant: z.string(), missing: z.string(), record: z.string().optional() }).optional(),
});

/** The type of an emit: one the script declares in `emits`, and no other. */
function emitType(deps: BridgeDeps, name: string): RecordType<unknown> {
  const type = deps.emits.get(name);
  if (type === undefined) throw new Error(`the script may emit only the records it declares in emits: "${name}" is not one`);
  return type;
}

/** The question of an `ask` was cancelled: the script gets this error, and it can catch it. */
export class AskCancelled extends Error {
  override name = "AskCancelled";
  constructor(message = "the question was cancelled") {
    super(message);
  }
}

/** Nobody answered the question of an `ask` within its timeout: the script gets this error, and it can catch it. */
export class AskExpired extends Error {
  override name = "AskExpired";
  constructor(message = "nobody answered the question in time") {
    super(message);
  }
}

/** How an ask ended without an answer. */
const AskEnd = z.object({ ended: z.enum(["cancelled", "expired"]) });

/** The error the script gets for an ask that ended without an answer. */
const askError = (ended: z.infer<typeof AskEnd>["ended"]): Error => (ended === "expired" ? new AskExpired() : new AskCancelled());

/** The name of the question a script puts to the owner. */
const SCRIPT_QUESTION = QuestionName.parse("workflow.ask");

/**
 * The end of an ask that got no answer, written as a step under `<key>~ended`.
 *
 * A cancelled or expired request is thrown to the caller and leaves no outcome on the ask itself,
 * so this step is what a replay finds: the script gets the same error, and the owner is not asked again.
 */
const ASK_ENDED = action("workflow.ask.ended", {
  description: "Write down that a question of the script ended with no answer.",
  input: AskEnd,
  output: AskEnd,
  recovery: "repeat",
  run: (input) => input,
});

/** The moment a timeout ends, in milliseconds since the epoch. */
const endOf = (now: number, ms: number): number => Math.round(now + ms);

/** What a group of branches answers when it opens: the limit from outside, its deadline, and what the run knows of it already. */
export interface ScopeOpenAnswer {
  concurrency?: number;
  deadline?: number;
  /** The outcomes the run committed for its branches before, by key: their places among the outcomes of the group. */
  known: Array<{ key: string; order: number; outcome: z.infer<typeof ScopeSettled.schema>["outcome"] }>;
  /** How the group closed before, when the run closed it already. */
  closed?: z.infer<typeof ScopeClosed.schema>["outcome"];
}

/** What a group sees of itself at one moment, recorded so a replay sees the same. */
const SNAPSHOT = (keys: readonly string[]) =>
  action("workflow.scope.snapshot", {
    description: "Record the branches a group of the script sees at one moment.",
    input: z.object({}),
    output: z.array(z.string()),
    recovery: "repeat",
    run: () => [...keys],
  });

/** What a bridge is: the function that does what the script asks, and the end of the script process. */
export interface Bridge {
  (request: CallRequest): Promise<unknown>;
  /** The script process is gone: what waits for the clock on its behalf answers now. */
  gone(): void;
}

/**
 * Do what a request of the script asks.
 *
 * A step that does not complete pauses the invocation, as it does for a handler; an error the
 * caller is meant to catch (an ask that was cancelled or expired) is not a failed step.
 */
export function bridge(deps: BridgeDeps): Bridge {
  const { step } = deps;
  const own = readers(deps.journal);
  /** The open groups whose block an outer cancel waits for. */
  const shields = new Set<string>();
  /** The waits for a deadline that are going, each with the way to answer it now. */
  const deadlines = new Set<() => void>();

  const guarded = async <T>(body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      if (!(error instanceof CatchableError)) deps.failed();
      throw error;
    }
  };

  /**
   * Hold the run to its grant for one verb on one name, as a step of its own under `<key>~auth`.
   *
   * It is a step so that the decision is made once: the invocation that enters the call again (a
   * wake, a restart) finds the answer in the journal, and the owner is not asked again nor a second
   * decision written. A denial is the answer of the step, and is thrown here, outside it, so the
   * script can catch it.
   */
  const authorized = async (key: string, verb: Verb, name: string, how?: AuthorizeHow): Promise<void> => {
    const held = action("workflow.authorize", {
      description: "Hold the run to its grant for one thing it is about to do.",
      input: z.object({ verb: z.string(), name: z.string() }),
      output: Authorized,
      // A question that was cut off is asked again: nothing was decided.
      recovery: "repeat",
      run: async (): Promise<z.infer<typeof Authorized>> => {
        try {
          await deps.authorize(verb, name, how);
          return { allowed: true };
        } catch (error) {
          if (!(error instanceof DeniedError)) throw error;
          return { allowed: false, reason: error.reason, ...(error.denied === undefined ? {} : { denied: error.denied }) };
        }
      },
    });
    const answer = await guarded(() => step(held, { verb, name }, { key: `${key}~auth` }));
    if (answer.allowed) return;
    const { denied } = answer;
    throw new DeniedError(
      answer.reason ?? "denied",
      denied === undefined
        ? undefined
        : {
            grant: grantId(denied.grant),
            missing: denied.missing,
            ...(denied.record === undefined ? {} : { record: recordId(denied.record) }),
          },
    );
  };

  /** What an earlier start of the run recorded under a key, when it was that step and it finished. */
  const finishedBefore = (key: string, name: string): RecordedCall | undefined => {
    const before = deps.earlier.get(key);
    return before !== undefined && before.finished && before.action === name ? before : undefined;
  };

  /** The clock as a step under a key; an earlier start of the run read it already, and a replay keeps that moment. */
  const clock = async (key: string): Promise<number> => {
    const before = finishedBefore(key, NOW_ACTION);
    return before === undefined ? guarded(() => step.now({ key })) : (before.outcome as number);
  };

  /** A call of an action: a call recorded with another input is shown, and a finished one is answered. */
  const act = async <I, O, In = I>(
    key: string,
    target: ActionTarget<I, O, In>,
    name: string,
    input: NoInfer<In>,
    reason?: string,
  ): Promise<O> => {
    const before = deps.earlier.get(key);
    if (before !== undefined) {
      if (!sameCall(before, { action: name, input: jsonOf(input) })) {
        deps.shown(key);
        throw new Error(`the call "${key}" was recorded with another input: it is shown, not rerun`);
      }
      if (before.finished) return before.outcome as O;
    }
    // The run is held to its grant for the call (a rule that asks puts the question to the owner);
    // the session it starts may see no more than the run does.
    await authorized(key, "call", name, { input, ...(reason === undefined ? {} : { reason }) });
    deps.visible(visibleOf(name, input));
    return guarded(() => step(target, input, { key, as: deps.run, ...(reason === undefined ? {} : { reason }) }));
  };

  /** The sleeping place of a request: the invocation and the key, so no other sleep shares it. */
  const placeOf = (key: string) => {
    const scope = currentInvocation();
    if (scope === undefined) throw new Error("a sleep or a wait with a timeout is a step of an invocation");
    return sleepKey(`${scope.invocation}:${key}`);
  };

  /** Ask for a wake at the end of a timeout; the clock is read as a step, so a replay keeps the moment. */
  const arm = async (key: string, ms: number): Promise<string> => {
    const place = placeOf(key);
    const at = endOf(await clock(`${key}~now`), ms);
    await step(timerSleepRequest, { at, key: place }, { key: `${key}~arm` });
    return place;
  };

  const sleep = async (key: string, ms: number): Promise<null> => {
    // A sleep that ended in an earlier start is over: it is not begun again.
    if (finishedBefore(key, WAIT_ACTION) !== undefined) return null;
    const place = placeOf(key);
    const at = endOf(await clock(`${key}~now`), ms);
    // The wait begins before the request is written: a wake that is written at once, for a
    // moment that has passed, must not be missed.
    const waiting = step.wait(TimerSlept, { filter: { key: place }, key });
    const settled = waiting.then(
      () => ({ refused: false as const }),
      (error: unknown) => ({ refused: true as const, error }),
    );
    await step(timerSleepRequest, { at, key: place }, { key: `${key}~arm` });
    const outcome = await settled;
    if (outcome.refused) throw outcome.error;
    return null;
  };

  const wait = async (key: string, request: Extract<ScriptRequest, { op: "wait" }>): Promise<unknown> => {
    // A wait reads the journal: it is held to the same right as a read of records.
    await authorized(key, "call", RECORDS_READ);
    const filter = request.filter === undefined ? {} : { filter: request.filter };
    // A wait from a position looks after it; one without looks after where the journal was when it
    // began, so a record that arrives while the wake is being armed is not missed.
    const since = request.from ?? (request.timeoutMs === undefined ? undefined : (await guarded(() => step(own.mark, {}, { key: `${key}~mark` }))).seq);
    const after = since === undefined ? {} : { since };
    if (request.timeoutMs === undefined) {
      return guarded(() => step(WAIT, { type: request.type, ...filter, ...after }, { key }));
    }
    const place = await arm(key, request.timeoutMs);
    return guarded(() => step(WAIT, { type: request.type, ...filter, place, ...after }, { key }));
  };

  const ask = async (key: string, request: Extract<ScriptRequest, { op: "ask" }>): Promise<unknown> => {
    // An answer the owner gave in an earlier start is the answer: the owner is not asked again.
    const answered = finishedBefore(key, requestAsk.name);
    if (answered !== undefined) return valueOf(request.question, AskAnswered.parse(answered.outcome).answer);
    // An ask that ended with no answer in an earlier start ends the same way: the owner is not asked again.
    const noAnswer = finishedBefore(`${key}~ended`, ASK_ENDED.name);
    if (noAnswer !== undefined) throw askError(AskEnd.parse(noAnswer.outcome).ended);
    // A run may always ask the owner, who can refuse: asking needs nothing in `uses`.
    const deadline =
      request.timeoutMs === undefined
        ? {}
        : { deadline: timestamp(endOf(await clock(`${key}~now`), request.timeoutMs)) };
    try {
      const { answer } = answeredBy(
        await guarded(() =>
          step(requestAsk, { to: owner, question: SCRIPT_QUESTION, input: request.question, ...deadline }, { key, as: deps.run }),
        ),
      );
      return valueOf(request.question, answer);
    } catch (error) {
      // The owner cancelled the question, or the time ran out: the script gets an error to catch.
      if (!(error instanceof RequestExpired || error instanceof RequestCancelled)) throw error;
      const ended = error instanceof RequestExpired ? "expired" : "cancelled";
      await guarded(() => step(ASK_ENDED, { ended }, { key: `${key}~ended` }));
      throw askError(ended);
    }
  };

  const call = async ({ key, request }: CallRequest): Promise<unknown> => {
    switch (request.op) {
      case "agent": {
        const target = deps.agentAction(request.input.harness);
        if (target === undefined) {
          throw new Error(`no agent action is configured for "${deps.agentName(request.input.harness)}"`);
        }
        return act(key, target, target.name, request.input);
      }
      case "call":
        return act(key, actionName(request.action), request.action, request.input, request.reason);
      case "wait":
        return wait(key, request);
      case "sleep":
        return sleep(key, request.ms);
      case "ask":
        return ask(key, request);
      case "emit": {
        const type = emitType(deps, request.record);
        const before = deps.emitted(key);
        if (before !== undefined) {
          // Written by an earlier start of the run: it is not written twice, and another record under the same key is shown.
          const now = type.schema.safeParse(request.data);
          if (before.type !== type.name || !now.success || stableJson(before.data) !== stableJson(now.data)) {
            deps.shown(key);
            throw new Error(`the emit "${key}" was recorded with another type or data: it is shown, not written again`);
          }
          return null;
        }
        // Data the declared schema refuses is the script's error to catch, not a failed step: the child's own parse is not trusted.
        const data = type.schema.safeParse(request.data);
        if (!data.success) throw new Error(`emit "${type.name}": the data does not pass the record's schema: ${z.prettifyError(data.error)}`);
        await authorized(key, "emit", type.name);
        await guarded(() => step.emit(type, data.data, { key }));
        return null;
      }
      case "read-state":
        await authorized(key, "call", RECORDS_READ);
        return guarded(() => step(own.state, { plugin: request.plugin }, { key }));
      case "read-records":
        // The records, and where the next read or wait goes on: a wait from `next` misses nothing.
        return act(key, RECORDS_READ, RECORDS_READ, request.query);
      case "now":
        return clock(key);
      case "random": {
        const before = finishedBefore(key, RANDOM_ACTION);
        return before === undefined ? guarded(() => step.random({ key })) : before.outcome;
      }
      case "scope-open":
        return openScope(request);
      case "scope-settled":
        return settleBranch(request);
      case "scope-cancel": {
        // A shielded group under a cancelled branch is spared: the cancel waits for its block to end.
        const except = [...shields].filter((open) => request.prefixes.some((prefix) => open !== prefix && keyUnder(open, prefix)));
        const invocation = currentInvocation()?.invocation;
        if (invocation === undefined) throw new Error("a cancel of branches is a step of an invocation");
        await guarded(() =>
          step(CANCEL_STEPS_ACTION, { invocation, prefixes: request.prefixes, ...(except.length === 0 ? {} : { except }), reason: request.reason }, { key }),
        );
        return null;
      }
      case "scope-snapshot":
        return guarded(() => step(SNAPSHOT(request.keys), {}, { key }));
      case "scope-deadline":
        return new Promise((resolve) => {
          let forget: () => void = () => undefined;
          const answer = (fired: boolean): void => {
            forget();
            deadlines.delete(gone);
            resolve({ fired });
          };
          const gone = (): void => answer(false);
          deadlines.add(gone);
          forget = deps.schedule(request.at, () => answer(true));
        });
      case "scope-close":
        shields.delete(request.scope);
        await step.emit(ScopeClosed, { run: deps.runId, scope: request.scope, outcome: request.outcome }, { key: `scope-closed:${request.scope}` });
        return null;
    }
  };

  /** The records of one type this run wrote for one group, in the order they were written. */
  const groupRecords = <T extends { scope: string }>(type: { name: string; schema: z.ZodType<T> }, scope: string): T[] =>
    deps
      .journal()
      .find({ type: type.name as never, field: "run", equals: deps.runId })
      .map((row) => type.schema.parse(row.data))
      .filter((data) => data.scope === scope);

  /**
   * Open a group: its deadline is read from the clock once, as a step, so a replay keeps the moment; the answer
   * says what the run committed of the group before, so the order of its outcomes is the order it was.
   */
  const openScope = async (request: Extract<ScriptRequest, { op: "scope-open" }>): Promise<ScopeOpenAnswer> => {
    const deadline = request.deadlineMs === undefined ? undefined : endOf(await clock(`scope-now:${request.scope}`), request.deadlineMs);
    if (request.shield === true) shields.add(request.scope);
    await step.emit(
      ScopeOpened,
      {
        run: deps.runId,
        scope: request.scope,
        onExit: request.onExit,
        ...(deadline === undefined ? {} : { deadline }),
        ...(request.onDeadline === undefined ? {} : { onDeadline: request.onDeadline }),
        ...(request.shield === true ? { shield: true } : {}),
        ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
      },
      { key: `scope-open:${request.scope}` },
    );
    const known = new Map<string, ScopeOpenAnswer["known"][number]>();
    for (const settled of groupRecords(ScopeSettled, request.scope)) known.set(settled.key, { key: settled.key, order: settled.order, outcome: settled.outcome });
    const closed = groupRecords(ScopeClosed, request.scope).at(-1)?.outcome;
    return {
      ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
      ...(deadline === undefined ? {} : { deadline }),
      known: [...known.values()],
      ...(closed === undefined ? {} : { closed }),
    };
  };

  /**
   * Commit the outcome of a branch and answer its place among the outcomes of its group.
   *
   * The place is the order of the commits, not of the ends of outside work. A branch the run committed
   * before with the same outcome keeps its place, so a replay and a resume give the outcomes in the
   * order the script saw them; any other outcome takes the next place.
   */
  const settleBranch = async (request: Extract<ScriptRequest, { op: "scope-settled" }>): Promise<{ order: number }> => {
    const committed = groupRecords(ScopeSettled, request.scope);
    const before = committed.filter((one) => one.key === request.key).at(-1);
    const order =
      before !== undefined && before.outcome === request.outcome
        ? before.order
        : committed.reduce((highest, one) => Math.max(highest, one.order + 1), 0);
    await step.emit(
      ScopeSettled,
      {
        run: deps.runId,
        scope: request.scope,
        key: request.key,
        order,
        outcome: request.outcome,
        ...(request.error === undefined ? {} : { error: request.error }),
      },
      { key: `scope-settled:${request.scope}.${request.key}` },
    );
    return { order };
  };

  return Object.assign(call, {
    gone: (): void => {
      for (const answer of [...deadlines]) answer();
    },
  });
}
