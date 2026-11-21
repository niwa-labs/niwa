/**
 * What a run that is going waits for, read from its journal: the
 * oldest step of its latest start that has begun and not ended, in a few words.
 */

import { CORE_TYPES, WAIT_ACTION } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import { SessionStarted, SessionTurnStarted } from "@niwa-labs/sessions/records";
import { SleepRequested, clockOf } from "@niwa-labs/timer/records";
import { z } from "zod";

import { WAIT_NAME } from "./bridge.ts";
import { RunRequested, RunStarted } from "./records.ts";

const Intent = z.object({ action: z.string(), key: z.string(), input: z.unknown().optional() });

const AGENT = "session.start";

/** The text after `label:`, or the key as it is. */
const labelOf = (key: string): string => key.replace(/^label:/, "");

/**
 * What the run waits for: `sleep <label> until HH:MM:SS`, `ask <request>`, `agent <harness> session
 * <session> turn N`, `wait <type>`, or the action it calls. Nothing when it is not waiting for anything.
 */
export function waitingFor(journal: JournalReader, run: string, requests: readonly string[]): string | undefined {
  const asked = requests[0];
  if (asked !== undefined) return `ask ${asked}`;
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run, after: requested?.seq }).at(-1);
  if (requested === undefined || started?.actor.kind !== "handler") return undefined;
  const invocation = String(started.actor.invocation);
  const ended = journal.find({ type: CORE_TYPES.stepOutcome, field: "invocation", equals: invocation });
  const intent = journal
    .find({ type: CORE_TYPES.stepIntent, field: "invocation", equals: invocation })
    .find((row) => !ended.some((outcome) => outcome.seq > row.seq && (outcome.data as { key?: unknown }).key === (row.data as { key?: unknown }).key));
  if (intent === undefined) return undefined;
  const { action, key, input } = Intent.parse(intent.data);
  const given = (input ?? {}) as { type?: unknown; types?: unknown; verb?: unknown; name?: unknown };
  if (action === AGENT || action.startsWith(`${AGENT}.`)) {
    const harness = action.slice(AGENT.length + 1);
    const session = journal.find({ type: SessionStarted.name }).filter((row) => row.root === requested.root).at(-1);
    if (session === undefined) return `agent ${harness} starting`;
    const started = SessionStarted.schema.parse(session.data);
    const turn = journal.find({ type: SessionTurnStarted.name, field: "session", equals: started.session }).at(-1);
    return `agent ${harness} session ${started.id}${turn === undefined ? "" : ` turn ${String(SessionTurnStarted.schema.parse(turn.data).turn)}`}`;
  }
  if (action === WAIT_ACTION || action === WAIT_NAME) {
    if (given.type === "timer.slept") {
      const sleeping = journal.find({ type: SleepRequested.name, field: "key", equals: `${invocation}:${key}` }).at(-1);
      const until = sleeping === undefined ? "" : ` until ${clockOf(SleepRequested.schema.parse(sleeping.data).at)}`;
      return `sleep ${labelOf(key)}${until}`;
    }
    return `wait ${typeof given.type === "string" ? given.type : Array.isArray(given.types) ? given.types.join(",") : labelOf(key)}`;
  }
  if (action === "workflow.authorize") return `permission ${String(given.verb)} ${String(given.name)}`;
  return `call ${action}`;
}
