/**
 * What a run of a script takes from the earlier starts of the same run.
 *
 * Steps are taken along the longest unchanged prefix. A call of the script as it is now is answered
 * with what the run recorded under its key while it is the same call — the same action and input;
 * for an agent call the same prompt and harness — and nothing before it in its branch changed.
 * The first call that is new or changed runs, and so does every call after it: later in its branch,
 * or after the scope that holds it closed. A call after a change that has an effect and was made
 * before as the same call is taken all the same: an effect is never made twice.
 *
 * Nothing is taken from another run: the calls compared are the run's own.
 */

import { stableJson } from "@niwa-labs/core";
import type { JsonValue, Recovery } from "@niwa-labs/core";

/** One call of a run, as the journal holds it. */
export interface RecordedCall {
  key: string;
  action: string;
  input: JsonValue;
  /** Whether the call ended with an answer. */
  finished: boolean;
  /** The answer, when it finished. */
  outcome?: JsonValue;
  /** The recovery contract it was made under: anything but `repeat` has an effect. */
  recovery?: Recovery;
  /** The start of the run that made it. */
  invocation: string;
}

/** One call of the script as it is now. */
export interface CurrentCall {
  key: string;
  action: string;
  input: JsonValue;
  /** An agent call: its identity is its prompt and its harness, not the other options of its session. */
  agent?: boolean;
}

/** Why a call runs instead of being taken from an earlier start. */
export type RerunReason = "new" | "changed" | "unfinished" | "after a change" | "recomputed";

/** What becomes of one call. */
export type Taken = { taken: true; outcome: JsonValue } | { taken: false; reason: RerunReason };

/** What a revision found: the calls taken from the earlier starts, and the ones that run. */
export interface RevisionReport {
  reused: Array<{ key: string; action: string; input: JsonValue; outcome: JsonValue }>;
  rerun: Array<{ key: string; action: string; input: JsonValue; reason: RerunReason }>;
}

/** The input of a call without its label: the label is the key, which is compared on its own. */
function withoutLabel(input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const { label: _label, ...rest } = input;
  return rest;
}

/** What makes two calls the same call. An agent call is its prompt and its harness, which its action names. */
function identityOf(call: { action: string; input: JsonValue }, agent: boolean): string {
  if (agent && call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)) {
    return stableJson({ action: call.action, prompt: call.input.prompt ?? null });
  }
  return stableJson({ action: call.action, input: withoutLabel(call.input) });
}

/** Whether a recorded call and a current one are the same call. */
export function sameCall(recorded: { action: string; input: JsonValue }, current: CurrentCall): boolean {
  return identityOf(recorded, current.agent === true) === identityOf(current, current.agent === true);
}

/** Whether a recorded call has an effect: it was made under a contract other than `repeat`. */
export const hasEffect = (call: RecordedCall): boolean => (call.recovery ?? "repeat") !== "repeat";

/**
 * Decide one call: taken from the earlier start that made it, or run.
 *
 * `after` says a call before it in its branch ran, so it lies after a change; `recompute` says the
 * owner asked for it to run again.
 */
export function decide(before: RecordedCall | undefined, current: CurrentCall, opts: { after: boolean; recompute: boolean }): Taken {
  if (opts.recompute) return { taken: false, reason: "recomputed" };
  if (before === undefined) return { taken: false, reason: "new" };
  if (!sameCall(before, current)) return { taken: false, reason: "changed" };
  if (!before.finished) return { taken: false, reason: "unfinished" };
  if (opts.after && !hasEffect(before)) return { taken: false, reason: "after a change" };
  return { taken: true, outcome: before.outcome ?? null };
}
