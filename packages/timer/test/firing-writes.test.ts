// A timer goes on to its next due only when its firing is in the journal: a write that failed is
// tried again, and a due that is the moment of the start is a due that came.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";

import { timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";
import { failing } from "./fixtures/failing-writes.ts";

type Host = ReturnType<typeof createNiwa>;

const START = 1_700_000_000_000;
const LIST = actionName("timer.list");

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const listed = async (niwa: Host): Promise<TimerEntity[]> => ((await niwa.call(LIST, {})) as { timers: TimerEntity[] }).timers;

test("a firing that could not be written keeps its due, and the timer fires when the write is tried again", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  const failures = { "timer.fired": 1 };
  try {
    niwa.use(failing(timers([{ id: "once", at: START + 1000 }]), failures));
    await niwa.serve();
    await clock.advance(1000);
    expect(failures["timer.fired"]).toBe(0);
    expect(ofType(await niwa.records.read(), "timer.fired")).toHaveLength(0);
    // The timer is not done: it still has the due it could not fire.
    expect((await listed(niwa))[0]).toMatchObject({ nextDue: START + 1000, lastFiring: null });

    await clock.advance(1000);
    await eventually(async () => ofType(await niwa.records.read(), "timer.fired").length === 1, 10_000, "the firing was not retried");
    const [fired] = ofType(await niwa.records.read(), "timer.fired");
    expect((fired?.data as { due: number }).due).toBe(START + 1000);
    await eventually(async () => (await listed(niwa))[0]?.nextDue === null, 10_000, "the timer was not done");
    expect(ofType(await niwa.records.read(), "timer.fired")).toHaveLength(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a timer whose due is the moment the host starts fires under the rule that skips missed dues", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([{ id: "now", at: START, missed: "skip" }]));
    await niwa.serve();
    await eventually(async () => ofType(await niwa.records.read(), "timer.fired").length === 1, 10_000, "the due of the moment was dropped");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
