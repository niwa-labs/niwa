/**
 * One invocation of one handler: where the code of a plugin meets the journal.
 *
 * The identity of an invocation is the handler plus the record that woke it, so the same pair is
 * always the same invocation and running it again is a replay. What matters inside it is written
 * down twice — the intent before the call, the outcome after it — so that after a crash the
 * recorded steps answer for themselves. An invocation ends as "done", "waiting" (it asked for a
 * record that has not arrived; the wait is a step of its own) or "paused" (a decision is needed).
 */

import { heldAction, targetName } from "../action.ts";
import { callerOf } from "../access.ts";
import type { Standing } from "../access.ts";
import type { InvocationScope } from "../invocation-scope.ts";
import { NOW_ACTION, RANDOM_ACTION, RUNNING, SuspendSignal, WAIT_ACTION, offeredChoices, stepKey } from "../invocation-scope.ts";
import { decide } from "./intercept.ts";
import type { Decision, Intercepts, Issues } from "./intercept.ts";
import {
  attemptOperationId,
  attemptRecordId,
  attemptsOf,
  cancelHolds,
  cancelOf,
  checkOutcome,
  keyUnder,
  resolutionOf,
} from "../outcome.ts";
import type { StepsCancelled } from "../outcome.ts";
import { CatchableError, IntegrityError, StepCancelled, UnknownAction, effectPossibleAfter } from "../errors.ts";
import { CORE_TYPES, newRecordId, recordId, stableJson, streamId } from "../record.ts";
import { keptOutcome, storedOutcome } from "../stores.ts";
import type { ArtifactStore } from "../stores.ts";
import type {
  ActionStepOptions,
  ActionTarget,
  Action,
  ActionContext,
  ActionName,
  ActionStep,
  AnyWaited,
  AppendEntry,
  Caller,
  Handler,
  HandlerId,
  InvocationId,
  InvocationState,
  Journal,
  NewRecord,
  OperationId,
  Outcome,
  Principal,
  RecordId,
  RecordType,
  RecordTypeName,
  Recovery,
  Effect,
  Seq,
  Step,
  StepEmitOptions,
  StepKey,
  StepOptions,
  StoredRecord,
  StreamId,
  JournalReader,
  WaitEntry,
  WaitKey,
  WaitQuery,
  Waited,
} from "../types.ts";

/** One invocation of one handler, as the host hands it over. */
export interface InvocationSpec {
  /** `inv:${handlerId}:${record.id}` — the identity of this invocation. */
  readonly id: InvocationId;
  /** `${pluginName}/${handlerName}` — the handler this invocation runs. */
  readonly handlerId: HandlerId;
  /** The record that woke the invocation. */
  readonly record: StoredRecord;
  /** The code to run. */
  readonly handler: Handler<any>;
  /** The record type's schema parse: the data the handler receives. */
  parse(data: unknown): unknown;
  /**
   * Set when a record of a type this invocation waits for woke it: the record may not be its
   * answer. A run that finds the invocation still waiting writes nothing, not even "running".
   */
  readonly woken?: boolean;
}

/** What an invocation needs from the host to run. */
export interface RunnerDeps {
  /** The journal: what was already recorded is read from here. */
  journal: Journal;
  /**
   * The artifacts of the host: a step's value too large for a record is kept here, and the record
   * holds its reference. Absent, every value is kept in its record.
   */
  artifacts?: ArtifactStore;
  /** The clock of the host: the moment a step that reads the time sees. */
  now(): number;
  /** Commit the records and publish them. Returns the committed records. */
  append(recs: NewRecord[]): StoredRecord[];
  /** Commit the records with their links, and publish them. */
  appendAll(entries: AppendEntry[]): StoredRecord[];
  /** The actions of the host, by name. A step never needs it: a step has the action by value. */
  resolveAction(name: string): Action<any, any> | undefined;
  /**
   * The intercepts registered on an action, by name.
   *
   * A step of an invocation passes through them like any other call: the adjusts run, the guards
   * decide. An action nobody registered an intercept on has none.
   */
  interceptsOf(name: string): Intercepts;
  /**
   * What a principal a step is made as stands on. The one who made the step held the call to it as
   * requested; a call an adjust moves to another target is held to it again. Absent, it is not.
   */
  standingOf?(caller: Caller): Standing;
  /**
   * Write a record on behalf of an action: the type must be one its own plugin declares.
   *
   * The placement of the record is the runtime's business: the actor is the caller, and the
   * cause and the root come from the invocation the call runs in.
   */
  emit<T>(
    action: ActionName,
    type: RecordType<T>,
    data: T,
    caller: Caller,
    place: Placement,
  ): Promise<StoredRecord>;
  /**
   * Check a record a handler writes, as a record written over the wire is checked: the type is
   * declared, and the handler's own plugin declares it, or it is open, or the caller's grant lets it
   * write it. The data is read through the schema of the type as it is declared, not through the copy
   * the handler holds. Throws when the record may not be written.
   */
  admitEmit(caller: Caller, type: RecordTypeName, data: unknown): { readonly data: unknown; readonly version: number };
}

/** Where a record written by a call belongs: under the invocation, or on its own chain. */
export interface Placement {
  /** The id of the record. */
  readonly id: RecordId;
  /** The stream the record belongs to: whose journal this record is in. */
  readonly stream: StreamId;
  /** The record that produced this one. Null when the write starts its own chain. */
  readonly cause: RecordId | null;
  /** The external input the chain started from. */
  readonly root: RecordId;
}

/** How an invocation ended. */
export type RunResult = "done" | "waiting" | "paused";

/** The identity of an invocation: the handler that runs and the record that woke it. */
export function invocationId(handler: HandlerId, record: RecordId): InvocationId {
  return `inv:${handler}:${record}` as InvocationId;
}

/** The identity of one operation: the invocation plus the step key, stable across repeats. */
export function operationId(invocation: InvocationId, key: StepKey): OperationId {
  return attemptOperationId(invocation, key, 0);
}

/** The invocation pauses: it needs a decision, and the code stops here. */
class PauseSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PauseSignal";
  }
}

/**
 * A step did not complete, but the handler said its work is no longer wanted: the invocation does
 * not pause for it, and ends as done.
 */
class AbandonSignal extends PauseSignal {
  constructor() {
    super("abandoned");
    this.name = "AbandonSignal";
  }
}

/** The journal refused the write: a failure of the host, not of the handler. */
class AppendFailure extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : `journal refused the write: ${String(cause)}`);
    this.name = "AppendFailure";
  }
}

/** Remember the refusal of the journal in the run, and throw it. */
function appendFailed(ctx: RunContext, cause: unknown): never {
  ctx.failure ??= new AppendFailure(cause);
  throw ctx.failure;
}

/** What one run of an invocation needs: the ids derived from the spec, and the counter. */
interface RunContext {
  readonly deps: RunnerDeps;
  readonly invocation: InvocationId;
  readonly stream: StreamId;
  readonly actor: Caller;
  readonly cause: RecordId;
  readonly root: RecordId;
  /** How many key-less steps this run has made: the ordinal of the next one. */
  ordinal: number;
  /** How many key-less emits this run has made: the ordinal of the next one. */
  emitOrdinal: number;
  /** The reason of the first pause signalled in this run: a handler that swallows it cannot hide it. */
  pause: string | undefined;
  /** The step the first pause happened on, when it happened on a step. */
  pauseKey: StepKey | undefined;
  /** True when this run signalled a suspend that the handler swallowed. */
  suspended: boolean;
  /** True once the handler said its work is no longer wanted: a step that fails from then on pauses nothing. */
  abandoned: boolean;
  /** The first refusal of the journal in this run: a handler that swallows it cannot hide it. */
  failure: AppendFailure | undefined;
  /** True while this run has not written "running": it is a wake of a waiting invocation. */
  quiet: boolean;
  /** The steps that are being run right now, by key: a second call under a key joins the first. */
  readonly flights: Map<StepKey, Flight>;
}

/**
 * The calls of actions in flight in this process, by invocation and key: what a cancel of steps
 * reaches. A call outlives the run of its invocation when another step of it suspended the run,
 * so the calls are kept here, apart from any run, until each one ends.
 */
const CALLS = new Map<InvocationId, Map<StepKey, AbortController>>();

/**
 * Cut short the calls in flight that a cancel of steps holds, in this process.
 *
 * The cancel itself is the record the host writes; this reaches the calls that are running now,
 * so a session of an agent is told to stop instead of working for nobody. It says how many calls
 * were cut short.
 */
export function abortSteps(cancel: StepsCancelled): number {
  const calls = CALLS.get(cancel.invocation);
  if (calls === undefined) return 0;
  let aborted = 0;
  for (const [key, controller] of calls) {
    if (!cancelHolds(cancel, key) || controller.signal.aborted) continue;
    controller.abort(cancel.reason);
    aborted += 1;
  }
  return aborted;
}

/** The outcome of a step a cancel holds. */
const cancelledOutcome = (cancel: StepsCancelled): Outcome<never> => ({ status: "cancelled", reason: cancel.reason });

/**
 * The waits under a step that a cancel ended with it: an intent with no outcome under the key is
 * given the cancelled outcome, so nothing is left waiting for a step that is over.
 */
function closeOpenWaits(ctx: RunContext, key: StepKey, cancel: StepsCancelled): void {
  const open: NewRecord[] = [];
  for (const row of ctx.deps.journal.find({ type: CORE_TYPES.stepIntent, field: "invocation", equals: ctx.invocation })) {
    const data = row.data as { key?: unknown; action?: unknown };
    if (typeof data.key !== "string" || data.key === key || !keyUnder(data.key, key) || data.action !== WAIT_ACTION) continue;
    const nested = stepKey(data.key);
    if (ctx.deps.journal.get(attemptRecordId(ctx.invocation, nested, 0, "outcome")) !== undefined) continue;
    open.push(outcomeRecord(ctx, nested, cancelledOutcome(cancel), 0));
  }
  if (open.length > 0) commitAll(ctx, open);
}

/** One step that is being run: which call it is, and what it will come to. */
interface Flight {
  readonly call: string;
  readonly done: Promise<StepResult<any>>;
}

/**
 * Pause the invocation: it needs a decision, and the code stops here.
 *
 * The reason is remembered in the run, because a handler may catch the pause and carry on. What
 * the handler does with the pause is its own business; what the invocation ends as is not.
 */
function pause(ctx: RunContext, reason: string, key?: StepKey): never {
  if (ctx.abandoned) throw new AbandonSignal();
  if (ctx.pause === undefined) {
    ctx.pause = reason;
    ctx.pauseKey = key;
  }
  throw new PauseSignal(reason);
}

/** Suspend the invocation: it waits for a record that has not arrived yet. */
function suspend(ctx: RunContext): never {
  ctx.suspended = true;
  throw new SuspendSignal();
}

/**
 * Run one invocation of one handler. Re-entrant: running it again replays the recorded steps.
 *
 * The ordinary failures of an invocation are outcomes, not exceptions: a handler that throws, a
 * step that does not complete, a wait that is not answered. Only a journal that refuses the write
 * is thrown, because that the host cannot carry on with.
 */
export async function runInvocation(deps: RunnerDeps, inv: InvocationSpec): Promise<RunResult> {
  const ctx: RunContext = {
    deps,
    invocation: inv.id,
    stream: streamId(`invocation:${inv.id}`),
    actor: { kind: "handler", handler: inv.handlerId, invocation: inv.id },
    cause: inv.record.id,
    root: inv.record.root,
    ordinal: 0,
    emitOrdinal: 0,
    pause: undefined,
    pauseKey: undefined,
    suspended: false,
    abandoned: false,
    failure: undefined,
    quiet: inv.woken === true && latestState(deps.journal, inv.id) === "waiting",
    flights: new Map(),
  };
  const step = makeStep(ctx);
  if (!ctx.quiet) writeState(ctx, "running");
  try {
    // The handler runs inside the scope of this invocation: a state read inside it is recorded
    // against this invocation, and a replay returns what was read the first time.
    const scope: InvocationScope = {
      invocation: inv.id,
      handler: inv.handlerId,
      cause: inv.record.id,
      root: inv.record.root,
      reads: 0,
      writes: 0,
      closed: false,
      writing: () => startRunning(ctx),
    };
    try {
      await RUNNING.run(scope, () => inv.handler(parseRecord(ctx, inv), step, inv.record));
    } finally {
      scope.closed = true;
    }
  } catch (error) {
    // The journal refused the write: the host has to hear about it, not about a paused handler.
    if (ctx.failure !== undefined) throw ctx.failure.cause;
    if (error instanceof SuspendSignal) {
      writeState(ctx, "waiting");
      return "waiting";
    }
    // The work was given up and a step of it failed after that: nobody is left to decide about it.
    if (error instanceof AbandonSignal) {
      writeState(ctx, "done");
      return "done";
    }
    const reason =
      error instanceof PauseSignal ? error.reason : `handler error: ${messageOf(error)}`;
    writeState(ctx, "paused", reason, ctx.pauseKey);
    return "paused";
  }
  // The handler caught the refusal of the journal and returned anyway: the host still hears it.
  if (ctx.failure !== undefined) throw ctx.failure.cause;
  // The handler caught the pause or the suspend and returned anyway: the invocation still ends as
  // it was signalled, because the decision it needs did not go away.
  if (ctx.pause !== undefined) {
    writeState(ctx, "paused", ctx.pause, ctx.pauseKey);
    return "paused";
  }
  if (ctx.suspended) {
    writeState(ctx, "waiting");
    return "waiting";
  }
  writeState(ctx, "done");
  return "done";
}

/** The data the handler receives; a schema failure is a decision for an owner, not a crash. */
function parseRecord(ctx: RunContext, inv: InvocationSpec): unknown {
  try {
    return inv.parse(inv.record.data);
  } catch (error) {
    pause(ctx, `record data does not match the handler's type: ${messageOf(error)}`);
  }
}

/**
 * How the key a caller gave a step becomes the key the step is recorded under. The handler's keys
 * are its own; the keys of an intercept are put under the step it intercepts.
 */
type KeyScope = <O extends StepOptions>(opts: O | undefined) => O | undefined;

/** The part of a key that marks the steps of an intercept: no step of a handler may hold it. */
const INTERCEPT_MARK = "~guard~";

/** The keys of a handler are its own, except that none may fall into the namespace of an intercept. */
const handlerScope: KeyScope = (opts) => {
  if (opts?.key?.includes(INTERCEPT_MARK)) {
    throw new TypeError(
      `step key must not contain "${INTERCEPT_MARK}", it names the steps of an intercept: ${JSON.stringify(opts.key)}`,
    );
  }
  return opts;
};

/** The step function handed to the handler, or to an intercept when `scope` says so. */
function makeStep(ctx: RunContext, scope: KeyScope = handlerScope): Step {
  /**
   * The action a step calls: the one it holds, or the one the host has under that name.
   *
   * A name is how one module reaches another: the caller knows the
   * name of the action and nothing else about it. A name nobody serves is a failed step, not a
   * crash: the step is recorded with the name, so a replay answers the same way.
   */
  const actionOf = <I, O, In = I>(target: ActionTarget<I, O, In>): Action<I, O, In> | undefined => {
    return (heldAction(target) ??
      ctx.deps.resolveAction(targetName(target))) as Action<I, O, In> | undefined;
  };

  const call = async <I, O, In = I>(
    target: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    opts?: StepOptions,
  ): Promise<O> => {
    const action = actionOf(target);
    if (action === undefined) {
      // A name nobody serves: the invocation pauses on the step, and the code that catches the
      // typed error cannot hide that.
      const key = nextKey(ctx, scope(opts));
      const missing = new UnknownAction(targetName(target));
      ctx.pause ??= `step ${key}: ${missing.message}`;
      ctx.pauseKey ??= key;
      throw missing;
    }
    const { key, outcome } = await runStep(ctx, action, input, scope(opts));
    if (outcome.status === "completed") return outcome.value;
    // The owner said skip: the step is not called and the code continues without it.
    if (outcome.status === "skipped") return undefined as O;
    // A cancelled step pauses nothing: the code that made it catches the cancel.
    if (outcome.status === "cancelled") throw new StepCancelled(key, outcome.reason);
    pause(ctx, `step ${key}: ${outcome.status}`, key);
  };
  return Object.assign(call, {
    outcome: async <I, O, In = I>(
      target: ActionTarget<I, O, In>,
      input: NoInfer<In>,
      opts?: StepOptions,
    ): Promise<Outcome<O>> => {
      const action = actionOf(target);
      if (action === undefined) {
        // The step still takes its key, so the steps after it keep theirs.
        nextKey(ctx, scope(opts));
        return {
          status: "failed",
          error: new UnknownAction(targetName(target)).message,
          effectPossible: false,
        };
      }
      const result = await runStep(ctx, action, input, scope(opts));
      if (result.outcome.status === "skipped") {
        return { status: "failed", error: `step ${result.key}: skipped`, effectPossible: false };
      }
      return result.outcome;
    },
    wait: async <T>(type: RecordType<T>, opts?: StepOptions & WaitQuery<T>): Promise<Waited<T>> =>
      awaitRecords(ctx, nextKey(ctx, scope(opts)), [{ type, ...(opts?.filter === undefined ? {} : { filter: opts.filter }) }], opts?.from).then(
        (found) => ({ data: found.data as T, at: found.at }),
      ),
    emit: async <T>(
      type: RecordType<T>,
      data: T,
      opts?: StepEmitOptions,
    ): Promise<StoredRecord> => stepEmit(ctx, type, data, scope(opts)),
    abandon: (): void => {
      ctx.abandoned = true;
    },
    now: async (opts?: StepOptions): Promise<number> =>
      readValue(ctx, NOW_ACTION, ctx.deps.now(), scope(opts)),
    random: async (opts?: StepOptions): Promise<number> =>
      readValue(ctx, RANDOM_ACTION, Math.random(), scope(opts)),
  });
}

/**
 * The step function an intercept gets.
 *
 * An intercept that itself needs a call to the outside makes it as a step of the invocation that
 * is calling the action: the call is recorded, and a replay answers
 * with what was recorded. No transaction is held while it waits.
 *
 * The keys are put under the intercepted step and its attempt —
 * `${intercepted}~guard~a${attempt}~${name}` — and the handler may not use a key with that mark,
 * so a step of an intercept is never the step of the handler. The name is the explicit key behind
 * `k.`, or the ordinal of the key-less calls, so the two never meet either. A new attempt of the
 * intercepted step has a namespace of its own: the guards are asked again, not answered from the
 * previous attempt. Intercepts of one call share the ordinal; an explicit key is shared by them.
 */
function interceptStep(ctx: RunContext, intercepted: StepKey, attempt: number): Step {
  let ordinal = 0;
  return makeStep(ctx, (opts) => {
    const own = opts?.key;
    const name = own === undefined ? String((ordinal += 1)) : `k.${own}`;
    return { ...opts, key: `${intercepted}${INTERCEPT_MARK}a${attempt}~${name}` } as NonNullable<typeof opts>;
  });
}

/**
 * Write a record from inside a handler.
 *
 * The record belongs to the chain the handler was woken in: the waking record is its cause, the
 * root of the waking record is its root, and the handler is its actor. The runtime sets all
 * three; the code of the handler chooses only the type and the data.
 *
 * The id is deterministic — `${invocation}/emit/${key}` — so a replay of the same invocation
 * finds the record that was written the first time and returns it, instead of writing a second
 * one. The key is the explicit one, or the ordinal of the key-less emits of this invocation.
 */
async function stepEmit<T>(
  ctx: RunContext,
  type: RecordType<T>,
  data: T,
  opts?: StepEmitOptions,
): Promise<StoredRecord> {
  const key = emitKey(ctx, opts);
  const admitted = ctx.deps.admitEmit(ctx.actor, type.name, data);
  const rec: NewRecord = {
    id: recordId(`${ctx.invocation}/emit/${key}`),
    stream: ctx.stream,
    type: type.name,
    schema: admitted.version,
    data: admitted.data,
    actor: ctx.actor,
    cause: ctx.cause,
    root: ctx.root,
  };
  // A replay finds the record it wrote the first time: that is not progress.
  if (ctx.deps.journal.get(rec.id) === undefined) startRunning(ctx);
  try {
    return first(ctx.deps.appendAll([{ record: rec, links: opts?.links }]));
  } catch (error) {
    // The same key with other content is a replay mismatch, not a failure of the host.
    if (error instanceof IntegrityError) pause(ctx, `replay mismatch at emit ${key}`);
    return appendFailed(ctx, error);
  }
}

/**
 * The key of the next emit: the explicit one, or the ordinal of the key-less emits.
 *
 * The ordinal counts the key-less emits only, so an emit with an explicit key never takes a
 * number away from them.
 */
function emitKey(ctx: RunContext, opts?: StepEmitOptions): string {
  if (opts?.key !== undefined) return stepKey(opts.key);
  ctx.emitOrdinal += 1;
  return String(ctx.emitOrdinal);
}

/**
 * The clock and the random numbers, read as steps.
 *
 * They are recorded like any other step, so a replay reads the same moment and the same number
 * again. Without that the code between the steps would not be reproducible.
 */
async function readValue(
  ctx: RunContext,
  action: ActionName,
  value: number,
  opts?: StepOptions,
): Promise<number> {
  const key = nextKey(ctx, opts);
  const intent = ctx.deps.journal.get(attemptRecordId(ctx.invocation, key, 0, "intent"));
  // The same key must read the same thing: a clock read at a key that held a random number is a
  // different call, and the recorded value is not its answer.
  if (intent !== undefined && isMismatch(intent, action, undefined)) {
    pause(ctx, `replay mismatch at step ${key}`, key);
  }
  const recorded = ctx.deps.journal.get(attemptRecordId(ctx.invocation, key, 0, "outcome"));
  if (recorded !== undefined) {
    const outcome = readOutcome<number>(ctx, recorded.data);
    if (outcome.status === "completed") return outcome.value;
  }
  if (intent === undefined) {
    commitAll(ctx, [intentRecord(ctx, key, action, undefined, operationId(ctx.invocation, key), 0)]);
  }
  settle(ctx, key, { status: "completed", value }, 0);
  return value;
}

/** What a step ended with, and the key it was recorded under. */
interface StepResult<O> {
  readonly key: StepKey;
  readonly outcome: Outcome<O> | SkippedOutcome;
}

/** The outcome of a step the owner told the code to skip: it was not called at all. */
interface SkippedOutcome {
  readonly status: "skipped";
}

/**
 * One step: the decision, the intent, the call, the outcome.
 *
 * The order of the checks is the contract: a recorded intent that differs from the current call is
 * a replay mismatch and nothing is called again; a recorded outcome ends the step; an intent
 * without an outcome is a call that was cut off, and the action's own check is asked first — its
 * answer turns unknown into completed or failed — and the recovery contract decides only when the
 * check cannot say; a step with neither is fresh, so the decision is made and recorded first, then
 * the intent, and only then is the input checked and the action called.
 *
 * The decision is the intercepts' work: the adjusts run, the guards decide, and what was decided
 * is recorded with the requested and the final input. A step that already ended keeps its
 * decision, so the guards are not asked again. A new attempt — the owner said retry — is asked
 * again, because the call to the outside happens again.
 */
async function runStep<I, O, In = I>(
  ctx: RunContext,
  action: Action<I, O, In>,
  input: NoInfer<In>,
  opts: StepOptions | undefined,
): Promise<StepResult<O>> {
  const key = nextKey(ctx, opts);
  const parsed = action.input.safeParse(input);
  const call = `${action.name}\n${stableJson(parsed.success ? parsed.data : input)}`;
  // A step is admitted once per key. Two calls under one key that run at the same time would both
  // find the journal empty and both enter the action: the second waits for the first. The same
  // call gets the answer of the first; another call is judged by what the first recorded, as if it
  // had come after it.
  for (let flying = ctx.flights.get(key); flying !== undefined; flying = ctx.flights.get(key)) {
    if (flying.call === call) return flying.done;
    await flying.done.then(
      () => undefined,
      () => undefined,
    );
  }
  const done = runStepOnce(ctx, action, input, opts, key);
  ctx.flights.set(key, { call, done });
  try {
    return await done;
  } finally {
    if (ctx.flights.get(key)?.done === done) ctx.flights.delete(key);
  }
}

/** One step that was admitted under its key: the checks and the call of `runStep`. */
async function runStepOnce<I, O, In = I>(
  ctx: RunContext,
  action: Action<I, O, In>,
  input: NoInfer<In>,
  opts: StepOptions | undefined,
  key: StepKey,
): Promise<StepResult<O>> {
  // The call is made as the principal the step names, or as the handler.
  const as = opts?.as;
  const caller = callerAs(ctx, as);
  const parsed = action.input.safeParse(input);
  const held = parsed.success ? parsed.data : input;

  // The first try is attempt 0, a retry is the next one.
  const attempts = attemptsOf(ctx.deps.journal, ctx.invocation, key);
  // The owner may have answered a pause about this step: the answer is in the journal.
  const choice = resolutionOf(ctx.deps.journal, ctx.invocation, key, attempts)?.choice;

  // The owner said skip: the step is not called, and the code continues without it.
  if (choice === "skip") return { key, outcome: { status: "skipped" } };

  // The owner said retry: a new attempt, with its own operation id and its own records.
  // Otherwise the step continues the attempt in flight.
  const attempt = choice === "retry" ? attempts : Math.max(attempts - 1, 0);
  const operation = attemptOperationId(ctx.invocation, key, attempt);
  const intent = ctx.deps.journal.get(attemptRecordId(ctx.invocation, key, attempt, "intent"));
  const recorded = ctx.deps.journal.get(attemptRecordId(ctx.invocation, key, attempt, "outcome"));
  const decision = ctx.deps.journal.get(
    attemptRecordId(ctx.invocation, key, attempt, "decision"),
  );

  // The recorded call and the current one must be the same call. The intent holds the input the
  // action was run with, which is the final one, so the requested input is read from the decision.
  if (intent !== undefined) {
    const requested = decision === undefined ? held : readDecision(decision).requested;
    const recordedAction = (intent.data as { action?: unknown }).action;
    if (recordedAction !== action.name) {
      pause(
        ctx,
        `replay mismatch at step ${key}: it was recorded as a call to ${String(recordedAction)}, and the code now calls ${action.name}`,
        key,
      );
    }
    if (stableJson(requested) !== stableJson(held)) {
      pause(
        ctx,
        `replay mismatch at step ${key}: the call to ${action.name} was recorded with another input than the code gives it now`,
        key,
      );
    }
  }

  // The step already ended: its outcome is the answer, whatever it was.
  if (recorded !== undefined) {
    const outcome = readOutcome<O>(ctx, recorded.data);
    if (outcome.status !== "completed") return { key, outcome };
    // The journal holds the value as JSON; the step gives it back as the output schema reads it,
    // as it gave it the first time.
    const value = action.output.safeParse(outcome.value);
    if (!value.success) {
      pause(
        ctx,
        `replay mismatch at step ${key}: the recorded output of ${action.name} does not fit its output schema now`,
        key,
      );
    }
    return { key, outcome: { status: "completed", value: value.data } };
  }

  // A cancel holds the step: it is not called, and a call of it that was cut off is not made again.
  const cancel = cancelOf(ctx.deps.journal, ctx.invocation, key);
  if (cancel !== undefined) {
    const outcome = cancelledOutcome(cancel);
    if (intent !== undefined) {
      closeOpenWaits(ctx, key, cancel);
      return settle<O>(ctx, key, outcome, attempt);
    }
    commitAll(ctx, [intentRecord(ctx, key, action.name, held, operation, attempt, action.recovery), outcomeRecord(ctx, key, outcome, attempt)]);
    return { key, outcome };
  }

  if (intent === undefined) {
    // Fresh: the decision is made and recorded before the intent, so the journal shows what was
    // decided and what was run.
    const decided = await decideCall(ctx, caller, action, input, key, attempt, opts?.reason, as !== undefined);
    if (decided.kind === "invalid") {
      // The intent is written even when the call never happened, so the journal shows what was
      // called. It is written together with the outcome: an intent alone reads as a call that
      // was cut off.
      const error = describeIssues(invalidMessage(action.name, decided.which), decided.issues);
      const outcome: Outcome<O> = { status: "failed", error, effectPossible: false };
      commitAll(ctx, [
        intentRecord(ctx, key, action.name, held, operation, attempt, action.recovery, action.effect),
        outcomeRecord(ctx, key, outcome, attempt),
      ]);
      return { key, outcome };
    }
    if (decided.kind === "denied") {
      // The call never happened, so nothing of it may look cut off: the decision, the intent and
      // the denial are one write.
      const outcome: Outcome<O> = { status: "denied", reason: decided.reason };
      commitAll(ctx, [
        decisionRecord(ctx, key, decided, attempt),
        intentRecord(ctx, key, action.name, decided.final, operation, attempt, action.recovery, decided.effect ?? action.effect),
        outcomeRecord(ctx, key, outcome, attempt),
      ]);
      return { key, outcome };
    }
    // The intent carries the class the call was decided under: what this call is, not the most the
    // action can be.
    commitAll(ctx, [
      decisionRecord(ctx, key, decided, attempt),
      intentRecord(ctx, key, action.name, decided.final, operation, attempt, action.recovery, decided.effect),
    ]);
    return callAction(ctx, as, key, action, decided.final, operation, attempt);
  }

  // An action that is suspended in a wait of its own was not cut off: it is waiting, and it is
  // entered again so the wait can end. The check and the recovery contract are for a call that
  // was cut off, so a waiting call goes past them.
  //
  // A call that waits inside a call it made itself is waiting too: the wait belongs to the
  // nested call, and the answer reaches it there. Such a call is entered again as well, or its
  // recovery contract would judge a call that was never cut off.
  const suspended = suspendedInWait(ctx, key, attempt) || suspendedInNestedStep(ctx, key, attempt);
  if (!suspended && !answeredInNestedStep(ctx, key, attempt)) {
    // An intent without an outcome: the call was cut off. The action's own check is asked first,
    // because it knows whether the effect happened.
    const checked = await checkOutcome(action, operation, { caller });
    if (checked.status === "completed") {
      // What the check found is the value of the step, so it is read as the output is.
      const value = action.output.safeParse(checked.value);
      if (!value.success) {
        const error = describeIssues(`output of ${action.name} does not match its schema`, value.error.issues);
        return settle<O>(ctx, key, { status: "failed", error, effectPossible: true }, attempt);
      }
      return settle<O>(ctx, key, { status: "completed", value: value.data }, attempt);
    }
    if (checked.status !== "unknown") {
      return settle<O>(ctx, key, checked, attempt);
    }

    // The check could not say, so the recovery contract decides: the one the call was made under,
    // which is what the other side was promised, not the one the code declares now.
    if (recoveryOf(intent) === "do-not-repeat") {
      return settle<O>(ctx, key, { status: "unknown" }, attempt);
    }
  }

  // The call may already have happened, so nothing is known about it.
  if (!parsed.success) return settle<O>(ctx, key, { status: "unknown" }, attempt);

  // Entering a waiting call again is not a new call to the outside: the decision it was
  // made with stands. When no adjust changed the input, the intercepts are not asked again and the
  // call goes on with the input in hand: the journal holds its JSON, not the value itself.
  const latest = suspended ? latestDecision(ctx, key, attempt) : undefined;
  const stands = latest === undefined ? undefined : readDecision(latest);
  if (stands !== undefined && !stands.denied && stableJson(stands.final) === stableJson(stands.requested)) {
    return callAction(ctx, as, key, action, parsed.data, operation, attempt);
  }

  // The call is made again: the guards are asked again, and a decision other than the one that
  // stands is recorded, a denial with its reason among them.
  const decided = await decideCall(ctx, caller, action, input, key, attempt, opts?.reason, as !== undefined);
  if (decided.kind === "invalid") {
    const error = describeIssues(invalidMessage(action.name, decided.which), decided.issues);
    return settle<O>(ctx, key, { status: "failed", error, effectPossible: false }, attempt);
  }
  const changed =
    stands === undefined ||
    stands.denied !== (decided.kind === "denied") ||
    stableJson(stands.final) !== stableJson(decided.final) ||
    stands.effect !== decided.effect;
  if (decided.kind === "denied") {
    // The denial ends the step: what was decided and the denial are one write.
    const outcome: Outcome<O> = { status: "denied", reason: decided.reason };
    commitAll(ctx, [
      ...(changed ? [decisionRecord(ctx, key, decided, attempt)] : []),
      outcomeRecord(ctx, key, outcome, attempt),
    ]);
    return { key, outcome };
  }
  if (changed) commitAll(ctx, [decisionRecord(ctx, key, decided, attempt)]);

  // "repeat" and "repeat-with-key" call again with the same operation id: the other side dedupes
  // by it, or the action is safe to call twice.
  return callAction(ctx, as, key, action, decided.final, operation, attempt);
}

/**
 * The key of a wait made inside an action: it belongs to the attempt of the step that made it,
 * and its number counts the waits of that call only ("2.wait-1", "2.2.wait-1" on a retry).
 */
function actionWaitKey(key: StepKey, attempt: number, ordinal: number): StepKey {
  return stepKey(`${ownerKey(key, attempt)}.wait-${String(ordinal)}`);
}

/**
 * The key of a call made inside an action: it belongs to the attempt of the step that made it,
 * and its number counts the calls of that run only ("2.step-1", "2.2.step-1" on a retry).
 */
function actionStepKey(key: StepKey, attempt: number, ordinal: number): StepKey {
  return stepKey(`${ownerKey(key, attempt)}.step-${String(ordinal)}`);
}

/** The step a call of an attempt belongs to: its own key, or the key of the attempt after it. */
function ownerKey(key: StepKey, attempt: number): string {
  return attempt === 0 ? key : `${key}.${String(attempt + 1)}`;
}

/**
 * Whether the call of this attempt is suspended in a wait of its own: a wait it made has its
 * intent and no outcome yet. Such a call is waiting, not cut off; once its waits are answered
 * and it goes on, a call that stops later is cut off like any other.
 */
function suspendedInWait(ctx: RunContext, key: StepKey, attempt: number): boolean {
  for (let ordinal = 1; ; ordinal += 1) {
    const waitKey = actionWaitKey(key, attempt, ordinal);
    if (ctx.deps.journal.get(attemptRecordId(ctx.invocation, waitKey, 0, "intent")) === undefined) {
      return false;
    }
    if (ctx.deps.journal.get(attemptRecordId(ctx.invocation, waitKey, 0, "outcome")) === undefined) {
      return true;
    }
  }
}

/**
 * Whether a call this attempt made inside itself is waiting.
 *
 * The nested call waits inside the call that made it, so the wait is the nested call's own: the
 * answer reaches it there, and the call that made it is entered again so the answer arrives.
 * Such a call was not cut off, and its recovery contract does not judge it.
 *
 * The calls inside the nested call are looked at too, as deep as they go: the wait may be
 * three calls down, and every call above it is waiting for it.
 *
 * A nested call that was cut off is not waiting: it has an intent and no outcome, like a wait,
 * but nothing is waiting for an answer. Its own recovery contract judges it.
 */
function suspendedInNestedStep(ctx: RunContext, key: StepKey, attempt: number): boolean {
  for (let ordinal = 1; ; ordinal += 1) {
    const nested = actionStepKey(key, attempt, ordinal);
    const attempts = attemptsOf(ctx.deps.journal, ctx.invocation, nested);
    if (attempts === 0) return false;
    if (suspendedInWait(ctx, nested, attempts - 1)) return true;
    if (suspendedInNestedStep(ctx, nested, attempts - 1)) return true;
  }
}

/**
 * Whether the owner has answered a pause on a call this attempt made inside itself.
 *
 * The attempt did not stop where it was: a nested call had no usable outcome, the invocation
 * paused on it, and the owner decided - retry or skip. The attempt is entered again so the answer
 * reaches the nested call; its recovery contract is about a call that was cut off, and this one
 * was not. An answer to a nested call applies to the nested call's last attempt only, so once a
 * retry has run, the answer is spent.
 *
 * The calls inside the nested call are looked at too, as deep as they go, as for a wait: the
 * call that paused may be two calls down, and every call above it is entered again.
 */
function answeredInNestedStep(ctx: RunContext, key: StepKey, attempt: number): boolean {
  for (let ordinal = 1; ; ordinal += 1) {
    const nested = actionStepKey(key, attempt, ordinal);
    const attempts = attemptsOf(ctx.deps.journal, ctx.invocation, nested);
    if (attempts === 0) return false;
    if (resolutionOf(ctx.deps.journal, ctx.invocation, nested, attempts) !== undefined) return true;
    if (answeredInNestedStep(ctx, nested, attempts - 1)) return true;
  }
}

/**
 * Make the call and record what came of it.
 *
 * A call that throws is a failed outcome with a possible effect: the effect may have happened
 * before the throw. A call that returns something the output schema does not accept is a failed
 * outcome too, and again the effect happened.
 *
 * A call that suspends is neither: the invocation waits, and the call is made again when the
 * answer arrives. The suspend is passed through, so the wait is not read as a failure.
 */
async function callAction<I, O, In = I>(
  ctx: RunContext,
  as: Principal | undefined,
  key: StepKey,
  action: Action<I, O, In>,
  input: I,
  operation: OperationId,
  attempt: number,
): Promise<StepResult<O>> {
  let value: O;
  const nested = stepFor(ctx, key, attempt);
  // A cancel of the step aborts the call: its outcome is written then, and what the call returns
  // after that is not its outcome.
  const controller = new AbortController();
  const calls = CALLS.get(ctx.invocation) ?? new Map<StepKey, AbortController>();
  CALLS.set(ctx.invocation, calls);
  calls.set(key, controller);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal), { once: true });
  });
  try {
    const running = action.run(input, {
      operationId: operation,
      caller: callerAs(ctx, as),
      invocation: ctx.invocation,
      signal: controller.signal,
      emit: emitFor(ctx, action.name, operation),
      wait: waitFor(ctx, key, attempt),
      waitAnyOf: waitAnyFor(ctx, key, attempt),
      step: nested.step,
    });
    // The call that was cut short may still end, and nobody waits for it.
    running.catch(() => undefined);
    value = await Promise.race([running, aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      return settle<O>(ctx, key, { status: "cancelled", reason: typeof reason === "string" ? reason : "cancelled" }, attempt);
    }
    // The invocation is waiting, not failing: the call is made again when the answer arrives.
    if (error instanceof SuspendSignal) throw error;
    // An error the caller catches is not a failed step: it belongs to the code that called the
    // action, and no outcome is written for it. The call may be made again, so the error is
    // thrown again and the caller catches it again.
    if (error instanceof CatchableError) throw error;
    // A nested call of this run paused: the invocation needs a decision about that call, and this
    // call is not failed - it is made again when the decision comes.
    if (nested.paused()) throw error;
    // A failure leaves the effect possible unless the action says it sent nothing.
    return settle<O>(
      ctx,
      key,
      { status: "failed", error: messageOf(error), effectPossible: effectPossibleAfter(error) },
      attempt,
    );
  } finally {
    if (calls.get(key) === controller) calls.delete(key);
    if (calls.size === 0 && CALLS.get(ctx.invocation) === calls) CALLS.delete(ctx.invocation);
  }
  // The code swallowed the pause of a nested call and returned: what it returned rests on a call
  // that has no answer yet, so it is not recorded as this call's outcome.
  if (nested.paused()) {
    throw ctx.abandoned ? new AbandonSignal() : new PauseSignal(ctx.pause ?? `step ${key}: a nested step paused`);
  }
  const parsed = action.output.safeParse(value);
  if (!parsed.success) {
    const error = describeIssues(`output of ${action.name} does not match its schema`, parsed.error.issues);
    return settle<O>(ctx, key, { status: "failed", error, effectPossible: true }, attempt);
  }
  return settle<O>(ctx, key, { status: "completed", value: parsed.data }, attempt);
}

/**
 * The write of a record made by an action inside an invocation.
 *
 * The record is the handler's own: the actor is the handler, the cause is the record that woke
 * the invocation and the root is the chain it belongs to. The id follows the operation and the
 * ordinal of the write, and the operation is stable across repeats of a step, so a repeat
 * returns the record it wrote instead of writing a second one.
 */
function emitFor(ctx: RunContext, action: ActionName, operation: OperationId): ActionContext["emit"] {
  let ordinal = 0;
  return async <T>(type: RecordType<T>, data: T): Promise<StoredRecord> => {
    ordinal += 1;
    const id = recordId(`${operation}/emit/${ordinal}`);
    // A repeat finds the record it wrote the first time: that is not progress.
    if (ctx.deps.journal.get(id) === undefined) startRunning(ctx);
    return ctx.deps.emit(action, type, data, ctx.actor, {
      id,
      stream: ctx.stream,
      cause: ctx.cause,
      root: ctx.root,
    });
  };
}

/**
 * The wait made by an action inside an invocation.
 *
 * Its key belongs to the step that made it ("2.wait-1"), so it neither takes a number from the
 * steps of the handler nor collides with them, and a step can tell that it is waiting. `since` is
 * the record after which the answer is looked for: an action that wrote a record and then waits for its answer passes that record,
 * so an answer that arrived between the write and the wait is not missed.
 */
function waitFor(ctx: RunContext, key: StepKey, attempt: number): ActionContext["wait"] {
  let ordinal = 0;
  return async <T>(type: RecordType<T>, query?: WaitQuery<T>): Promise<Waited<T>> => {
    ordinal += 1;
    const entry = { type, ...(query?.filter === undefined ? {} : { filter: query.filter }) };
    const found = await awaitRecords(ctx, actionWaitKey(key, attempt, ordinal), [entry], query?.from);
    return { data: found.data as T, at: found.at };
  };
}

/**
 * The wait for the first of several record types.
 *
 * It is one wait with one key, and the answer says which type it was: the invocation is woken
 * by any of the types, and the code that waits knows what arrived. The oldest record of the
 * types that matches is the answer, so the first of them is the one that happened first.
 */
function waitAnyFor(ctx: RunContext, key: StepKey, attempt: number): ActionContext["waitAnyOf"] {
  let ordinal = 0;
  return async <Entries extends readonly WaitEntry<any>[]>(
    entries: Entries,
    opts?: { readonly from?: Seq },
  ): Promise<AnyWaited<Entries[number]["type"]>> => {
    ordinal += 1;
    const found = await awaitRecords(ctx, actionWaitKey(key, attempt, ordinal), entries, opts?.from);
    return found as AnyWaited<Entries[number]["type"]>;
  };
}

/** Who a call is made as: the principal the step names, or the handler that runs the invocation. */
function callerAs(ctx: RunContext, as: Principal | undefined): Caller {
  return as === undefined ? ctx.actor : callerOf(as);
}

/**
 * The call an action makes inside an invocation.
 *
 * The nested call is a step of the same invocation, under the key of the step that made it
 * ("2.step-1"): it has an intent, an outcome, a replay, a recovery contract and the intercepts
 * of a top-level step. The key belongs to the step that made it, so it never takes a number
 * away from the steps of the handler.
 *
 * A name nobody serves is a failed step: the invocation pauses on it, and the code that catches
 * the typed error cannot hide that.
 */
function stepFor(
  ctx: RunContext,
  key: StepKey,
  attempt: number,
): { step: ActionStep; paused: () => boolean } {
  let ordinal = 0;
  let paused = false;
  const actionOf = <I, O, In = I>(target: ActionTarget<I, O, In>): Action<I, O, In> | undefined => {
    return (heldAction(target) ??
      ctx.deps.resolveAction(targetName(target))) as Action<I, O, In> | undefined;
  };
  /**
   * The nested call itself. A pause deeper down - a call this nested call made paused, or its
   * replay did not match - is a pause of this run too: the call that made it is made again when
   * the decision comes, and it is not failed.
   */
  const nestedRun = async <I, O, In = I>(
    action: Action<I, O, In>,
    input: NoInfer<In>,
    nested: StepKey,
    opts?: ActionStepOptions,
  ): Promise<StepResult<O>> => {
    try {
      return await runStep(ctx, action, input, { key: nested, ...(opts?.as === undefined ? {} : { as: opts.as }) });
    } catch (error) {
      if (error instanceof PauseSignal) paused = true;
      throw error;
    }
  };
  const call = async <I, O, In = I>(
    target: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    opts?: ActionStepOptions,
  ): Promise<O> => {
    ordinal += 1;
    const nested = actionStepKey(key, attempt, ordinal);
    const action = actionOf(target);
    if (action === undefined) {
      const missing = new UnknownAction(targetName(target));
      paused = true;
      ctx.pause ??= `step ${nested}: ${missing.message}`;
      ctx.pauseKey ??= nested;
      throw missing;
    }
    const { outcome } = await nestedRun(action, input, nested, opts);
    if (outcome.status === "completed") return outcome.value;
    // The owner said skip: the call is not made and the code continues without it.
    if (outcome.status === "skipped") return undefined as O;
    if (outcome.status === "cancelled") throw new StepCancelled(nested, outcome.reason);
    paused = true;
    pause(ctx, `step ${nested}: ${outcome.status}`, nested);
  };
  const step = Object.assign(call, {
    outcome: async <I, O, In = I>(
      target: ActionTarget<I, O, In>,
      input: NoInfer<In>,
      opts?: ActionStepOptions,
    ): Promise<Outcome<O>> => {
      ordinal += 1;
      const nested = actionStepKey(key, attempt, ordinal);
      const action = actionOf(target);
      if (action === undefined) {
        return {
          status: "failed",
          error: new UnknownAction(targetName(target)).message,
          effectPossible: false,
        };
      }
      const { outcome } = await nestedRun(action, input, nested, opts);
      if (outcome.status === "skipped") {
        return { status: "failed", error: `step ${nested}: skipped`, effectPossible: false };
      }
      return outcome;
    },
  });
  return { step, paused: () => paused };
}

/**
 * The key the host indexes a wait under, from its filter: the first field at the top of the data
 * whose value is a text. A wait with no such field is indexed by its type alone.
 */
export function waitKeyOf(filter: Readonly<Record<string, unknown>> | undefined): WaitKey | undefined {
  for (const [field, equals] of Object.entries(filter ?? {})) {
    if (!field.includes(".") && typeof equals === "string") return { field, equals };
  }
  return undefined;
}

/** What one wait found: the type of the record, its data as the type reads it, and its position. */
export interface FoundRecord {
  readonly type: RecordTypeName;
  readonly data: unknown;
  readonly at: Seq;
}

/**
 * The earliest record after a position that answers a wait: of one of the types, at its version,
 * with data its schema reads and its filter holds. Undefined when there is none yet.
 */
export function findWaited(
  journal: JournalReader,
  entries: readonly WaitEntry<any>[],
  after: Seq,
): FoundRecord | undefined {
  let found: FoundRecord | undefined;
  for (const entry of entries) {
    const filter = entry.filter as Readonly<Record<string, unknown>> | undefined;
    for (const candidate of journal.query({ types: [entry.type.name], ...(filter === undefined ? {} : { filter }), from: after })) {
      if (found !== undefined && candidate.seq >= found.at) break;
      // A record of another version is another shape: it is not read through this one.
      if (candidate.schema !== entry.type.version) continue;
      const parsed = entry.type.schema.safeParse(candidate.data);
      if (!parsed.success) continue;
      found = { type: entry.type.name, data: parsed.data, at: candidate.seq };
      break;
    }
  }
  return found;
}

/**
 * Wait for the first record of several types, under a key: intent, answer from the journal, or
 * suspend.
 *
 * The wait is a step: it has a key, an intent that says what is waited for — the types, their
 * filters and the position — and an outcome that is written only when the answer arrives: the
 * type, the data and the position of the record. A replay that waits for something else is a
 * replay mismatch; one that waits for the same reads the recorded answer through the type's
 * schema, at the same position. The answer is looked for after `from`, or after the intent.
 */
async function awaitRecords(
  ctx: RunContext,
  key: StepKey,
  entries: readonly WaitEntry<any>[],
  from?: Seq,
): Promise<FoundRecord> {
  const operation = operationId(ctx.invocation, key);
  const intentId = attemptRecordId(ctx.invocation, key, 0, "intent");
  const outcomeId = attemptRecordId(ctx.invocation, key, 0, "outcome");
  const filters = entries.map((entry) => (entry.filter ?? {}) as Readonly<Record<string, unknown>>);
  // The host wakes the wait by one field: the one every filter names with the same value, if any.
  const keys = filters.map((filter) => waitKeyOf(filter));
  const shared = keys[0] !== undefined && keys.every((one) => stableJson(one) === stableJson(keys[0])) ? keys[0] : undefined;
  const names = entries.map((entry) => entry.type.name);
  const waited = {
    ...(entries.length === 1 ? { type: names[0], filter: filters[0] } : { types: names, filters }),
    ...(from === undefined ? {} : { from }),
    ...(shared === undefined ? {} : { key: shared }),
  };

  // The same key must wait for the same thing. This is checked before the recorded outcome is
  // read: a key that now waits for something else is a different call.
  let intent = ctx.deps.journal.get(intentId);
  if (intent !== undefined && isMismatch(intent, WAIT_ACTION, waited)) {
    pause(ctx, `replay mismatch at step ${key}`, key);
  }

  // The answer is already there: the recorded outcome is the answer, read through the schema of
  // the type it names, at the position it was found at.
  const recorded = ctx.deps.journal.get(outcomeId);
  if (recorded !== undefined) {
    const outcome = readOutcome<{ type: string; data: unknown; at: number }>(ctx, recorded.data);
    if (outcome.status === "cancelled") throw new StepCancelled(key, outcome.reason);
    if (outcome.status !== "completed") pause(ctx, `step ${key}: ${outcome.status}`, key);
    const answered = entries.find((entry) => entry.type.name === outcome.value.type);
    const value = answered?.type.schema.safeParse(outcome.value.data);
    if (answered === undefined || value === undefined || !value.success) {
      pause(ctx, `replay mismatch at step ${key}: the recorded answer does not fit the types waited for now`, key);
    }
    return { type: answered.type.name, data: value.data, at: outcome.value.at as Seq };
  }

  // A cancel holds the wait: it ends without an answer, and the code that made it catches the cancel.
  const cancel = cancelOf(ctx.deps.journal, ctx.invocation, key);
  if (cancel !== undefined) {
    commitAll(ctx, [
      ...(intent === undefined ? [intentRecord(ctx, key, WAIT_ACTION, waited, operation, 0)] : []),
      outcomeRecord(ctx, key, cancelledOutcome(cancel), 0),
    ]);
    throw new StepCancelled(key, cancel.reason);
  }

  if (intent === undefined) {
    intent = first(commitAll(ctx, [intentRecord(ctx, key, WAIT_ACTION, waited, operation, 0)]));
  }

  const found = findWaited(ctx.deps.journal, entries, from ?? intent.seq);
  if (found !== undefined) {
    settle(ctx, key, { status: "completed", value: found }, 0);
    return found;
  }

  // Nothing yet: the invocation waits, and the wait survives a restart.
  suspend(ctx);
}

/** Whether a record's data carries the value a wait's key names; a wait without a key admits all. */
export function admits(key: WaitKey | undefined, data: unknown): boolean {
  if (key === undefined) return true;
  return typeof data === "object" && data !== null && (data as Record<string, unknown>)[key.field] === key.equals;
}

/**
 * The key of the next step: the explicit one, or the ordinal of the key-less calls.
 *
 * The ordinal counts the key-less calls only, so a step with an explicit key never takes a number
 * away from them. The code of the handler has to reach the same steps in the same order on a
 * replay, or the keys are not the keys of the recorded steps.
 */
function nextKey(ctx: RunContext, opts?: StepOptions): StepKey {
  if (opts?.key !== undefined) return stepKey(opts.key);
  ctx.ordinal += 1;
  return stepKey(String(ctx.ordinal));
}

/** The intent of a step: which action, with what input, under which operation id, recovery contract and effect class. */
function intentRecord(
  ctx: RunContext,
  key: StepKey,
  action: ActionName,
  input: unknown,
  operation: OperationId,
  attempt: number,
  recovery?: Recovery,
  effect?: Effect,
): NewRecord {
  return recordOf(ctx, attemptRecordId(ctx.invocation, key, attempt, "intent"), CORE_TYPES.stepIntent, {
    invocation: ctx.invocation,
    key,
    action,
    input,
    operationId: operation,
    ...(recovery === undefined ? {} : { recovery }),
    ...(effect === undefined ? {} : { effect }),
  });
}

/** The outcome of a step: what came of it, for good. */
function outcomeRecord<O>(ctx: RunContext, key: StepKey, outcome: Outcome<O>, attempt: number): NewRecord {
  return recordOf(ctx, attemptRecordId(ctx.invocation, key, attempt, "outcome"), CORE_TYPES.stepOutcome, {
    invocation: ctx.invocation,
    key,
    outcome: keptOutcome(outcome, ctx.deps.artifacts),
  });
}

/** Write the outcome of a step. */
function settle<O>(
  ctx: RunContext,
  key: StepKey,
  outcome: Outcome<O>,
  attempt: number,
): StepResult<O> {
  commitAll(ctx, [outcomeRecord(ctx, key, outcome, attempt)]);
  return { key, outcome };
}

/** What the intercepts decided: the requested and the final input, and a denial's reason. */
function decisionRecord<I>(
  ctx: RunContext,
  key: StepKey,
  decision: Decision<I>,
  attempt: number,
): NewRecord {
  // A call made again after a cut-off is decided again: its decision gets the next free id.
  const first = attemptRecordId(ctx.invocation, key, attempt, "decision");
  let id = first;
  for (let n = 2; ctx.deps.journal.get(id) !== undefined; n++) id = recordId(`${first}#${n}`);
  return recordOf(ctx, id, CORE_TYPES.stepDecision, {
    invocation: ctx.invocation,
    key,
    attempt,
    requested: decision.requested,
    final: decision.final,
    denied: decision.kind === "denied",
    ...(decision.kind === "denied" ? { reason: decision.reason } : {}),
    ...(decision.kind !== "invalid" && decision.effect !== undefined ? { effect: decision.effect } : {}),
  });
}

/**
 * The recovery contract an intent was written under.
 *
 * An intent that does not say is a call whose contract nobody recorded: it is not repeated.
 */
function recoveryOf(intent: StoredRecord): Recovery {
  const recorded = (intent.data as { recovery?: unknown }).recovery;
  return recorded === "repeat" || recorded === "repeat-with-key" ? recorded : "do-not-repeat";
}

/** The last decision recorded for this attempt: a call made again after a cut-off has a later one. */
function latestDecision(ctx: RunContext, key: StepKey, attempt: number): StoredRecord | undefined {
  const first = attemptRecordId(ctx.invocation, key, attempt, "decision");
  let latest = ctx.deps.journal.get(first);
  for (let n = 2; latest !== undefined; n++) {
    const next = ctx.deps.journal.get(recordId(`${first}#${n}`));
    if (next === undefined) break;
    latest = next;
  }
  return latest;
}

/** What a recorded decision says. */
function readDecision(row: StoredRecord): { requested: unknown; final: unknown; denied: boolean; effect?: unknown } {
  const holder = row.data as { requested?: unknown; final?: unknown; denied?: unknown; effect?: unknown };
  return { requested: holder.requested, final: holder.final, denied: holder.denied === true, effect: holder.effect };
}

/** What an invalid input is called, when the caller asked for it or an adjust produced it. */
function invalidMessage(name: ActionName, which: "requested" | "final"): string {
  return which === "requested"
    ? `input of ${name} does not match its schema`
    : `the adjusted input of ${name} does not match its schema`;
}

/** The decision of one call: the intercepts run, and what they decided is here. */
async function decideCall<I, O, In = I>(
  ctx: RunContext,
  caller: Caller,
  action: Action<I, O, In>,
  input: NoInfer<In>,
  key: StepKey,
  attempt: number,
  reason?: string,
  madeAs = false,
): Promise<Decision<I>> {
  // A step made as a principal was held to its grant by whoever made it: a move by an adjust is held to it again.
  const held = madeAs ? ctx.deps.standingOf?.(caller) : undefined;
  return decide({
    intercepts: ctx.deps.interceptsOf(action.name),
    action,
    input,
    caller,
    ...(reason === undefined ? {} : { reason }),
    ...(held === undefined ? {} : { held }),
    // The intercept may need a call to the outside: it makes it as a step of this invocation,
    // under a key of its own.
    step: interceptStep(ctx, key, attempt),
  });
}

/**
 * Write the state of the invocation.
 *
 * A state record is written only when the state differs from the latest one: a run that starts
 * while the latest state is already "running" does not write another "running", so the journal
 * shows the transitions and not the attempts.
 *
 * A paused state carries the choices it offers and the step it paused on, when it paused on one:
 * a paused invocation is a request, and the request says what the owner may answer.
 */
function writeState(
  ctx: RunContext,
  state: InvocationState,
  reason?: string,
  key?: StepKey,
): void {
  // A woken run that is still waiting at its end changed nothing; one that goes on says so first.
  if (ctx.quiet && state !== "waiting") startRunning(ctx);
  const latest = latestState(ctx.deps.journal, ctx.invocation);
  if (latest !== undefined && latest === state) return;
  const choices = state === "paused" ? offeredChoices(ctx.deps.journal, ctx.invocation, { key }) : undefined;
  commit(ctx, newRecordId("st"), CORE_TYPES.invocationState, {
    invocation: ctx.invocation,
    state,
    reason,
    ...(choices === undefined ? {} : { choices }),
    ...(key === undefined ? {} : { key }),
  });
}

/** The first write of a woken run: the invocation is running now, not just looked at. */
function startRunning(ctx: RunContext): void {
  if (!ctx.quiet) return;
  ctx.quiet = false;
  writeState(ctx, "running");
}

/** The latest state of an invocation, if it has one. */
function latestState(journal: Journal, invocation: InvocationId): InvocationState | undefined {
  const rows = journal.find({
    type: CORE_TYPES.invocationState,
    field: "invocation",
    equals: invocation,
  });
  const last = rows.reduce<StoredRecord | undefined>(
    (a, b) => (a === undefined || b.seq > a.seq ? b : a),
    undefined,
  );
  if (last === undefined) return undefined;
  return (last.data as { state: InvocationState }).state;
}

/** A record of this invocation, placed under the record that woke it. */
function recordOf(ctx: RunContext, id: RecordId, type: RecordTypeName, data: unknown): NewRecord {
  return {
    id,
    stream: ctx.stream,
    type,
    schema: 1,
    data,
    actor: ctx.actor,
    cause: ctx.cause,
    root: ctx.root,
  };
}

/** Commit records in one write, and let the host's refusal through as what it is. */
function commitAll(ctx: RunContext, recs: NewRecord[]): StoredRecord[] {
  if (recs.some((rec) => rec.type !== CORE_TYPES.invocationState)) startRunning(ctx);
  try {
    return ctx.deps.append(recs);
  } catch (error) {
    return appendFailed(ctx, error);
  }
}

/** Commit one record, and let the host's refusal through as what it is. */
function commit(ctx: RunContext, id: RecordId, type: RecordTypeName, data: unknown): StoredRecord {
  return first(commitAll(ctx, [recordOf(ctx, id, type, data)]));
}

/** The one record a single-record commit returns. */
function first(written: StoredRecord[]): StoredRecord {
  const [record] = written;
  if (record === undefined) throw new Error("the journal wrote no record");
  return record;
}

/**
 * Is the recorded call a different call than the current one?
 *
 * The action must be the same, and the input must be the same content — the same document, in the
 * same order of keys, whatever order they were written in.
 */
function isMismatch(intent: StoredRecord, action: ActionName, input: unknown): boolean {
  const holder = intent.data as { action?: unknown; input?: unknown };
  if (holder.action !== action) return true;
  return stableJson(holder.input) !== stableJson(input);
}

/** The outcome of a recorded step, as it was written: a value kept as an artifact is read back. */
function readOutcome<O>(ctx: RunContext, data: unknown): Outcome<O> {
  return storedOutcome<O>((data as { outcome: unknown }).outcome, ctx.deps.artifacts);
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a schema check said, in one line per issue. */
function describeIssues(prefix: string, issues: Issues): string {
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
  return `${prefix}: ${lines.join("; ")}`;
}
