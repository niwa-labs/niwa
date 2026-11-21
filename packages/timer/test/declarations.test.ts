// What a declaration of a timer must be, and how a moment and the firings of a timer are named:
// whole milliseconds, a daily hour that a clock change moved, a wake date in one time zone, and
// the query of the firings of one timer.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import type { StoredRecord } from "@niwa-labs/core";

import { clockOf, timer, timerFiredQuery, timerId, timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";

type Host = ReturnType<typeof createNiwa>;

const LIST = actionName("timer.list");

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const listed = async (niwa: Host): Promise<TimerEntity[]> => ((await niwa.call(LIST, {})) as { timers: TimerEntity[] }).timers;

test("a period or a moment that is not a whole number of milliseconds is refused when it is declared", () => {
  expect(() => timer.every(0.5)).toThrow("whole number");
  expect(() => timers([{ id: "half", every: 0.5 }])).toThrow("whole number");
  expect(() => timers([{ id: "late", at: 1.5 }])).toThrow("timestamp");
});

test("a daily timer that a clock change moved to a later hour is back at its own hour the next day", async () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/New_York";
  const home = await tempHome();
  // 2026-03-08 is the day the clocks go forward in New York: 02:30 does not exist.
  const start = new Date(2026, 2, 8, 0, 0, 0, 0).getTime();
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([{ id: "half-past-two", daily: "02:30" }]));
    await niwa.serve();
    await clock.advance(5 * 3_600_000);
    await eventually(async () => ofType(await niwa.records.read(), "timer.fired").length === 1, 10_000, "no firing on the day of the change");
    expect((await listed(niwa))[0]?.nextDue).toBe(new Date(2026, 2, 9, 2, 30, 0, 0).getTime());
  } finally {
    await niwa.close();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
    await home.cleanup();
  }
});

test("a moment far away is shown with the day and the time of one zone", () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const evening = new Date(2026, 0, 10, 21, 0, 0, 0).getTime();
    expect(clockOf(evening, new Date(2026, 0, 1).getTime())).toBe("01-10 21:00:00");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("the firings of one timer are a query a trigger and a reader share", () => {
  const query = timerFiredQuery(timerId("digest"));
  expect(query.types.map((type) => type.name)).toEqual(["timer.fired"]);
  expect(query.filter).toEqual({ timer: "digest" });
  expect(timer.fired("digest").filter).toEqual(query.filter);
});
