/**
 * Following a session as it grows, in the common model: the tail is read again every so often,
 * and what the watch learns is said as events: how far the agent's checklist is, that the session
 * has paused, that it has ended.
 *
 * Nothing in a transcript says that a session of another harness is over, so the end of one is a
 * guess (`guessed`): no new record for longer than a threshold. A pause is said earlier, so the work
 * on a session can go in parts, at its pauses, instead of once at an end that may never be known.
 */

import { checklistProgress } from "@niwa-labs/harness";
import type { Locator, SessionId, SessionReading } from "@niwa-labs/harness";

/** How often the tail is read, and after how long without a record a session is paused, then ended. */
export interface WatchTiming {
  readonly pollMs: number;
  readonly pauseMs: number;
  readonly endMs: number;
}

export const DEFAULT_WATCH_TIMING: WatchTiming = { pollMs: 2_000, pauseMs: 60_000, endMs: 30 * 60_000 };

/** The time a watch reads and waits by: the host's, or a test's. */
export interface WatchClock {
  now(): number;
  /** Wait `ms`, or less when the signal is aborted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const SYSTEM_CLOCK: WatchClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
};

/** How far a checklist is. */
export interface Progress {
  readonly done: number;
  readonly total: number;
}

/** What a watch learns. */
export type WatchEvent =
  | { readonly kind: "progress"; readonly done: number; readonly total: number }
  | { readonly kind: "paused"; readonly upto: Locator; readonly why: "idle" }
  | { readonly kind: "ended"; readonly certainty: "guessed"; readonly why: "idle" | "process-gone" };

export interface WatchOptions {
  readonly timing?: WatchTiming;
  readonly clock?: WatchClock;
  readonly signal: AbortSignal;
  /** Where an earlier watch of the session got to: the records up to it are not read again. */
  readonly from?: Locator;
  /** The progress an earlier watch said last: the same again is not said. */
  readonly progress?: Progress;
  /**
   * Whether a long quiet is taken for the end. Default: true. A session niwa runs is not over when it
   * is quiet: it waits for its next turn, and niwa knows when it ends.
   */
  readonly guessEnd?: boolean;
  /** Whether the process the session runs in still lives, when it is known: its exit is taken for the end. */
  readonly alive?: () => boolean;
}

/**
 * Watch a session until it ends or the signal is aborted. A half-written record is waited for; a
 * read that fails is tried again, and is not a quiet one: while the tail cannot be read the watch
 * neither pauses nor guesses an end by idleness, and the time it was unavailable does not count as quiet.
 */
export async function* watchSession(reading: SessionReading, id: SessionId, options: WatchOptions): AsyncGenerator<WatchEvent> {
  const timing = options.timing ?? DEFAULT_WATCH_TIMING;
  const clock = options.clock ?? SYSTEM_CLOCK;
  let upto = options.from;
  let progress = options.progress;
  let lastRecordAt = clock.now();
  let paused = false;
  while (!options.signal.aborted) {
    let grew = false;
    let failed = false;
    const said: Progress[] = [];
    try {
      for await (const record of reading.read(id, upto)) {
        if (record.incomplete) break;
        upto = record.locator;
        grew = true;
        if (record.kind !== "checklist") continue;
        const now = checklistProgress(record);
        if (progress === undefined || now.done !== progress.done || now.total !== progress.total) {
          progress = now;
          said.push(now);
        }
      }
    } catch {
      // The file may be moving under the harness: the next read tries again.
      failed = true;
    }
    for (const each of said) yield { kind: "progress", ...each };
    const now = clock.now();
    if (options.alive !== undefined && !grew && !options.alive()) {
      yield { kind: "ended", certainty: "guessed", why: "process-gone" };
      return;
    }
    if (grew) {
      lastRecordAt = now;
      paused = false;
    } else if (failed) {
      // What could not be read is not known to be quiet: the quiet starts over once the tail can be read.
      lastRecordAt = now;
    } else if (options.guessEnd !== false && now - lastRecordAt >= timing.endMs) {
      yield { kind: "ended", certainty: "guessed", why: "idle" };
      return;
    } else if (!paused && upto !== undefined && now - lastRecordAt >= timing.pauseMs) {
      paused = true;
      yield { kind: "paused", upto, why: "idle" };
    }
    await clock.sleep(timing.pollMs, options.signal);
  }
}
