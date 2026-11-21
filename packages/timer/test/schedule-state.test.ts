// What the scheduler remembers: the schedule a due belongs to, timers named like the properties
// of an object, and the ids of the firings read from the journal once.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";

import { timers } from "../src/index.ts";
import type { TimerEntity } from "../src/index.ts";

type Host = ReturnType<typeof createNiwa>;

const START = 1_700_000_000_000;
const LIST = actionName("timer.list");

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const listed = async (niwa: Host): Promise<TimerEntity[]> => ((await niwa.call(LIST, {})) as { timers: TimerEntity[] }).timers;

test("a timer declared again under its id with another schedule starts from the new one", async () => {
  const home = await tempHome();
  try {
    // The old one fired and is done; the new one is later, and it is not mistaken for done.
    const first = createNiwa({ home: home.path, clock: testClock(START) });
    first.use(timers([{ id: "job", at: START + 1000 }]));
    await first.serve();
    await (first as Host).close();

    const second = createNiwa({ home: home.path, clock: testClock(START + 5000) });
    second.use(timers([{ id: "job", at: START + 9000 }]));
    await second.serve();
    expect((await listed(second))[0]).toMatchObject({ nextDue: START + 9000 });
    await second.close();

    // The old date is still ahead and the new one is sooner: the new one is what fires.
    const third = createNiwa({ home: home.path, clock: testClock(START + 6000) });
    third.use(timers([{ id: "job", at: START + 7000 }]));
    await third.serve();
    expect((await listed(third))[0]).toMatchObject({ nextDue: START + 7000 });
    await third.close();
  } finally {
    await home.cleanup();
  }
});

test("a timer named like a property of every object is scheduled, fires and is remembered", async () => {
  const home = await tempHome();
  try {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    const defs = names.map((id) => ({ id, every: 1000 }));
    const first = createNiwa({ home: home.path, clock: testClock(START) });
    first.use(timers(defs));
    await first.serve();
    expect((await listed(first)).map((one) => one.name).sort()).toEqual([...names].sort());
    await first.close();

    const clock = testClock(START + 1500);
    const second = createNiwa({ home: home.path, clock });
    second.use(timers(defs));
    await second.serve();
    await eventually(
      async () => new Set(ofType(await second.records.read(), "timer.fired").map((row) => (row.data as { timer: string }).timer)).size === names.length,
      10_000,
      "not every timer fired",
    );
    // What was remembered is read back: the due is the one the firing left.
    for (const one of await listed(second)) expect(one.nextDue).toBeGreaterThan(START + 1500);
    await second.close();
  } finally {
    await home.cleanup();
  }
});

test("the ids of the firings are read from the journal once, not again for each firing", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  let read = 0;
  const counting = (inner: Plugin): Plugin => ({
    ...inner,
    setup(api: PluginApi) {
      inner.setup({
        ...api,
        journal: () => {
          const journal = api.journal?.();
          if (journal === undefined) return undefined;
          return new Proxy(journal, {
            get: (target, name) => {
              if (name !== "since") return Reflect.get(target, name) as unknown;
              return (...args: Parameters<typeof target.since>) => {
                const rows = target.since(...args);
                if (args[1]?.includes("timer.fired") === true) read += rows.length;
                return rows;
              };
            },
          });
        },
      });
    },
  });
  try {
    niwa.use(counting(timers([{ id: "tick", every: 10 }])));
    await niwa.serve();
    for (let step = 0; step < 40; step += 1) await clock.advance(10);
    const fired = ofType(await niwa.records.read(), "timer.fired").length;
    expect(fired).toBeGreaterThanOrEqual(40);
    // One read of each firing for the ids, with some for the list: not a pass over the history for every firing.
    expect(read).toBeLessThan(fired * 4);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
