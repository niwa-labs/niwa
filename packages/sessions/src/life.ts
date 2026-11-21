/**
 * Signs of life: what is known about a session right now.
 *
 * A session is `running`, `idle`, `ended` or `unknown`. After a host restart a turn that was
 * open before the restart proves nothing about now, so the state is `unknown` until a record
 * written by the current process says otherwise. A session is ended while the last word about
 * it is an ended record: a session that was resumed after its control side stopped speaks again.
 */

import type { StoredRecord, Timestamp } from "@niwa-labs/core";

import {
  SessionActivity,
  SessionAdvisor,
  SessionEnded,
  SessionStarted,
  SessionTurnEnded,
  SessionTurnStarted,
  SessionUnknownVariant,
} from "./records.ts";

/** What is known about a session right now. */
export type LifeState = "running" | "idle" | "ended" | "unknown";

/** The record types that say something about life, as opposed to belonging. */
export const LIFE_TYPES = [
  SessionStarted.name,
  SessionTurnStarted.name,
  SessionTurnEnded.name,
  SessionActivity.name,
  SessionAdvisor.name,
  SessionUnknownVariant.name,
  SessionEnded.name,
];

/**
 * The state of one session from its life records, in journal order.
 *
 * - `ended` when the newest record is an ended one;
 * - no records: `unknown`;
 * - the last turn-started has no later turn-ended: the turn is open, and it is `running` only
 *   when the newest record was written at or after `bootedAt`, the moment this process began;
 *   otherwise nothing says what became of the turn, and the state is `unknown`;
 * - otherwise `idle`.
 */
export function lifeOf(records: readonly StoredRecord[], bootedAt: Timestamp): LifeState {
  const last = records[records.length - 1];
  if (last === undefined) return "unknown";
  if (last.type === SessionEnded.name) return "ended";

  let opened = -1;
  let closed = -1;
  for (const record of records) {
    if (record.type === SessionTurnStarted.name) opened = record.seq;
    if (record.type === SessionTurnEnded.name) closed = record.seq;
  }
  if (opened <= closed) return "idle";
  return last.at >= bootedAt ? "running" : "unknown";
}
