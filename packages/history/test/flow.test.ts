import { afterEach, expect, test } from "bun:test";

import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading, SessionRecord } from "@niwa-labs/harness";

import { readTranscript } from "../src/index.ts";
import type { ReadingBinding } from "../src/index.ts";
import { readSession } from "../src/flow.ts";

const H = harnessId("h");
const ID = sessionId(H, "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const base = (n: number) => ({ locator: at(n), incomplete: false });

const instance: Harness = { id: H, kind: "k" as never, machine: "m" as never, home: "/tmp/h", sides: { reading: { list: true, read: true, watch: false } } };

const records: SessionRecord[] = [
  { kind: "user", text: "fix it", ...base(1) },
  { kind: "assistant", text: "one", ...base(2) },
  { kind: "user", text: "and again", ...base(3) },
  { kind: "assistant", text: "two", ...base(4) },
];

function readingOf(all: SessionRecord[], coverage: SessionReading["coverage"] = async () => ({ status: "not-scanned" })): SessionReading {
  return {
    async *list() {
      yield { id: ID };
    },
    async *read(_id, from) {
      const start = from === undefined ? 0 : all.findIndex((record) => record.locator === from) + 1;
      yield* all.slice(start);
    },
    raw: async () => undefined,
    rawSchema: { parse: (value: unknown) => value } as never,
    coverage,
  };
}

const calls: Array<{ name: string; input: unknown; label?: string }> = [];
const scripted = globalThis as { call?: unknown };

/** The `call` a workflow script has, answered by the reading of `binding`. */
function script(binding: ReadingBinding): void {
  scripted.call = async (name: string, input: Record<string, unknown>, opts?: { label?: string }) => {
    calls.push({ name, input, ...(opts?.label === undefined ? {} : { label: opts.label }) });
    return await readTranscript(binding, ID, input);
  };
}

afterEach(() => {
  delete scripted.call;
  calls.length = 0;
});

test("a window of a digest is read as a named step, and the next window goes on from where it ended", async () => {
  script({ instance, reading: readingOf(records) });
  const first = await readSession("read-1", { session: ID, mode: "digest", budget: 20 });
  expect(calls).toMatchObject([{ name: "history.read", label: "read-1", input: { mode: "digest", budget: 20 } }]);
  expect(first.mode).toBe("digest");
  expect(first.entries.length).toBeGreaterThan(0);
  expect(first.entries.length).toBeLessThan(4);
  expect(first.next).not.toBeNull();
  expect(first.restarted).toBe(false);

  const second = await readSession("read-2", { session: ID, mode: "digest", budget: 10_000, from: first.next!, files: first.files });
  expect(second.next).toBeNull();
  expect([...first.entries, ...second.entries].map((entry) => (entry.kind === "user" || entry.kind === "assistant" ? entry.text : entry.kind))).toEqual(["fix it", "one", "and again", "two"]);
});

test("a read that names no mode is a digest, a brief carries its brief, and a full read gives the records", async () => {
  script({ instance, reading: readingOf(records) });
  expect((await readSession("a", { session: ID })).mode).toBe("digest");
  const brief = await readSession("b", { session: ID, mode: "brief" });
  expect(brief.brief?.asked.map((said) => said.text)).toEqual(["fix it", "and again"]);
  expect(brief.entries).toEqual([]);
  const full = await readSession("c", { session: ID, mode: "full" });
  expect(full.records).toHaveLength(4);
  expect(full.upto).toBe(at(4));
});

test("a read that started over says so, and one that could not be made throws instead of being empty", async () => {
  script({ instance, reading: readingOf([{ ...records[0]!, reanchored: true } as SessionRecord, records[1]!]) });
  expect((await readSession("again", { session: ID, mode: "digest" })).restarted).toBe(true);
  expect((await readSession("again-full", { session: ID, mode: "full" })).restarted).toBe(true);

  script({
    instance,
    reading: {
      ...readingOf([]),
      async *read() {
        yield* [];
        throw new Error("the transcript is unreadable");
      },
    },
  });
  await expect(readSession("broken", { session: ID, mode: "digest" })).rejects.toThrow("unreadable");
  script({ instance: { ...instance, sides: {} } as Harness });
  await expect(readSession("missing", { session: ID, mode: "full" })).rejects.toThrow();
});

test("a window of the records before a locator is read whole, and says whether there are earlier ones", async () => {
  script({ instance, reading: readingOf(records) });
  const last = await readSession("tail", { session: ID, window: { limit: 2 } });
  expect(calls).toMatchObject([{ name: "history.read", input: { mode: "full", window: { limit: 2 } } }]);
  expect(last.records.map((record) => record.locator)).toEqual([at(3), at(4)]);
  expect(last.hasEarlier).toBe(true);
  const first = await readSession("head", { session: ID, window: { limit: 2, before: at(3) } });
  expect(first.records.map((record) => record.locator)).toEqual([at(1), at(2)]);
  expect(first.hasEarlier).toBe(false);
  expect((await readSession("forward", { session: ID, mode: "full" })).hasEarlier).toBe(false);
});
