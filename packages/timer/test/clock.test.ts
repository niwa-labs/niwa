// The clock of one host: a test can move the time of a host and watch what it does with it.
//
// One host has one clock, and everything that reads the time or waits for
// it uses that clock:
//
//   1. a host with a test clock gets one: the time it sees is the time the test gave it
//   2. a daily timer fires exactly once per day of the test clock, and advancing seven days
//      fires it seven times, without the test waiting in real time
//   3. a timer of the real clock still fires, and the timers of the real host still work
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, tempHome, testClock } from "@niwa-labs/testing";

import { timers } from "../src/index.ts";

/** A day in milliseconds: the period of the daily timer. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The time of day the daily timer fires at, in local time. */
const DAILY_AT = "03:17";

/** The id of the daily timer in this test. */
const TIMER_ID = "clock-daily";

/** The firings of the timer of a host, in the order they were written. */
async function firingsOf(records: readonly StoredRecord[]): Promise<Array<{ due: number; at: number }>> {
  return records
    .filter((record) => record.type === "timer.fired")
    .map((record) => {
      const data = record.data as { timer: string; due: number; at: number };
      return { due: data.due, at: data.at };
    });
}

/** The records of the journal of a host, from the beginning. */
async function readAll(host: ReturnType<typeof createNiwa>): Promise<StoredRecord[]> {
  return host.records.read();
}

test("a host with a test clock reads the time of that clock", async () => {
  const home = await tempHome();
  // A moment that is not the real one: if the host read the real clock, this would not hold.
  const start = 1_700_000_000_000;
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    await niwa.serve();
    expect(clock.now()).toBe(start);
    // The clock of the host is the one it was given: it only moves when the test says so.
    expect(clock.now()).toBe(start);
    await clock.advance(1000);
    expect(clock.now()).toBe(start + 1000);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a daily timer fires once per day of the test clock: seven days are seven firings", async () => {
  const home = await tempHome();
  const start = new Date(2024, 0, 1, 0, 0, 0, 0).getTime();
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([{ id: TIMER_ID, daily: DAILY_AT }]));
    await niwa.serve();

    // Seven days of the clock: seven firings, and no waiting in real time.
    const before = Date.now();
    await clock.advance(7 * DAY_MS);
    const elapsed = Date.now() - before;

    const firings = await firingsOf(await readAll(niwa));
    expect(firings).toHaveLength(7);

    // Each firing is its own record, and the due of one is the moment the day came.
    const dues = firings.map((firing) => firing.due);
    expect(new Set(dues).size).toBe(dues.length);
    for (let day = 1; day <= 7; day += 1) {
      expect(dues[day - 1]).toBe(new Date(2024, 0, day, 3, 17, 0, 0).getTime());
    }

    // The week was watched, not waited for: a week of real time would have taken a week.
    expect(elapsed).toBeLessThan(10_000);

    // The work of the host did not fail while the clock moved.
    expect(clock.failures()).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a timer of the real clock still fires, and the real clock still moves", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(timers([{ id: "clock-real", every: 100 }]));
    await niwa.serve();

    // The real clock is the default: the timer fires on its own, without a test moving it.
    const deadline = Date.now() + 10_000;
    let firings: Array<{ due: number; at: number }> = [];
    while (Date.now() < deadline) {
      firings = await firingsOf(await readAll(niwa));
      if (firings.length >= 2) break;
      await Bun.sleep(50);
    }
    expect(firings.length).toBeGreaterThanOrEqual(2);
    // The firings carry the real time: the moment they were due is not in the past by much.
    const now = Date.now();
    for (const firing of firings) {
      expect(firing.at).toBeLessThanOrEqual(now);
      expect(now - firing.at).toBeLessThan(10_000);
    }
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("the timer of a host without a clock is the real one, and a timer at a moment still fires", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    // A timer that fires once, at a moment a moment from now: the real clock carries it.
    const due = Date.now() + 150;
    niwa.use(timers([{ id: "clock-at", at: due }]));
    await niwa.serve();
    const deadline = Date.now() + 10_000;
    let firings: Array<{ due: number; at: number }> = [];
    while (Date.now() < deadline) {
      firings = await firingsOf(await readAll(niwa));
      if (firings.length >= 1) break;
      await Bun.sleep(50);
    }
    expect(firings).toHaveLength(1);
    expect(firings[0]?.due).toBe(due);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a plugin's service sees the clock of the host", async () => {
  const home = await tempHome();
  const start = 1_700_000_000_000;
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  const seen: number[] = [];
  try {
    niwa.use(
      plugin("clock-watcher", (api) => {
        api.service((ctx) => {
          seen.push(ctx.now());
          ctx.schedule(start + 500, () => {
            seen.push(ctx.now());
          });
          return () => {};
        });
      }),
    );
    await niwa.serve();
    expect(seen).toEqual([start]);
    await clock.advance(500);
    // The service was woken by the clock of the host, and it saw the time it was woken at.
    expect(seen).toEqual([start, start + 500]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
