/**
 * Shadow run: what a version of a handler would do differently, over records that were already
 * written.
 *
 * - The journal is read as it was at the position: nothing committed after `to` is seen.
 * - Nothing is written to the journal and no action is called. What the handler writes (records,
 *   plugin state) stays in memory and dies with the run.
 * - A recorded step result is reused only when the action and the final input (what the intercepts
 *   made of the requested one) are the same. Any
 *   other call has no recorded answer: it is reported as not evaluated, or as simulated when the
 *   action declares `simulate`. A branch with no answer stops there: what follows depends on it.
 * - The journal holds the results of the old decisions, not of the decisions new code would have
 *   made.
 * - A convention for trusted code, not a sandbox: code that reaches the outside without a step
 *   is not contained.
 */

import { z } from "zod";

import {
  callerOf,
  actionName,
  UnknownAction,
  NOW_ACTION,
  RANDOM_ACTION,
  WAIT_ACTION,
  attemptRecordId,
  JsonValueSchema,
  optionalJsonOf,
  CORE_TYPES,
  recordId,
  seq,
  stableJson,
  heldAction,
  targetName,
} from "@niwa-labs/core";
import { decide } from "@niwa-labs/core/journal";
import type { Intercepts } from "@niwa-labs/core/journal";
import type {
  ActionTarget,
  Action,
  ActionName,
  Handler,
  HandlerId,
  InvocationId,
  Journal,
  Outcome,
  RecordType,
  Step,
  StepEmitOptions,
  StepKey,
  StepOptions,
  StoredRecord,
} from "@niwa-labs/core";
import type { ShadowOptions, ShadowReport, ShadowStep } from "./host-types.ts";

/** The action the host registers for itself: run a plugin in shadow over recorded records. */
export const SHADOW_ACTION: ActionName = actionName("niwa.shadow");

/** One step of a shadow run, as it is reported. */
export const ShadowStepSchema = z.object({
  invocation: z.string(),
  key: z.string(),
  kind: z.enum(["step", "emit"]),
  status: z.enum(["matched", "differed", "simulated", "not-evaluated"]),
  recorded: z.object({ action: z.string(), input: JsonValueSchema.optional(), outcome: JsonValueSchema.optional() }).optional(),
  attempted: z.object({ action: z.string(), input: JsonValueSchema.optional() }).optional(),
  newOutcome: JsonValueSchema.optional(),
});

/** What one shadow run needs: the journal to read, and the handlers of the version to run. */
export interface ShadowDeps {
  journal: Journal;
  /** The intercepts registered on an action: they run on the requested input, as in a real call. */
  interceptsOf(name: ActionName): Intercepts;
  /** The actions of the host, by name: a step that calls another module's action finds it here. */
  resolveAction(name: string): Action<any, any> | undefined;
  handlers: Map<HandlerId, { type: RecordType<any>; handler: Handler<any> }>;
}

/** The data of an admitted record. */
const Admitted = z.object({ invocation: z.string(), handler: z.string(), record: z.string() });

/** What the journal holds for one step: the call, and how it ended when it ended. */
interface RecordedStep {
  action: string;
  input: unknown;
  outcome: Outcome<unknown> | undefined;
}

/** A step as the run builds it: the values are whatever the handler and the journal held, made JSON when it is reported. */
interface DraftStep extends Omit<ShadowStep, "recorded" | "attempted" | "newOutcome"> {
  recorded: { action: string; input: unknown; outcome: unknown } | undefined;
  attempted: { action: string; input: unknown } | undefined;
  newOutcome: unknown;
}

/** A step as it is reported. */
function reported(draft: DraftStep): ShadowStep {
  const { recorded, attempted, newOutcome, ...rest } = draft;
  return {
    ...rest,
    recorded: recorded === undefined ? undefined : { ...recorded, input: optionalJsonOf(recorded.input), outcome: optionalJsonOf(recorded.outcome) },
    attempted: attempted === undefined ? undefined : { ...attempted, input: optionalJsonOf(attempted.input) },
    newOutcome: optionalJsonOf(newOutcome),
  };
}

/** Thrown into the handler when its branch cannot go on: the value it needs is not known. */
class BranchEnded extends Error {}

/** Run the handlers of a version over the records of the journal, and report what they would do. */
export async function shadowRun(deps: ShadowDeps, opts: ShadowOptions = {}): Promise<ShadowReport> {
  const from = opts.from ?? seq(0);
  const to = opts.to;
  const seen = (record: StoredRecord | undefined): StoredRecord | undefined =>
    record !== undefined && (to === undefined || record.seq <= to) ? record : undefined;

  const report: ShadowReport = { matched: [], differed: [], notEvaluated: [] };
  for (const admitted of deps.journal.find({ type: CORE_TYPES.invocationAdmitted })) {
    const data = Admitted.safeParse(admitted.data);
    if (!data.success) continue;
    const handler = data.data.handler as HandlerId;
    const entry = deps.handlers.get(handler);
    const woken = seen(deps.journal.get(recordId(data.data.record)));
    if (entry === undefined || woken === undefined || woken.seq <= from) continue;

    const steps = await runInvocation(deps, seen, entry, {
      handler,
      invocation: data.data.invocation as InvocationId,
      woken,
    });
    for (const step of steps) {
      if (step.status === "matched") report.matched.push(step);
      else if (step.status === "differed") report.differed.push(step);
      else report.notEvaluated.push(step);
    }
  }
  return report;
}

/** One handler over one waking record, with a step function that answers from the journal. */
async function runInvocation(
  deps: ShadowDeps,
  seen: (record: StoredRecord | undefined) => StoredRecord | undefined,
  entry: { type: RecordType<any>; handler: Handler<any> },
  at: { handler: HandlerId; invocation: InvocationId; woken: StoredRecord },
): Promise<ShadowStep[]> {
  const { handler, invocation, woken } = at;
  const { journal } = deps;
  const steps: DraftStep[] = [];
  let ordinal = 0;
  let emitOrdinal = 0;

  /** The last attempt the journal holds for the key, as of the position. */
  const recordedAt = (key: StepKey): RecordedStep | undefined => {
    let found: RecordedStep | undefined;
    for (let attempt = 0; ; attempt += 1) {
      const intent = seen(journal.get(attemptRecordId(invocation, key, attempt, "intent")));
      if (intent === undefined) return found;
      const outcome = seen(journal.get(attemptRecordId(invocation, key, attempt, "outcome")));
      const call = intent.data as { action: string; input: unknown };
      found = {
        action: call.action,
        input: call.input,
        outcome:
          outcome === undefined ? undefined : (outcome.data as { outcome: Outcome<unknown> }).outcome,
      };
    }
  };

  /** Reuse the recorded answer when action and final input are the recorded ones; else simulate; else stop. */
  const call = async (
    key: StepKey,
    action: ActionName,
    input: unknown,
    simulate: (() => Promise<Outcome<unknown> | undefined>) | undefined,
    denial?: Outcome<unknown>,
  ): Promise<Outcome<unknown>> => {
    const known = recordedAt(key);
    const base = {
      invocation,
      key,
      kind: "step" as const,
      recorded: known,
      attempted: { action, input },
    };
    if (
      known?.outcome !== undefined &&
      known.action === action &&
      stableJson(known.input) === stableJson(input)
    ) {
      steps.push({ ...base, status: "matched", newOutcome: known.outcome });
      // The calls the action made inside itself are steps of their own, and they are part of
      // what the recorded run did: they are reported under the keys they were recorded under.
      // A nested call that was cut off has no answer, so the branch stops there.
      const nested = nestedStepsOf(key);
      steps.push(...nested);
      if (nested.some((step) => step.status === "not-evaluated")) throw new BranchEnded();
      return known.outcome;
    }
    // A guard that refuses needs nothing from the outside: its refusal is the new answer.
    if (denial !== undefined) {
      steps.push({ ...base, status: "differed", newOutcome: denial });
      return denial;
    }
    const simulated = await simulate?.();
    if (simulated !== undefined) {
      steps.push({ ...base, status: "simulated", newOutcome: simulated });
      return simulated;
    }
    steps.push({ ...base, status: "not-evaluated", newOutcome: undefined });
    throw new BranchEnded();
  };

  const nextKey = (opts?: StepOptions): StepKey => {
    if (opts?.key !== undefined) return opts.key as StepKey;
    ordinal += 1;
    return String(ordinal) as StepKey;
  };

  /**
   * The key of a call made inside an action: it belongs to the step that made it, the same way
   * it does in a real run ("2.step-1"), so the shadow and the runner agree on what is what.
   */
  const nestedKey = (owner: StepKey, ordinal: number): StepKey =>
    `${owner}.step-${String(ordinal)}` as StepKey;

  /**
   * The nested steps the journal holds under a step: the calls an action made inside itself.
   *
   * A shadow run never runs an action body, so the calls of an action are only what the
   * journal holds: they are reported under the keys they were recorded under. A nested call
   * that was cut off has no answer, so it is reported as not evaluated — as a top-level step
   * without an answer is.
   */
  const nestedStepsOf = (owner: StepKey): DraftStep[] => {
    const found: DraftStep[] = [];
    for (let ordinal = 1; ; ordinal += 1) {
      const key = nestedKey(owner, ordinal);
      const known = recordedAt(key);
      if (known === undefined) break;
      found.push({
        invocation,
        key,
        kind: "step",
        status: known.outcome === undefined ? "not-evaluated" : "matched",
        recorded: known,
        attempted: { action: known.action, input: known.input },
        newOutcome: known.outcome,
      });
    }
    return found;
  };

  /** A step of the runner itself (a wait, the clock, a random number): its answer is the value. */
  const builtin = async (action: ActionName, input: unknown, opts?: StepOptions): Promise<unknown> => {
    const outcome = await call(nextKey(opts), action, input, undefined);
    if (outcome.status !== "completed") throw new BranchEnded();
    return outcome.value;
  };

  const outcomeOf = async <I, O, In = I>(
    action: Action<I, O, In>,
    input: NoInfer<In>,
    opts?: StepOptions,
  ): Promise<Outcome<O>> => {
    const key = nextKey(opts);
    // The final input is what the intercepts made of the requested one, as the runner records it.
    const decided = await decide({
      intercepts: deps.interceptsOf(action.name),
      action,
      input,
      caller: opts?.as === undefined ? { kind: "handler", handler, invocation } : callerOf(opts.as),
    });
    if (decided.kind === "invalid") {
      steps.push({
        invocation,
        key,
        kind: "step",
        status: "not-evaluated",
        recorded: recordedAt(key),
        attempted: { action: action.name, input: decided.final },
        newOutcome: undefined,
      });
      throw new BranchEnded();
    }
    const simulator = action.simulate;
    const simulate =
      simulator === undefined
        ? undefined
        : async (): Promise<Outcome<unknown> | undefined> => {
            try {
              const answer = action.output.safeParse(await simulator(decided.final));
              return answer.success ? { status: "completed", value: answer.data } : undefined;
            } catch {
              return undefined;
            }
          };
    const denial: Outcome<unknown> | undefined =
      decided.kind === "denied" ? { status: "denied", reason: decided.reason } : undefined;
    return (await call(key, action.name, decided.final, simulate, denial)) as Outcome<O>;
  };

  const step: Step = Object.assign(
    async <I, O, In = I>(
      target: ActionTarget<I, O, In>,
      input: NoInfer<In>,
      opts?: StepOptions,
    ): Promise<O> => {
      const action = heldAction(target) ?? deps.resolveAction(targetName(target));
      if (action === undefined) {
        // A name nobody serves: the branch ends where the call would have been made.
        const key = nextKey(opts);
        steps.push({
          invocation,
          key,
          kind: "step",
          status: "not-evaluated",
          recorded: recordedAt(key),
          attempted: { action: targetName(target), input },
          newOutcome: undefined,
        });
        throw new BranchEnded();
      }
      const outcome = await outcomeOf(action, input, opts);
      if (outcome.status !== "completed") throw new BranchEnded();
      return outcome.value;
    },
    {
      outcome: async <I, O, In = I>(
        target: ActionTarget<I, O, In>,
        input: NoInfer<In>,
        opts?: StepOptions,
      ): Promise<Outcome<O>> => {
        const action = heldAction(target) ?? deps.resolveAction(targetName(target));
        if (action === undefined) {
          nextKey(opts);
          return {
            status: "failed",
            error: new UnknownAction(targetName(target)).message,
            effectPossible: false,
          };
        }
        return outcomeOf(action, input, opts);
      },
      wait: async <T>(type: RecordType<T>, _match: (data: T) => boolean, opts?: StepOptions) =>
        (await builtin(WAIT_ACTION, { type: type.name }, opts)) as T,
      // A shadow writes and pauses nothing: there is no work to give up.
      abandon: () => undefined,
      now: async (opts?: StepOptions) => (await builtin(NOW_ACTION, undefined, opts)) as number,
      random: async (opts?: StepOptions) => (await builtin(RANDOM_ACTION, undefined, opts)) as number,
      emit: async <T>(type: RecordType<T>, data: T, opts?: StepEmitOptions): Promise<StoredRecord> => {
        const key = opts?.key ?? String((emitOrdinal += 1));
        const final = type.schema.parse(data);
        const id = recordId(`${invocation}/emit/${key}`);
        const previous = seen(journal.get(id));
        const same =
          previous !== undefined &&
          previous.type === type.name &&
          stableJson(previous.data) === stableJson(final);
        steps.push({
          invocation,
          key,
          kind: "emit",
          status: same ? "matched" : "differed",
          recorded:
            previous === undefined
              ? undefined
              : { action: `emit:${previous.type}`, input: previous.data, outcome: previous.data },
          attempted: { action: `emit:${type.name}`, input: final },
          newOutcome: final,
        });
        // Nothing is written: the handler gets back the record it would have written.
        return {
          id,
          seq: seq(0),
          stream: woken.stream,
          type: type.name,
          schema: type.version,
          data: final,
          actor: { kind: "handler", handler, invocation },
          cause: woken.id,
          root: woken.root,
          at: woken.at,
        };
      },
    },
  );

  try {
    await entry.handler(entry.type.schema.parse(woken.data), step, woken);
  } catch (error) {
    // A branch that ended for want of an answer is already in the report. A handler that failed
    // on its own would have failed in a real run too: that is reported, not hidden.
    if (!(error instanceof BranchEnded)) {
      steps.push({
        invocation,
        key: "handler",
        kind: "step",
        status: "not-evaluated",
        recorded: undefined,
        attempted: undefined,
        newOutcome: { status: "failed", error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return steps.map(reported);
}
