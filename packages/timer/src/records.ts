/**
 * The records of the timer module: a timer fired.
 *
 * A firing is an external input: it starts its own chain, and the root of that chain is the
 * firing itself. What the record carries is enough to say which
 * timer fired, when it was due and when it was written — the due time is the timer's own
 * schedule, and the write time is when the host got to it.
 */

import { actionRef, queryOf, record } from "@niwa-labs/core";
import type { TypeQuery } from "@niwa-labs/core";
import { z } from "zod";

/** The name of a timer: its author gives it, and it becomes part of the seed of its firings. */
export const TimerId = z
  .string()
  .regex(/^\S+$/, "a timer id must be a non-empty string without whitespace")
  .brand<"TimerId">();
export type TimerId = z.infer<typeof TimerId>;

/**
 * The id of a timer. Constructed only here.
 *
 * @throws when the id is empty or has whitespace.
 */
export function timerId(value: string): TimerId {
  const parsed = TimerId.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`a timer id must be a non-empty string without whitespace, got ${JSON.stringify(value)}`);
  }
  return parsed.data;
}

/**
 * A timer fired.
 *
 * `timer` is the id of the timer, `due` the moment it was due (milliseconds since the epoch),
 * and `at` the moment the firing was written.
 */
export const TimerFired = record(
  "timer.fired",
  z.object({
    /** The id of the timer that fired. */
    timer: z.string(),
    /** When the timer was due, in milliseconds since the epoch. */
    due: z.number(),
    /** When the firing was written, in milliseconds since the epoch. */
    at: z.number(),
  }),
);

/** The data of a firing: which timer, when it was due, when it was written. */
export type TimerFiredData = z.infer<typeof TimerFired.schema>;

/** The firings of one timer: the query a trigger, a wait and a read of the history share. */
export function timerFiredQuery(timer: TimerId): TypeQuery<TimerFiredData> {
  return queryOf(TimerFired, { timer });
}

/**
 * The key of one sleep: the invocation and the sleeping place.
 *
 * Branded: a bare string is not accepted where a sleep key is expected.
 */
export type SleepKey = string & { readonly __brand: "SleepKey" };

/**
 * The key of one sleep. Constructed only here.
 *
 * It becomes part of a record id, so it must be a non-empty string without whitespace.
 *
 * @throws when the key cannot be part of a record id.
 */
export function sleepKey(value: string): SleepKey {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new TypeError(`a sleep key must be a non-empty string without whitespace, got ${JSON.stringify(value)}`);
  }
  return value as SleepKey;
}

/**
 * A handler asked to sleep until a moment.
 *
 * The request says when the sleep ends (`at`) and which sleeping place asked for it (`key`).
 * The key is written by the handler that sleeps, so the wake that ends the sleep is addressed
 * to that one place.
 */
export const SleepRequested = record(
  "timer.sleep.requested",
  z.object({
    /** When the sleep ends, in milliseconds since the epoch. */
    at: z.number(),
    /** The key of the sleeping place the wake is addressed to. */
    key: z.string(),
  }),
);

/** The data of a sleep request: when the sleep ends and the key of the sleeping place. */
export type SleepRequestedData = z.infer<typeof SleepRequested.schema>;

/**
 * Ask the timers for the wake of a sleeping place at a moment: the command whose fact is a
 * `timer.sleep.requested` record. A sleep is asked for by calling it as a step, so the request is
 * the timers' own record and a replay does not ask again.
 */
export const timerSleepRequest = actionRef("timer.sleep.request", {
  description: "Ask for the wake of a sleeping place at a moment, in milliseconds since the epoch.",
  input: SleepRequested.schema,
  output: z.object({}),
});

/**
 * A sleep ended.
 *
 * The wake is addressed to one sleeping place, so the record carries the key of that place and
 * nothing else: the moment it was written is the moment the sleep ended.
 */
export const TimerSlept = record(
  "timer.slept",
  z.object({
    /** The key of the sleeping place that is woken. */
    key: z.string(),
  }),
);

/** The data of a sleep that ended: the key of the sleeping place. */
export type TimerSleptData = z.infer<typeof TimerSlept.schema>;

const DAY_MS = 24 * 3_600_000;

/** A moment as a person reads a clock, in local time: the time, and the day when it is more than a day away. */
export function clockOf(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const time = date.toTimeString().slice(0, 8);
  if (at - now < DAY_MS) return time;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${time}`;
}
