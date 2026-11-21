// The ids of a firing and the structured view of the timers: `timer.list` and `timer.get`.
//
// A firing is an id of the common format (`fire-<hash>`), the hash of the timer and the due, so a
// firing written twice is one record. The timers are shown as data: name, description, schedule,
// next due and the id of the last firing.

import { expect, test } from "bun:test";

import { IdIndex, actionName, issueId, recordId, seq, timestamp } from "@niwa-labs/core";
import type { IssuedId } from "@niwa-labs/core";
import { createNiwa, tempHome, testClock } from "@niwa-labs/testing";

import { firingId, timer, timerId, timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const LIST = actionName("timer.list");
const GET = actionName("timer.get");

/** What a firing of `name` due at `due` is born from. */
const seedOf = (name: string, due: number) => recordId(`timer:${name}:${due}`);

test("a firing has the common id, the hash of its timer and its due, and timer.list and timer.get show the timer as data", async () => {
  const home = await tempHome();
  const start = new Date(2024, 0, 1, 0, 0, 0, 0).getTime();
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(
      timers([
        timer.daily("03:17", { id: "morning", description: "the morning round" }),
        timer.every(10 * DAY_MS),
        { id: "once-later", at: start + 100 * DAY_MS, missed: "skip" },
      ]),
    );
    await niwa.serve();
    await clock.advance(3 * DAY_MS);

    const firings = (await niwa.records.read()).filter((row) => row.type === "timer.fired");
    expect(firings).toHaveLength(3);
    for (const row of firings) {
      const data = row.data as { timer: string; due: number };
      expect(String(row.id)).toMatch(/^fire-[0-9a-f]{6,8}$/);
      expect(String(row.id)).toBe(issueId("firing", seedOf(data.timer, data.due), []));
    }
    expect(new Set(firings.map((row) => row.id)).size).toBe(3);

    const { sleeps, timers: listed } = (await niwa.call(LIST, {})) as { sleeps: string[]; timers: TimerEntity[] };
    expect(sleeps).toEqual([]);
    expect(listed.map((one) => String(one.name))).toEqual(["morning", "every:864000000", "once-later"]);

    const morning = listed[0];
    const lastMorning = firings.filter((row) => (row.data as { timer: string }).timer === "morning").at(-1)?.id;
    expect(morning).toMatchObject({
      name: "morning",
      description: "the morning round",
      schedule: { kind: "daily", time: "03:17" },
      missed: "once",
      nextDue: new Date(2024, 0, 4, 3, 17, 0, 0).getTime(),
      lastFiring: lastMorning,
    });
    // A timer without a description is described by its schedule; one that has not fired has no last firing.
    expect(listed[1]).toMatchObject({ description: "every 864000000ms", schedule: { kind: "every", ms: 10 * DAY_MS }, lastFiring: null });
    expect(listed[2]).toMatchObject({ schedule: { kind: "at", at: start + 100 * DAY_MS }, missed: "skip", nextDue: start + 100 * DAY_MS, lastFiring: null });

    expect(await niwa.call(GET, { name: "morning" })).toEqual(morning);
    await expect(niwa.call(GET, { name: "nobody" })).rejects.toThrow('no timer "nobody"');
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a timer that is done has no next due, and the id of its last firing stays", async () => {
  const home = await tempHome();
  const start = 1_700_000_000_000;
  const clock = testClock(start);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([{ id: "once", at: start + 1000 }]));
    await niwa.serve();
    await clock.advance(2000);
    const got = (await niwa.call(GET, { name: "once" })) as TimerEntity;
    expect(got.nextDue).toBeNull();
    expect(got.lastFiring).toBe(issueId("firing", seedOf("once", start + 1000), []));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("the id of a firing is the same each time it is asked for, and a clash lengthens the hash of the later one", () => {
  const issued: IssuedId[] = [];
  const index = new IdIndex("firing", () => issued);
  const first = firingId(index, timerId("a"), timestamp(1000));
  issued.push({ id: first, seed: seedOf("a", 1000) });
  expect(firingId(index, timerId("a"), timestamp(1000))).toBe(first);
  expect(firingId(index, timerId("a"), timestamp(2000))).not.toBe(first);
  expect(firingId(index, timerId("b"), timestamp(1000))).not.toBe(first);

  // Another seed holds the six-digit id this one would take: it gets the longer cut.
  const held: IssuedId[] = [{ id: first, seed: seedOf("other", 1) }];
  const crowded = firingId(new IdIndex("firing", () => held), timerId("a"), timestamp(1000));
  expect(crowded).toMatch(/^fire-[0-9a-f]{7}$/);
  expect(crowded.startsWith(first)).toBe(true);
});

test("a description that is not a few words on one line is refused when the timers are made", () => {
  expect(() => timers([{ id: "x", every: 1000, description: "no" }])).toThrow('timer "x" has a bad description');
  expect(() => timers([{ id: "x", every: 1000, description: "a\nb two lines" }])).toThrow("bad description");
  expect(() => timer.daily("09:00", { description: "x".repeat(61) })).not.toThrow();
  expect(() => timers([timer.daily("09:00", { description: "x".repeat(61) })])).toThrow("bad description");
});
