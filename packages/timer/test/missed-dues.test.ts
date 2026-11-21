// A timer fires. With the host down at the due time, what happens after start is exactly what
// the timer's declared rule says, once.
//
// Each scenario runs against real host processes (fixtures/missed-dues-host.ts):
//
//   1. the first host runs a timer of 500 ms; it fires, and the handler of the trigger is woken
//   2. the host is killed (SIGKILL): a real crash, so nothing fires while it is down
//   3. the host stays down for more than two periods, so several dues pass
//   4. the second host starts on the same home and the rule of the timer decides:
//      - "once": the dues that passed are one firing, written after the restart
//      - "skip": the dues that passed are no firing at all
//      and in both cases the timer goes on with its period.
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { issueId, recordId, seq } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { EVERY_MS, TIMER_ID } from "./fixtures/missed-dues-host.ts";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/missed-dues-host.ts", import.meta.url));

/** How long the host stays down: long enough for more than two dues to pass. */
const DOWN_MS = EVERY_MS * 2.5;

/** How long the test waits for the journal to hold what the rule of the timer decides. */
const SETTLE_MS = 30_000;

interface Firing {
  readonly id: string;
  readonly timer: string;
  readonly due: number;
  readonly at: number;
}

/** The firings in the journal of a home, read through the public API. */
async function readFirings(home: string): Promise<Firing[]> {
  const client = await connectAsOwner(home);
  try {
    const records = await client.records.read();
    return records
      .filter((record) => record.type === "timer.fired")
      .map((record) => {
        const data = record.data as { timer: string; due: number; at: number };
        return { id: record.id, timer: data.timer, due: data.due, at: data.at };
      });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Run the crash scenario with one rule; return what the journal holds after the restart. */
async function crashAndRestart(rule: "once" | "skip"): Promise<{ firings: Firing[]; restartedAt: number; woken: number }> {
  const home = await tempHome();
  const hosts: Array<ReturnType<typeof spawnHost>> = [];
  const args = [TIMER_ID, String(EVERY_MS), rule];
  // What the rule of the timer decides about the dues that passed while the host was down.
  const expected = rule === "once" ? 1 : 0;
  try {
    const first = spawnHost(HOST_SCRIPT, home.path, args);
    hosts.push(first);
    await first.ready();
    await eventually(() => counter(home.path, `fired:${TIMER_ID}`).count() >= 2, 10_000, "the timer should fire");

    await first.kill();
    await Bun.sleep(DOWN_MS);

    const restartedAt = Date.now();
    const second = spawnHost(HOST_SCRIPT, home.path, args);
    hosts.push(second);
    await second.ready();
    // Two periods after the restart: enough for the settled dues and for one on the old period.
    await eventually(
      async () => (await readFirings(home.path)).filter((f) => f.due > restartedAt).length >= 2,
      SETTLE_MS,
      "the timer should go on with its period after the restart",
    );
    // The journal is read when it holds what the rule of the timer decides, not after a fixed
    // wait: a host under load writes its records later than a moment allows for.
    await eventually(
      async () => settledDues(await readFirings(home.path), restartedAt).length === expected,
      SETTLE_MS,
      `the journal should hold ${String(expected)} firing(s) for the dues missed while the host was down`,
    );
    const firings = await readFirings(home.path);
    // The handler is woken once per firing of its own timer.
    await eventually(
      () => counter(home.path, `fired:${TIMER_ID}`).count() >= firings.length,
      SETTLE_MS,
      "the handler of the trigger should be woken by every firing",
    );
    return { firings, restartedAt, woken: counter(home.path, `fired:${TIMER_ID}`).count() };
  } finally {
    for (const host of hosts) await host.kill().catch(() => {});
    await home.cleanup();
  }
}

/** The firings written after the restart for dues that passed while the host was down. */
function settledDues(firings: Firing[], restartedAt: number): Firing[] {
  return firings.filter((f) => f.at >= restartedAt && f.due <= restartedAt);
}

test("timer, rule once: the dues missed while the host was down are one firing", async () => {
  const { firings, restartedAt, woken } = await crashAndRestart("once");
  const settled = settledDues(firings, restartedAt);
  // More than two dues passed during the downtime, and exactly one firing stands for them.
  expect(settled).toHaveLength(1);
  expect(settled[0]?.timer).toBe(TIMER_ID);
  // A due is written once: every firing has its own id, the hash of the timer and the due.
  expect(new Set(firings.map((f) => f.id)).size).toBe(firings.length);
  for (const f of firings) expect(f.id).toBe(issueId("firing", recordId(`timer:${TIMER_ID}:${f.due}`), []));
  // The timer went on: its next firings are on the period counted from the settled one.
  expect(firings.filter((f) => f.due > restartedAt).length).toBeGreaterThanOrEqual(2);
  expect(woken).toBeGreaterThanOrEqual(firings.length);
}, 120_000);

test("timer, rule skip: the dues missed while the host was down are no firing", async () => {
  const { firings, restartedAt } = await crashAndRestart("skip");
  expect(settledDues(firings, restartedAt)).toHaveLength(0);
  expect(new Set(firings.map((f) => f.id)).size).toBe(firings.length);
  // The timer went on with its period.
  expect(firings.filter((f) => f.due > restartedAt).length).toBeGreaterThanOrEqual(2);
}, 120_000);
