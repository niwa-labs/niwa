/**
 * Outcomes of a step, and the decisions an owner takes about a paused invocation.
 *
 * A step is a recorded operation boundary: the intent is written, the call is made, the outcome
 * is written. Three things can happen in between, and each one has its own fact in the journal:
 *
 * - the call was cut off (an intent, no outcome): its effect may or may not have happened;
 * - the owner decided about it (retry, skip, cancel);
 * - it was called again as a new attempt.
 *
 * An attempt is one try of one step. The first try is attempt 0; a retry is attempt 1, 2, ... Each
 * attempt has its own operation id and its own intent and outcome records, so the journal says
 * exactly how many times the other side was asked. The step key stays the same, because the code
 * of the handler reaches the same step on a replay; the attempt is what changes.
 *
 * The owner decides through a request: `niwa.invocation.resolve` says which invocation and
 * which choice. The answer is a record, `niwa.invocation.resolved`, and the invocation runs
 * again with that choice in hand.
 *
 * The three choices mean three different things:
 *
 * - **retry**: the step is called again, as a new attempt. The operation id gets the attempt
 *   suffix, so the other side sees a new operation.
 * - **skip**: the step ends without being called, and the code continues. `step()` returns
 *   undefined for that key, so the code knows it was skipped.
 * - **cancel**: the invocation ends as done, with the reason "cancelled".
 */

import { actionName } from "./action.ts";
import { PAUSE_CHOICES } from "./types.ts";
import { CORE_TYPES, recordId } from "./record.ts";
import type {
  ActionName,
  Action,
  Caller,
  CheckResult,
  InvocationId,
  Journal,
  OperationId,
  Outcome,
  PauseChoice,
  RecordId,
  StepKey,
} from "./types.ts";

/** The action the host registers for itself: the way an owner answers a paused invocation. */
export const RESOLVE_ACTION: ActionName = actionName("niwa.invocation.resolve");

/**
 * The action the host registers for itself: move unfinished work onto the version of its plugin
 * that is installed now. Work is never moved by restarting.
 */
export const MOVE_ACTION: ActionName = actionName("niwa.invocation.move");

/** What a resolution says: which invocation, which step, which choice. */
export interface Resolution {
  readonly invocation: InvocationId;
  readonly key: StepKey;
  readonly choice: PauseChoice;
}

/**
 * The operation id of one attempt of one step.
 *
 * The first attempt is the plain `${invocation}/${key}`. A later attempt gets the attempt as a
 * suffix: `${invocation}/${key}#2`. The other side therefore sees a different operation for every
 * try.
 */
export function attemptOperationId(
  invocation: InvocationId,
  key: StepKey,
  attempt: number,
): OperationId {
  const plain = `${invocation}/${key}`;
  return (attempt === 0 ? plain : `${plain}#${attempt + 1}`) as OperationId;
}

/** The id of the intent, the decision or the outcome record of one attempt of one step. */
export function attemptRecordId(
  invocation: InvocationId,
  key: StepKey,
  attempt: number,
  kind: "intent" | "decision" | "outcome",
): RecordId {
  return recordId(
    attempt === 0
      ? `${invocation}/step/${key}/${kind}`
      : `${invocation}/step/${key}/attempt/${attempt + 1}/${kind}`,
  );
}

/**
 * How many attempts of one step the journal holds.
 *
 * An attempt exists when its intent was written, and attempts are written in order, so the count
 * is the first attempt whose intent is missing. The last attempt is the one in flight.
 */
export function attemptsOf(journal: Journal, invocation: InvocationId, key: StepKey): number {
  let count = 0;
  while (journal.get(attemptRecordId(invocation, key, count, "intent")) !== undefined) count += 1;
  return count;
}

/**
 * The choice an owner made for one step of a paused invocation, if it was made.
 *
 * A resolution carries the attempt it answers: the attempt that was cut off, which is the last
 * one. It applies to the run that comes after that attempt, and to no other, so the answer does
 * not repeat itself on every later run. The last resolution for the same step wins.
 */
export function resolutionOf(
  journal: Journal,
  invocation: InvocationId,
  key: StepKey,
  attempts: number,
): Resolution | undefined {
  let found: Resolution | undefined;
  const rows = journal.find({
    type: CORE_TYPES.invocationResolved,
    field: "invocation",
    equals: invocation,
  });
  for (const row of rows) {
    const data = row.data as { key?: unknown; choice?: unknown; attempt?: unknown };
    if (data.key !== key || data.attempt !== attempts - 1) continue;
    const choice = PAUSE_CHOICES.find((candidate) => candidate === data.choice);
    if (choice !== undefined) found = { invocation, key, choice };
  }
  return found;
}

/**
 * The outcome of a cut-off call, asked of the action.
 *
 * The action's check knows whether the effect happened: it turns unknown into completed or
 * failed. Without a check, or when the check fails, the answer is unknown. The recovery contract
 * decides what happens next, not what happened.
 */
export async function checkOutcome<I, O, In = I>(
  action: Action<I, O, In>,
  operationId: OperationId,
  ctx: { caller: Caller },
): Promise<Outcome<O>> {
  if (action.check === undefined) return { status: "unknown" };
  let answered: CheckResult<O>;
  try {
    answered = await action.check(operationId, { operationId, caller: ctx.caller });
  } catch {
    return { status: "unknown" };
  }
  switch (answered.status) {
    case "completed":
      return { status: "completed", value: answered.value };
    case "failed":
      return { status: "failed", error: answered.error, effectPossible: true };
    case "unknown":
      return { status: "unknown" };
  }
}
