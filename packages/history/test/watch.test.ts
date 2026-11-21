import { expect, test } from "bun:test";

import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionReading, SessionRecord } from "@niwa-labs/harness";

import { watchSession } from "../src/index.ts";
import type { WatchClock, WatchEvent } from "../src/index.ts";

const ID = sessionId(harnessId("h"), "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const said = (n: number): SessionRecord => ({ kind: "assistant", text: `step ${String(n)}`, locator: at(n), incomplete: false });
const checklist = (n: number, done: number, total: number): SessionRecord => ({
  kind: "checklist",
  items: Array.from({ length: total }, (_, index) => ({ text: `item ${String(index)}`, state: index < done ? "done" : "pending" })),
  locator: at(n),
  incomplete: false,
});

/** A reading side over a transcript the test grows. */
function growing(records: SessionRecord[]): SessionReading {
  return {
    async *list() {
      yield { id: ID, cwd: "/work" };
    },
    async *read(_id, from) {
      const start = from === undefined ? 0 : records.findIndex((record) => record.locator === from) + 1;
      yield* records.slice(start);
    },
    raw: async () => undefined,
    rawSchema: { parse: (value: unknown) => value } as never,
    coverage: async () => ({ status: "not-scanned" }),
  };
}

/** A clock that moves only when the watch sleeps, and runs `onSleep` each time. */
function steppedClock(onSleep: (now: number) => void): WatchClock {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep(now);
    },
  };
}

test("a watch says the checklist when it changes, a pause after a quiet while, and a guessed end", async () => {
  const records: SessionRecord[] = [said(1), checklist(2, 0, 2)];
  const clock = steppedClock((now) => {
    if (now === 10) records.push(checklist(3, 0, 2), said(4));
    if (now === 20) records.push(checklist(5, 1, 2));
  });
  const events: WatchEvent[] = [];
  for await (const event of watchSession(growing(records), ID, {
    signal: new AbortController().signal,
    clock,
    timing: { pollMs: 10, pauseMs: 30, endMs: 60 },
  })) {
    events.push(event);
  }
  expect(events).toEqual([
    { kind: "progress", done: 0, total: 2 },
    // The same checklist again says nothing.
    { kind: "progress", done: 1, total: 2 },
    { kind: "paused", upto: at(5), why: "idle" },
    { kind: "ended", certainty: "guessed" },
  ]);
});

test("a watch that goes on from a pause reads only what came after it and keeps quiet about the progress it said", async () => {
  const records: SessionRecord[] = [checklist(1, 1, 2), said(2), checklist(3, 1, 2), checklist(4, 2, 2)];
  const controller = new AbortController();
  const events: WatchEvent[] = [];
  const clock = steppedClock(() => controller.abort());
  for await (const event of watchSession(growing(records), ID, { signal: controller.signal, clock, from: at(2), progress: { done: 1, total: 2 } })) {
    events.push(event);
  }
  expect(events).toEqual([{ kind: "progress", done: 2, total: 2 }]);
});

test("a half-written record is waited for, not read past", async () => {
  const records: SessionRecord[] = [said(1), { ...checklist(2, 1, 1), incomplete: true }];
  const controller = new AbortController();
  const events: WatchEvent[] = [];
  const clock = steppedClock((now) => {
    if (now === 10) records[1] = checklist(2, 1, 1);
    if (now === 20) controller.abort();
  });
  for await (const event of watchSession(growing(records), ID, { signal: controller.signal, clock, timing: { pollMs: 10, pauseMs: 1_000, endMs: 2_000 } })) {
    events.push(event);
  }
  expect(events).toEqual([{ kind: "progress", done: 1, total: 1 }]);
});

