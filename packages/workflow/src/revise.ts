/**
 * The revision of a workflow run.
 *
 * A call of the edited script is compared with the calls recorded for the run, by key:
 *
 * - the same key and the same call, finished: **reused**, its recorded answer is the answer;
 * - a key the run never had, or a recorded call that never finished: **rerun**;
 * - the same key with another action or input: **shown**. It is not run: the key says it is the
 *   same call, and running it again would repeat an effect that may already have happened.
 */

import { stableJson } from "@niwa-labs/core";
import type { JsonValue } from "@niwa-labs/core";

/** One call of a run, as the journal holds it. */
export interface RecordedCall {
  key: string;
  action: string;
  input: JsonValue;
  /** Whether the call ended with an answer. */
  finished: boolean;
  /** The answer, when it finished. */
  outcome?: JsonValue;
}

/** One call of the script as it is now. */
export interface CurrentCall {
  key: string;
  action: string;
  input: JsonValue;
}

/** What a revision found. */
export interface RevisionReport {
  reused: Array<{ key: string; action: string; input: JsonValue; outcome: JsonValue }>;
  rerun: Array<{ key: string; action: string; input: JsonValue; reason: "new key" | "unfinished" }>;
  shown: Array<{
    key: string;
    recordedAction: string;
    recordedInput: JsonValue;
    action: string;
    input: JsonValue;
  }>;
}

/** The input of a call without its label: the label is the key, which is compared on its own. */
function withoutLabel(input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const { label: _label, ...rest } = input;
  return rest;
}

/** Whether a recorded call and a current one are the same call. */
export function sameCall(recorded: { action: string; input: JsonValue }, current: { action: string; input: JsonValue }): boolean {
  return (
    recorded.action === current.action &&
    stableJson(withoutLabel(recorded.input)) === stableJson(withoutLabel(current.input))
  );
}

/** Compare the calls of the script as it is now with the calls recorded for the run. */
export function revise(recorded: Map<string, RecordedCall>, current: CurrentCall[]): RevisionReport {
  const report: RevisionReport = { reused: [], rerun: [], shown: [] };
  for (const call of current) {
    const known = recorded.get(call.key);
    if (known === undefined) {
      report.rerun.push({ ...call, reason: "new key" });
    } else if (!sameCall(known, call)) {
      report.shown.push({
        key: call.key,
        recordedAction: known.action,
        recordedInput: known.input,
        action: call.action,
        input: call.input,
      });
    } else if (known.finished) {
      report.reused.push({ ...call, outcome: known.outcome ?? null });
    } else {
      report.rerun.push({ ...call, reason: "unfinished" });
    }
  }
  return report;
}
