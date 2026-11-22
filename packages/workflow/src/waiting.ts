/**
 * What a run that is going waits for, read from its journal: the
 * oldest open attempt of its latest start, in a few words.
 */

import { WAIT_ACTION } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import { SessionStarted, SessionTurnStarted } from "@niwa-labs/sessions/records";
import { SleepRequested, clockOf } from "@niwa-labs/timer/records";

import { readAttempts } from "./attempts.ts";
import { WAIT_NAME } from "./bridge.ts";
import { RunRequested, RunStarted } from "./records.ts";

const START = "session.start";

/** The text after `label:`, or the key as it is. */
const labelOf = (key: string): string => key.replace(/^label:/, "");

/**
 * What the run waits for: `sleep <label> until HH:MM:SS`, `ask <request>`, `session <harness> <session> turn N`, `wait <type>`, or the action it calls. Nothing when it is not waiting for anything.
 */
export function waitingFor(journal: JournalReader, run: string, requests: readonly string[]): string | undefined {
  const asked = requests[0];
  if (asked !== undefined) return `ask ${asked}`;
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run, after: requested?.seq }).at(-1);
  if (requested === undefined || started?.actor.kind !== "handler") return undefined;
  const invocation = String(started.actor.invocation);
  const { attempts } = readAttempts(journal, invocation);
  const active = attempts.find((attempt) => attempt.open);
  if (active === undefined) return undefined;
  const { action, key, operationId, input } = active.data;
  const given = (input ?? {}) as { type?: unknown; types?: unknown; verb?: unknown; name?: unknown; session?: unknown; turn?: unknown };
  if (action === "session.turn-wait" && typeof given.session === "string") {
    const turn = typeof given.turn === "number" ? ` turn ${given.turn}` : "";
    return `session ${given.session}${turn}`;
  }
  if (action === START || action.startsWith(`${START}.`) || action === "session.ask") {
    const operations = new Set([operationId]);
    const owned = new Set([active]);
    for (const attempt of attempts) {
      if (!attempt.superseded && attempt.parent && owned.has(attempt.parent)) {
        owned.add(attempt);
        if (attempt.data.action === START) operations.add(attempt.data.operationId);
      }
    }
    const row = action === "session.ask" && typeof given.session === "string"
      ? journal.find({ type: SessionStarted.name, field: "id", equals: given.session }).at(-1)
      : journal.find({ type: SessionStarted.name }).findLast((row) =>
          row.actor.kind === "handler" && row.actor.invocation === invocation &&
          operations.has(row.id.replace(/\/emit\/\d+$/, "")));
    if (row === undefined) return action === "session.ask" ? "session turn" : `starting session ${action.slice(START.length + 1)}`.trim();
    const started = SessionStarted.schema.parse(row.data);
    const turn = journal.find({ type: SessionTurnStarted.name, field: "session", equals: started.session }).at(-1);
    const harness = started.session.slice(0, started.session.indexOf(" "));
    return `session ${harness} ${started.id}${turn === undefined ? "" : ` turn ${String(SessionTurnStarted.schema.parse(turn.data).turn)}`}`;
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
