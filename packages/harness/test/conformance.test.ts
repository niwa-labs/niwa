// The conformance suite, against a toy in-memory kind.
//
// The suite is about a harness, not about niwa: a third party writes a side for a new harness,
// runs this suite, and it counts as compatible. So the self-test is a toy kind — an in-memory
// harness that declares what it can do — and the suite must pass against it.
//
// What it proves: a side that behaves passes, and a side that breaks a rule fails by that rule.
//
// Only the public API is used: "@niwa-labs/harness".

import { expect, test } from "bun:test";
import { z } from "zod";

import {
  controlConformance,
  insertConformance,
  readingConformance,
} from "@niwa-labs/harness";
import type {
  ConformanceSides,
  Coverage,
  FixtureWriter,
  Harness,
  HarnessInsert,
  InsertEvent,
  Locator,
  PermissionAnswer,
  SessionControl,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
} from "@niwa-labs/harness";

const HARNESS_ID = "toy" as never;
const sid = (native: string): SessionId => ({ harness: HARNESS_ID, native: native as never });

interface ToySession {
  readonly records: SessionRecord[];
  /** The last record is a half-written line. */
  tail: boolean;
  condition: "ok" | "unreadable" | "gone";
}

/** The sessions of every directory the suite made; the toy "files" live here. */
const disk = new Map<string, Map<string, ToySession>>();

const loc = (n: number): Locator => `loc-${n}` as Locator;
const rec = (n: number, body: object): SessionRecord =>
  ({ ...body, locator: loc(n), incomplete: false }) as SessionRecord;

/** The toy reading side. It behaves the way the architecture says. */
class ToyReading implements SessionReading {
  constructor(private readonly sessions: Map<string, ToySession>) {}

  private find(id: SessionId): ToySession | undefined {
    const found = this.sessions.get(String(id.native));
    return found?.condition === "gone" ? undefined : found;
  }

  async *list(): AsyncIterable<SessionInfo> {
    for (const [native, session] of this.sessions) {
      if (session.condition !== "gone") yield { id: sid(native) };
    }
  }

  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    const session = this.find(id);
    if (session === undefined) return;
    const start = from === undefined ? 0 : Number(String(from).replace("loc-", "")) + 1;
    for (const [index, record] of session.records.entries()) {
      if (index < start) continue;
      yield session.tail && index === session.records.length - 1 ? { ...record, incomplete: true } : record;
    }
  }

  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    return { id, locator };
  }

  rawSchema = z.unknown();

  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    const session = this.find(id);
    if (session === undefined) return { status: "unavailable", reason: "the file is gone" };
    if (session.condition === "unreadable") return { status: "failed", reason: "the file cannot be read" };
    const start = from === undefined ? 0 : Number(String(from).replace("loc-", "")) + 1;
    return session.records.length > start ? { status: "not-scanned" } : { status: "empty" };
  }
}

/** The toy installation: it can list and read. */
const toyInstance: Harness = {
  id: HARNESS_ID,
  kind: "toy-kind" as never,
  machine: "machine-1" as never,
  home: "/tmp/toy",
  sides: { reading: { list: true, read: true, watch: false } },
};

/** The fixtures of the toy: it writes its own sessions. */
const toyWriter: FixtureWriter = async (dir, scenario) => {
  const sessions = new Map<string, ToySession>();
  disk.set(dir, sessions);
  const native = `${scenario}-1`;
  const records: SessionRecord[] = [rec(0, { kind: "user", text: "hello" }), rec(1, { kind: "assistant", text: "hi" })];
  const session: ToySession = { records, tail: false, condition: "ok" };
  sessions.set(native, session);
  const base = {
    session: sid(native),
    makeUnreadable: async () => void (session.condition = "unreadable"),
    remove: async () => void (session.condition = "gone"),
  };
  switch (scenario) {
    case "running":
      records.push(rec(2, { kind: "assistant", text: "still typing" }));
      session.tail = true;
      return { ...base, finish: async () => void (session.tail = false) };
    case "nested":
      records.push(rec(2, { kind: "nested", child: sid("child-1") }));
      return { ...base, child: sid("child-1") };
    case "compaction":
      records.push(rec(2, { kind: "compaction", summary: "the summary" }));
      return { ...base, summary: "the summary" };
    case "broken":
      records.push(rec(2, { kind: "unknown", raw: { something: "the harness's own shape" } }));
      return base;
  }
};

const open = (dir: string): ConformanceSides & { reading: ToyReading } => ({ instance: toyInstance, reading: new ToyReading(disk.get(dir) ?? new Map()) });

const run = (opener: (dir: string) => ConformanceSides) => readingConformance("toy", opener, toyWriter)();

/** What a run says failed, by name. */
const failures = (report: { results: readonly { name: string; passed: boolean; detail?: string }[] }) =>
  report.results.filter((result) => !result.passed).map((result) => `${result.name}: ${result.detail ?? ""}`);

/** A side that is the toy except for what `change` overrides. */
const altered = (change: (toy: ToyReading) => Partial<SessionReading>) => (dir: string): ConformanceSides => {
  const toy = open(dir).reading;
  return {
    instance: toyInstance,
    reading: {
      list: toy.list.bind(toy),
      read: toy.read.bind(toy),
      raw: toy.raw.bind(toy),
      rawSchema: toy.rawSchema,
      coverage: toy.coverage.bind(toy),
      ...change(toy),
    },
  };
};

test("the reading suite passes against a well-behaved side", async () => {
  const report = await run(open);
  expect(failures(report)).toEqual([]);
  expect(report.passed).toBe(true);
  expect(report.results.length).toBeGreaterThan(40);
});

test("the reading suite fails a side that does not mark the half-written line", async () => {
  const report = await run(
    altered((toy) => ({
      async *read(id: SessionId, from?: Locator) {
        for await (const record of toy.read(id, from)) yield { ...record, incomplete: false };
      },
    })),
  );
  expect(failures(report).some((name) => name.includes("marked incomplete"))).toBe(true);
});

test("the reading suite fails a side that loses the raw data of an unknown record", async () => {
  const report = await run(
    altered((toy) => ({
      async *read(id: SessionId, from?: Locator) {
        for await (const record of toy.read(id, from)) {
          yield record.kind === "unknown" ? ({ ...record, raw: undefined } as SessionRecord) : record;
        }
      },
    })),
  );
  expect(failures(report).some((name) => name.includes("raw data"))).toBe(true);
});

test("the reading suite fails a side that reads again from the start when given a locator", async () => {
  const report = await run(
    altered((toy) => ({
      read: (id: SessionId) => toy.read(id),
    })),
  );
  expect(failures(report).some((name) => name.includes("from a locator"))).toBe(true);
});

test("the reading suite fails a side that says empty for what it did not scan", async () => {
  const report = await run(altered(() => ({ coverage: async () => ({ status: "empty" }) })));
  expect(failures(report).some((name) => name.includes("never read"))).toBe(true);
  expect(failures(report).some((name) => name.includes("failed"))).toBe(true);
});

test("the reading suite fails a side that implements watch without declaring it", async () => {
  const report = await run(altered(() => ({ watch: async function* () {} })));
  expect(failures(report).some((name) => name.includes("watch is declared exactly"))).toBe(true);
});

test("the reading suite fails a side that declares nothing", async () => {
  const report = await readingConformance(
    "toy",
    (dir) => ({ instance: { ...toyInstance, sides: {} }, reading: open(dir).reading }),
    toyWriter,
  )();
  expect(failures(report).some((name) => name.includes("declares it can list and read"))).toBe(true);
});

test("the control conformance suite passes against a toy side", async () => {
  const control: SessionControl = {
    async start() {
      return { session: { harness: HARNESS_ID, native: "toy-1" as never }, first: { status: "started", turn: 1 } };
    },
    async resume() {},
    async send() {
      return { status: "queued" };
    },
    async interrupt() {},
    async ask<T>() {
      return { session: sid("toy-1"), value: "ok" as T, at: 0 as never };
    },
    async *life() {
      yield { kind: "turn-started", turn: 1 };
      yield { kind: "turn-ended", turn: 1 };
    },
    async state() {
      return "idle";
    },
  };
  const withControl: Harness = {
    ...toyInstance,
    sides: {
      control: {
        start: true,
        resume: true,
        send: true,
        interrupt: true,
        ask: true,
        structuredOutput: true, launch: { model: false, effort: [], modes: [] },
      },
    },
  };
  const report = await controlConformance("toy", { instance: withControl, control })();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.passed).toBe(true);
});

test("the insert conformance suite passes against a toy side", async () => {
  const events: InsertEvent[] = [
    {
      kind: "nested-spawned",
      parent: { harness: "toy" as never, native: "parent-1" as never },
      child: { harness: "toy" as never, native: "child-1" as never },
    },
    { kind: "compacted", session: { harness: "toy" as never, native: "toy-1" as never }, summary: "a summary" },
    { kind: "opened-by-hand", session: { harness: "toy" as never, native: "toy-2" as never } },
    {
      kind: "permission-asked",
      session: { harness: "toy" as never, native: "toy-1" as never },
      requestId: "req-1",
      tool: "write",
    },
  ];
  const answers: PermissionAnswer[] = [];
  const insert: HarnessInsert = {
    async *events() {
      for (const event of events) yield event;
    },
    async answerPermission(answer) {
      answers.push(answer);
    },
  };
  const instance: Harness = {
    ...toyInstance,
    sides: { insert: { nested: true, compaction: true, manualOpen: true, permission: true } },
  };
  const report = await insertConformance("toy", { instance, insert })();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.passed).toBe(true);
});

test("the control suite fails a side whose start gives no receipt for its prompt", async () => {
  const control: SessionControl = {
    async start() {
      return { session: sid("toy-1") };
    },
    async resume() {},
    async send() {
      return { status: "started" };
    },
    async interrupt() {},
    async ask<T>() {
      return { session: sid("toy-1"), value: "ok" as T, at: 0 as never };
    },
    async *life() {
      yield { kind: "turn-started", turn: 1 };
      yield { kind: "turn-ended", turn: 1 };
    },
    async state() {
      return "idle";
    },
  };
  const instance: Harness = {
    ...toyInstance,
    sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } } },
  };
  const report = await controlConformance("toy", { instance, control })();
  expect(failures(report).some((name) => name.includes("the first message has a receipt"))).toBe(true);
});

test("the control suite fails a side that refuses a question to a busy session instead of queueing it", async () => {
  let busy = false;
  const control: SessionControl = {
    async start() {
      return { session: sid("toy-1"), first: { status: "started", turn: 1 } };
    },
    async resume() {},
    async send() {
      busy = true;
      setTimeout(() => {
        busy = false;
      }, 50);
      return { status: "started", turn: 1 };
    },
    async interrupt() {},
    async ask<T>() {
      if (busy) throw new Error("the session is busy");
      return { session: sid("toy-1"), value: "ok" as T, at: 0 as never };
    },
    async *life() {
      yield { kind: "turn-started", turn: 1 };
      yield { kind: "turn-ended", turn: 1 };
    },
    async state() {
      return "idle";
    },
  };
  const instance: Harness = {
    ...toyInstance,
    sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } } },
  };
  const report = await controlConformance("toy", { instance, control })();
  expect(failures(report).some((name) => name.includes("a question to a busy session is answered"))).toBe(true);
});

test("the control suite fails a side that never reports the end of a turn", async () => {
  const control: SessionControl = {
    async start() {
      return { session: sid("toy-1"), first: { status: "started", turn: 1 } };
    },
    async resume() {},
    async send() {
      return { status: "started" };
    },
    async interrupt() {},
    async ask<T>() {
      return { session: sid("toy-1"), value: "ok" as T, at: 0 as never };
    },
    async *life() {
      yield { kind: "turn-started", turn: 1 };
    },
    async state() {
      return "unknown";
    },
  };
  const instance: Harness = {
    ...toyInstance,
    sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } } },
  };
  const report = await controlConformance("toy", { instance, control })();
  // The turn never ends: every wait for it fails with a message that says so, and the sign of
  // life that the turn ended never comes.
  const failed = failures(report);
  expect(failed).toContain("life: the turn ended is reported: ");
  expect(failed.some((name) => name.includes("the session ended before a turn did"))).toBe(true);
  expect(report.passed).toBe(false);
});

test("the insert suite fails a side that declares an event it never reports", async () => {
  const insert: HarnessInsert = {
    async *events() {
      yield { kind: "opened-by-hand", session: sid("toy-2") };
    },
  };
  const instance: Harness = {
    ...toyInstance,
    sides: { insert: { nested: false, compaction: true, manualOpen: true, permission: false } },
  };
  const report = await insertConformance("toy", { instance, insert })();
  expect(failures(report).map((f) => f.split(" is reported")[0])).toEqual(["events: compacted"]);
});
