// A sleep is over when its wake is written, and a stored request that cannot be a sleep does not
// stop the others: a wake that failed is tried again, a place is slept at once, and a key that is
// empty or has whitespace is refused.

import { expect, test } from "bun:test";

import { actionName, record } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import { z } from "zod";

import { sleep, timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";
import { failing } from "./fixtures/failing-writes.ts";

type Host = ReturnType<typeof createNiwa>;

const START = 1_700_000_000_000;
const LIST = actionName("timer.list");

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const listed = async (niwa: Host): Promise<TimerEntity[]> => ((await niwa.call(LIST, {})) as { timers: TimerEntity[] }).timers;

const Start = record("test.schedule.start", z.object({}));
const Woke = record("test.schedule.woke", z.object({ note: z.string() }));

test("a wake that could not be written is tried again, and the handler wakes", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  const failures = { "timer.slept": 1 };
  try {
    niwa.use(failing(timers([]), failures));
    niwa.use(
      plugin("sleeper", (api) => {
        api.declare(Start, Woke);
        api.on(Start, async (_data, step) => {
          await sleep(step, 200);
          await step.emit(Woke, { note: "woke" });
        });
      }),
    );
    await niwa.serve();
    await niwa.emit(Start, {});
    await eventually(async () => ofType(await niwa.records.read(), "timer.sleep.requested").length === 1, 10_000, "no request");
    await clock.advance(200);
    expect(failures["timer.slept"]).toBe(0);
    expect(ofType(await niwa.records.read(), "timer.slept")).toHaveLength(0);
    await clock.advance(1000);
    await eventually(async () => ofType(await niwa.records.read(), Woke.name).length === 1, 10_000, "the handler stayed asleep");
    expect(ofType(await niwa.records.read(), "timer.slept")).toHaveLength(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a second sleep at a key the invocation slept at is refused instead of waiting for ever", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([]));
    niwa.use(
      plugin("sleeper", (api) => {
        api.declare(Start, Woke);
        api.on(Start, async (_data, step) => {
          await sleep(step, 100, "place");
          let note = "second sleep allowed";
          try {
            await sleep(step, 100, "place");
          } catch (error) {
            note = error instanceof Error ? error.message : String(error);
          }
          await step.emit(Woke, { note });
        });
      }),
    );
    await niwa.serve();
    await niwa.emit(Start, {});
    await eventually(async () => ofType(await niwa.records.read(), "timer.sleep.requested").length === 1, 10_000, "no request");
    await clock.advance(100);
    await eventually(async () => ofType(await niwa.records.read(), Woke.name).length === 1, 10_000, "the handler did not go on");
    const [woke] = ofType(await niwa.records.read(), Woke.name);
    expect((woke?.data as { note: string }).note).toContain("slept at already");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a sleep request with an empty key or a key with whitespace is refused", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path, clock: testClock(START) });
  try {
    niwa.use(timers([]));
    await niwa.serve();
    const request = actionName("timer.sleep.request");
    await expect(niwa.call(request, { at: START, key: "" })).rejects.toThrow();
    await expect(niwa.call(request, { at: START, key: "two words" })).rejects.toThrow();
    expect(ofType(await niwa.records.read(), "timer.sleep.requested")).toHaveLength(0);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

/** The sleep request as an older writer could have left it: the key is any string. */
const LooseRequest = record("timer.sleep.requested", z.object({ at: z.number(), key: z.string() }));

test("a stored sleep request with a bad key is skipped, and the timers and the other sleeps go on", async () => {
  const home = await tempHome();
  try {
    const first = createNiwa({ home: home.path, clock: testClock(START) });
    first.use(
      plugin("loose", (api) => {
        api.declare(LooseRequest);
        api.service((ctx) => {
          void (async () => {
            await ctx.emit(LooseRequest, { at: START, key: "" });
            await ctx.emit(LooseRequest, { at: START, key: "two words" });
            await ctx.emit(LooseRequest, { at: START, key: "good-key" });
          })();
          return () => undefined;
        });
      }),
    );
    await first.serve();
    await eventually(async () => ofType(await first.records.read(), "timer.sleep.requested").length === 3, 10_000, "the requests were not written");
    await first.close();

    const clock = testClock(START + 10);
    const second = createNiwa({ home: home.path, clock });
    second.use(timers([{ id: "after", every: 1000 }]));
    await second.serve();
    await eventually(async () => ofType(await second.records.read(), "timer.slept").length === 1, 10_000, "the good sleep was not woken");
    expect((ofType(await second.records.read(), "timer.slept")[0]?.data as { key: string }).key).toBe("good-key");
    // The list reads the same journal and shows the timers.
    expect((await listed(second)).map((one) => one.name)).toEqual(["after"]);
    await clock.advance(1000);
    await eventually(async () => ofType(await second.records.read(), "timer.fired").length >= 1, 10_000, "the timer did not fire");
    await second.close();
  } finally {
    await home.cleanup();
  }
});
