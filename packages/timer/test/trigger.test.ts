// A handler of a timer's trigger is all it takes: the trigger carries the schedule and names the
// plugin that fires it, so subscribing offers the timer, and a host without the timers says so.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { MissingReader } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";

import { timer, timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";

const MINUTE_MS = 60 * 1000;

test("subscribing to a scheduled trigger schedules the timer, and its handler is woken by its firings only", async () => {
  const home = await tempHome();
  const clock = testClock(new Date(2024, 0, 1, 0, 0, 0, 0).getTime());
  const niwa = createNiwa({ home: home.path, clock });
  const fired: string[] = [];
  try {
    niwa.use(
      timers([timer.every(7 * MINUTE_MS, { id: "other" })]),
      plugin("digest", (api) => {
        api.on(timer.every(5 * MINUTE_MS, { id: "digest" }), (data) => void fired.push(data.timer));
      }),
    );
    await niwa.serve();
    const listed = (await niwa.call(actionName("timer.list"), {})) as { timers: TimerEntity[] };
    expect(listed.timers.map((one) => one.name).sort()).toEqual(["digest", "other"]);
    await clock.advance(15 * MINUTE_MS);
    await eventually(() => fired.length >= 3);
    const firings = (await niwa.records.read(seq(0))).filter((row) => row.type === "timer.fired");
    expect(firings.some((row) => (row.data as { timer: string }).timer === "other")).toBe(true);
    expect(new Set(fired)).toEqual(new Set(["digest"]));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a host with a handler of a timer's trigger and no timers refuses to serve and names them", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(plugin("digest", (api) => api.on(timer.daily("21:00"), () => undefined)));
    const refused = await niwa.serve().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(MissingReader);
    expect(String(refused)).toContain("timers");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
