// The sleep of a handler: a durable wait that wakes once, even across a restart.
//
// The clock of the host is the one of the test, so a sleep is watched and not waited for: the
// test moves the time of the host and sees what it does with it.

import { expect, test } from "bun:test";

import { CORE_TYPES, record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import { z } from "zod";

import { SleepRequested, sleep, timers } from "../src/index.ts";

type Host = ReturnType<typeof createNiwa>;

/** The record that starts the sleep of the handler. */
const Start = record("test.sleep.start", z.object({}));

/** The record the handler writes when it wakes. */
const Woke = record("test.sleep.woke", z.object({ at: z.number() }));

/** How long the handler sleeps. */
const SLEEP_MS = 200;

/** The moment the clock of the host starts at. */
const START = 1_700_000_000_000;

/**
 * The handler that sleeps and then writes a record.
 *
 * The sleep is a step of the handler, so the handler waits for it, and the moment it wakes is
 * read through the clock of the host: the record says when the sleep was over.
 */
function sleeper(version?: string): Plugin {
  return plugin(
    "sleeper",
    (api) => {
      api.declare(Start, Woke);
      api.on(Start, { emits: [SleepRequested] }, async (_data, step) => {
        await sleep(step, SLEEP_MS);
        const at = await step.now();
        await step.emit(Woke, { at });
      });
    },
    version === undefined ? undefined : { version },
  );
}

/** The explicit version of the sleeper that the restart tests share, so they are one plugin. */
const SLEEPER_VERSION = "sleeper-1";

/**
 * The handler that sleeps for no time at all.
 *
 * A sleep of no time is over at once, but it is still a sleep: it is asked for, it is waited for,
 * and it ends with a wake.
 */
function immediate(): Plugin {
  return plugin("sleeper", (api) => {
    api.declare(Start, Woke);
    api.on(Start, { emits: [SleepRequested] }, async (_data, step) => {
      await sleep(step, 0);
      const at = await step.now();
      await step.emit(Woke, { at });
    });
  });
}

/** The records of the journal of a host, from the beginning. */
const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read(seq(0));
/** The records of one type. */
const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] =>
  records.filter((row) => row.type === type);

/**
 * The state of the invocation of the sleeper.
 *
 * The invocation is the one of the handler of "test.sleep.start": its id names the handler.
 */
const sleeperState = (records: readonly StoredRecord[]): string | undefined => {
  let state: string | undefined;
  for (const row of records) {
    if (row.type !== CORE_TYPES.invocationState) continue;
    const data = row.data as { invocation?: unknown; state?: unknown };
    if (typeof data.invocation !== "string") continue;
    if (!data.invocation.startsWith("inv:sleeper/")) continue;
    if (typeof data.state === "string") state = data.state;
  }
  return state;
};

/**
 * The sleep is armed: the timers plugin has seen the request and armed the wake for it.
 *
 * The handler of the timers plugin runs as an invocation of its own, so the state of that
 * invocation says whether it has run.
 */
const armed = (records: readonly StoredRecord[]): boolean => {
  for (const row of records) {
    if (row.type !== CORE_TYPES.invocationState) continue;
    const data = row.data as { invocation?: unknown; state?: unknown };
    if (typeof data.invocation !== "string") continue;
    if (!data.invocation.startsWith("inv:timers/timer-sleep:")) continue;
    if (data.state === "done") return true;
  }
  return false;
};

test("a handler that sleeps wakes when the time has come", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([]));
    niwa.use(sleeper());
    await niwa.serve();

    await niwa.emit(Start, {});
    // The sleep is asked for and armed: the handler waits for the wake.
    await eventually(async () => armed(await recordsOf(niwa)), 10_000, "the sleep was not armed");
    expect(sleeperState(await recordsOf(niwa))).toBe("waiting");
    expect(ofType(await recordsOf(niwa), Woke.name)).toHaveLength(0);

    // The time has not come yet: the handler is still asleep.
    await clock.advance(SLEEP_MS - 1);
    expect(ofType(await recordsOf(niwa), Woke.name)).toHaveLength(0);

    await clock.advance(1);
    await eventually(
      async () => ofType(await recordsOf(niwa), Woke.name).length === 1,
      10_000,
      "the handler did not wake",
    );

    // The handler woke at the moment it asked for, and it woke once.
    const woke = ofType(await recordsOf(niwa), Woke.name)[0];
    expect((woke?.data as { at: number }).at).toBeGreaterThanOrEqual(START + SLEEP_MS);
    expect(ofType(await recordsOf(niwa), "timer.slept")).toHaveLength(1);
    expect(sleeperState(await recordsOf(niwa))).toBe("done");
    expect(clock.failures()).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a host that restarts in the middle of a sleep still wakes the handler once", async () => {
  const home = await tempHome();
  const first = createNiwa({ home: home.path, clock: testClock(START) });
  try {
    first.use(timers([]));
    first.use(sleeper());
    await first.serve();

    await first.emit(Start, {});
    await eventually(async () => armed(await recordsOf(first)), 10_000, "the sleep was not armed");
    expect(sleeperState(await recordsOf(first))).toBe("waiting");
    await first.close();

    // The same home, a new host: it reads the journal and finds the handler waiting.
    const clock = testClock(START);
    const second = createNiwa({ home: home.path, clock });
    second.use(timers([]));
    second.use(sleeper());
    await second.serve();

    await eventually(
      async () => sleeperState(await recordsOf(second)) === "waiting",
      10_000,
      "the handler did not keep waiting",
    );
    expect(ofType(await recordsOf(second), Woke.name)).toHaveLength(0);

    await clock.advance(SLEEP_MS);
    await eventually(
      async () => ofType(await recordsOf(second), Woke.name).length === 1,
      10_000,
      "the handler did not wake",
    );

    // The sleep woke the handler once: one wake, one record, one request for the sleep.
    expect(ofType(await recordsOf(second), "timer.slept")).toHaveLength(1);
    expect(ofType(await recordsOf(second), "timer.sleep.requested")).toHaveLength(1);
    expect(ofType(await recordsOf(second), Woke.name)).toHaveLength(1);
    expect(sleeperState(await recordsOf(second))).toBe("done");
    expect(clock.failures()).toEqual([]);
  } finally {
    await home.cleanup();
  }
});

test("a sleep whose moment passed while the host was down wakes at once", async () => {
  const home = await tempHome();
  const first = createNiwa({ home: home.path, clock: testClock(START) });
  try {
    first.use(timers([]));
    first.use(sleeper());
    await first.serve();

    await first.emit(Start, {});
    await eventually(async () => armed(await recordsOf(first)), 10_000, "the sleep was not armed");
    await first.close();

    // The new host comes up when the moment of the sleep has passed: the sleep is over, and the
    // handler that waits for it goes on at once.
    const clock = testClock(START + SLEEP_MS + 1_000);
    const second = createNiwa({ home: home.path, clock });
    second.use(timers([]));
    second.use(sleeper());
    await second.serve();

    await eventually(
      async () => ofType(await recordsOf(second), Woke.name).length === 1,
      10_000,
      "the handler did not wake",
    );
    expect(ofType(await recordsOf(second), "timer.slept")).toHaveLength(1);
    expect(sleeperState(await recordsOf(second))).toBe("done");
  } finally {
    await home.cleanup();
  }
});

test("a sleep of no time at all is over at once, and the handler goes on", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([]));
    niwa.use(immediate());
    await niwa.serve();

    await niwa.emit(Start, {});
    // The sleep ends at once: there is no moment to wait for.
    await eventually(
      async () => ofType(await recordsOf(niwa), Woke.name).length === 1,
      10_000,
      "the handler did not wake",
    );
    expect(ofType(await recordsOf(niwa), "timer.slept")).toHaveLength(1);
    expect(sleeperState(await recordsOf(niwa))).toBe("done");
    expect(clock.failures()).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

/** The handler that sleeps twice, one sleep after the other: the sleeping places differ. */
function twice(): Plugin {
  return plugin("sleeper", (api) => {
    api.declare(Start, Woke);
    api.on(Start, { emits: [SleepRequested] }, async (_data, step) => {
      await sleep(step, SLEEP_MS);
      await step.emit(Woke, { at: await step.now() });
      await sleep(step, SLEEP_MS, "second");
      await step.emit(Woke, { at: await step.now() });
    });
  });
}

test("a handler that sleeps twice wakes after each sleep, once each", async () => {
  const home = await tempHome();
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  try {
    niwa.use(timers([]));
    niwa.use(twice());
    await niwa.serve();

    await niwa.emit(Start, {});
    await eventually(async () => armed(await recordsOf(niwa)), 10_000, "the sleep was not armed");

    await clock.advance(SLEEP_MS);
    await eventually(
      async () => ofType(await recordsOf(niwa), Woke.name).length === 1,
      10_000,
      "the first sleep did not wake the handler",
    );
    // The second sleep is a sleep of its own: the first wake is not its answer.
    expect(sleeperState(await recordsOf(niwa))).toBe("waiting");

    await clock.advance(SLEEP_MS);
    await eventually(
      async () => ofType(await recordsOf(niwa), Woke.name).length === 2,
      10_000,
      "the second sleep did not wake the handler",
    );
    const records = await recordsOf(niwa);
    expect(ofType(records, "timer.sleep.requested")).toHaveLength(2);
    expect(ofType(records, "timer.slept")).toHaveLength(2);
    expect(sleeperState(records)).toBe("done");
    expect(clock.failures()).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a host that restarts after the wake was written, before the handler went on, wakes it once", async () => {
  const home = await tempHome();
  const first = createNiwa({ home: home.path, clock: testClock(START) });
  try {
    first.use(timers([]));
    first.use(sleeper(SLEEPER_VERSION));
    await first.serve();
    await first.emit(Start, {});
    await eventually(async () => armed(await recordsOf(first)), 10_000, "the sleep was not armed");
    await first.close();

    // A host whose handler is stuck writes the wake: nobody goes on with it.
    const clock = testClock(START);
    const middle = createNiwa({ home: home.path, clock });
    middle.use(timers([]));
    middle.use(
      plugin(
        "sleeper",
        (api) => {
          api.declare(Start, Woke);
          api.on(Start, async () => {
            await new Promise<never>(() => {});
          });
        },
        { version: SLEEPER_VERSION },
      ),
    );
    await middle.serve();
    await clock.advance(SLEEP_MS);
    await eventually(
      async () => ofType(await recordsOf(middle), "timer.slept").length === 1,
      10_000,
      "the wake was not written",
    );
    expect(ofType(await recordsOf(middle), Woke.name)).toHaveLength(0);
    await middle.close();

    // The host with the handler finds the wake in the journal: the handler goes on, once, and no
    // second wake or request is written.
    const last = createNiwa({ home: home.path, clock: testClock(START + SLEEP_MS) });
    last.use(timers([]));
    last.use(sleeper(SLEEPER_VERSION));
    await last.serve();
    await eventually(
      async () => ofType(await recordsOf(last), Woke.name).length === 1,
      10_000,
      "the handler did not go on",
    );
    const records = await recordsOf(last);
    expect(ofType(records, "timer.slept")).toHaveLength(1);
    expect(ofType(records, "timer.sleep.requested")).toHaveLength(1);
    expect(sleeperState(records)).toBe("done");
    await last.close();
  } finally {
    await home.cleanup();
  }
});
