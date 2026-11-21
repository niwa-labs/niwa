// The history plugin against a host the test controls: what the host does with the records a watch
// writes (a write that fails, one that is slow) and what the journal says is on.

import { afterEach, expect, test } from "bun:test";

import { recordTypeName, seq } from "@niwa-labs/core";
import type { Action, RecordType, StoredRecord } from "@niwa-labs/core";
import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading, SessionRecord } from "@niwa-labs/harness";
import type { PluginApi } from "@niwa-labs/plugin";

import { history } from "../src/index.ts";
import type { HistoryOptions } from "../src/index.ts";
import { HistorySessionSeen } from "../src/records.ts";

const H = harnessId("h");
const ID = sessionId(H, "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const checklist = (n: number, done: number, total: number): SessionRecord => ({
  kind: "checklist",
  items: Array.from({ length: total }, (_, index) => ({ text: `item ${String(index)}`, state: index < done ? "done" : "pending" })),
  locator: at(n),
  incomplete: false,
});

const instance: Harness = { id: H, kind: "k" as never, machine: "m" as never, home: "/tmp/h", sides: { reading: { list: true, read: true, watch: false } } };

function reading(records: SessionRecord[]): SessionReading {
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

type Run = (input: unknown, ctx: { emit: Emit }) => Promise<unknown>;
type Emit = (type: RecordType<any>, data: unknown) => Promise<StoredRecord>;

/** A host with a journal in memory: the plugin is installed, and its actions are called by name. */
function host(options: HistoryOptions, preset: ReadonlyArray<{ type: RecordType<any>; data: unknown }> = []) {
  const journal: StoredRecord[] = [];
  /** Called with each write before it lands: a throw refuses it, a promise holds it. */
  const gate: { write?: (type: string) => Promise<void> | void } = {};
  const append: Emit = async (type, data) => {
    await gate.write?.(type.name);
    const stored = { id: `r${String(journal.length)}`, seq: seq(journal.length + 1), type: recordTypeName(type.name), data } as unknown as StoredRecord;
    journal.push(stored);
    return stored;
  };
  for (const { type, data } of preset) journal.push({ id: `p${String(journal.length)}`, seq: seq(journal.length + 1), type: recordTypeName(type.name), data } as unknown as StoredRecord);
  const actions = new Map<string, Run>();
  let stopService: (() => void) | undefined;
  const api = {
    declare() {},
    action(declared: Action<any, any, any>) {
      actions.set(declared.name, declared.run as Run);
    },
    subscribers() {},
    service(start: () => () => void) {
      stopService = start();
    },
    journal: () => ({
      since: (from: number, types?: string[]) => journal.filter((stored) => stored.seq > from && (types === undefined || types.includes(stored.type))),
      find: (query: { type: string; field: string; equals: unknown }) =>
        journal.filter((stored) => stored.type === query.type && (stored.data as Record<string, unknown>)[query.field] === query.equals),
      last: () => seq(journal.length),
    }),
    emit: append,
  };
  history(options).setup(api as unknown as PluginApi);
  return {
    journal,
    gate,
    call: (name: string, input: unknown) => actions.get(name)!(input, { emit: append }),
    types: () => journal.map((stored) => stored.type as string).filter((type) => type !== "history.session.seen"),
    stop: () => stopService?.(),
  };
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const stop of open.splice(0)) stop();
});

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5_000 && !condition(); waited += 5) await Bun.sleep(5);
  if (!condition()) throw new Error("it did not come to pass");
}

const timing = { pollMs: 5, pauseMs: 60_000, endMs: 120_000 };

test("a write that fails while the host runs is tried again, and the watch stays on until it is stopped", async () => {
  const h = host({ harnesses: [{ instance, reading: reading([checklist(1, 1, 2)]) }], timing });
  open.push(h.stop);
  let refused = 0;
  h.gate.write = (type) => {
    if (type === "session.progress" && refused++ < 3) throw new Error("the journal is busy");
  };
  await h.call("history.watch", { session: ID });
  await until(() => h.types().includes("session.progress"));
  expect(refused).toBe(4);
  expect(await h.call("history.unwatch", { session: ID })).toEqual({ stopped: true });
  expect(h.types()).toEqual(["session.progress", "history.session.unwatched"]);
});

test("what a watch is writing lands before the end that stops it, not after", async () => {
  const h = host({ harnesses: [{ instance, reading: reading([checklist(1, 1, 2)]) }], timing });
  open.push(h.stop);
  let release: () => void = () => {};
  let held = false;
  h.gate.write = async (type) => {
    if (type !== "session.progress") return;
    held = true;
    await new Promise<void>((resolve) => (release = resolve));
  };
  await h.call("history.watch", { session: ID });
  await until(() => held);
  const ending = h.call("history.signal", { session: ID, signal: "end-hook" });
  await Bun.sleep(30);
  expect(h.types()).toEqual([]);
  release();
  expect(await ending).toEqual({ ended: true });
  expect(h.types()).toEqual(["session.progress", "history.session.ended"]);
});

test("a watch the journal says is on, whose task is gone, is stopped by unwatch", async () => {
  // The installation is not served now, so the watch could not be taken up again at the start.
  const h = host({ harnesses: [] }, [{ type: HistorySessionSeen, data: { session: ID, harness: H } }]);
  open.push(h.stop);
  expect(await h.call("history.unwatch", { session: ID })).toEqual({ stopped: true });
  expect(h.types()).toEqual(["history.session.unwatched"]);
  expect(await h.call("history.unwatch", { session: ID })).toEqual({ stopped: false });
});
