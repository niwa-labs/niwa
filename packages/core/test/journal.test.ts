// The journal and the causal queries, against the real SQLite file.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  causes,
  trace,
  IntegrityError,
  LostOwnership,
  WriterBusy,
  RECORD_DATA_LIMIT,
  RecordTooLarge,
  recordId,
  recordTypeName,
  resolveQuery,
  seq,
  streamId,
} from "../src/index.ts";
import { openJournal } from "../src/journal.ts";
import type { Journal, NewRecord, RecordId } from "../src/index.ts";

const homes: string[] = [];

/** A fresh, empty home for a journal; removed after the file. */
async function tempHome(): Promise<{ path: string }> {
  const path = await mkdtemp(join(tmpdir(), "niwa-journal-test-"));
  homes.push(path);
  return { path };
}

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

function rec(id: string, cause: string | null = null, data: unknown = {}): NewRecord {
  return {
    id: recordId(id),
    stream: streamId("s"),
    type: recordTypeName("t"),
    schema: 1,
    data,
    actor: { kind: "host" },
    cause: cause === null ? null : recordId(cause),
    root: recordId("a"),
  };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

test("a second journal of a living holder is refused, even inside the same process", async () => {
  const home = await tempHome();
  const first = openJournal(home.path);
  expect(() => openJournal(home.path)).toThrow(WriterBusy);
  first.close();
  openJournal(home.path).close();
});

test("a dead holder is taken over and the previous holder learns it lost ownership", async () => {
  const home = await tempHome();
  const first = openJournal(home.path);
  first.append(rec("a"));

  const db = new Database(join(home.path, "journal.db"));
  db.run("UPDATE writer SET pid = ?", [await deadPid()]);
  db.close();

  const second = openJournal(home.path);
  expect(() => first.append(rec("b"))).toThrow(LostOwnership);
  first.close(); // must not give away the new holder's ownership
  expect(() => openJournal(home.path)).toThrow(WriterBusy);
  expect(second.append(rec("b")).seq).toBe(seq(2));
  second.close();
});

test("a repeated write returns the committed record as get() returns it; other content is refused", async () => {
  const home = await tempHome();
  const journal = openJournal(home.path);
  const a = rec("a", null, { x: 1, gone: undefined, when: new Date(0) });
  const first = journal.append(a);
  expect(first).toEqual(journal.get(a.id)!);
  expect(journal.append(a)).toEqual(first);
  expect(() => journal.append(rec("a", null, { x: 2 }))).toThrow(IntegrityError);
  expect(journal.last()).toBe(seq(1));
  journal.close();
});

test("the links of a record are part of its content", async () => {
  const home = await tempHome();
  const journal = openJournal(home.path);
  journal.appendAll([{ record: rec("a") }, { record: rec("b", "a"), links: [recordId("a")] }]);
  expect(journal.appendAll([{ record: rec("b", "a"), links: [recordId("a"), recordId("a")] }])).toHaveLength(1);
  expect(() => journal.appendAll([{ record: rec("b", "a") }])).toThrow(IntegrityError);
  expect(journal.linksOf(recordId("b"))).toEqual([recordId("a")]);
  journal.close();
});

test("trace is depth-first and gives each record its shortest depth", async () => {
  const home = await tempHome();
  const journal: Journal = openJournal(home.path);
  // a -> b -> x -> c by causes; a -> y -> c; the walk reaches c through b first.
  journal.appendAll([
    { record: rec("a") },
    { record: rec("b", "a") },
    { record: rec("x", "b") },
    { record: rec("c", "x"), links: [recordId("y")] },
    { record: rec("y", "a") },
  ]);
  const walked = trace(journal, recordId("a")).map((r): [string, number] => [r.id, r.depth]);
  expect(walked).toEqual([["a", 0], ["b", 1], ["x", 2], ["c", 2], ["y", 1]]);
  expect(causes(journal, recordId("c")).map((r: { id: RecordId }) => r.id)).toEqual([recordId("x"), recordId("b"), recordId("a"), recordId("y")]);
  journal.close();
});

test("a journal of the previous schema gets the stream index and reads by stream", async () => {
  const home = await tempHome();
  const first = openJournal(home.path);
  first.append(rec("a"));
  first.close();

  const old = new Database(join(home.path, "journal.db"));
  old.run("DROP INDEX records_stream");
  old.run("PRAGMA user_version = 2");
  old.close();

  const journal = openJournal(home.path);
  const other = { ...rec("b"), stream: streamId("other") };
  journal.append(other);
  expect(journal.since(seq(0), undefined, undefined, streamId("other")).map((r) => r.id)).toEqual([other.id]);
  journal.close();

  const check = new Database(join(home.path, "journal.db"));
  const names = check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all();
  check.close();
  expect(names.map((n) => n.name)).toContain("records_stream");
});

test("a record whose data is larger than a record may be is refused, and nothing of its batch is written", async () => {
  const home = await tempHome();
  const journal = openJournal(home.path);
  const big = "x".repeat(RECORD_DATA_LIMIT);
  expect(() => journal.appendMany([rec("a"), rec("b", null, { big })])).toThrow(RecordTooLarge);
  expect(journal.get(recordId("a"))).toBeUndefined();
  // Just under the limit is a record like any other.
  expect(journal.append(rec("c", null, { big: big.slice(0, RECORD_DATA_LIMIT - 20) })).seq).toBe(seq(1));
  journal.close();
});

test("the tail of a query is the last of what the query answers, whatever narrows it", async () => {
  const home = await tempHome();
  const journal = openJournal(home.path);
  // More records than one chunk of a filtered read, so the walk back crosses chunks.
  const many: NewRecord[] = [];
  for (let n = 0; n < 2600; n += 1) {
    many.push({
      ...rec(`r${String(n)}`, null, { n: n % 7 }),
      type: recordTypeName(n % 3 === 0 ? "t.a" : "t.b"),
      stream: streamId(n % 5 === 0 ? "s1" : "s2"),
    });
  }
  journal.appendMany(many);

  const queries = [
    {},
    { from: seq(2400) },
    { from: seq(2590) },
    { types: ["t.a"] },
    { types: ["t.*"], stream: "s1" },
    { filter: { n: 3 } },
    { filter: { n: 3 }, types: ["t.b"], from: seq(100) },
    { filter: { n: 99 } },
    { stream: "s2", filter: { n: 0 } },
  ];
  for (const query of queries) {
    const resolved = resolveQuery(query as never);
    const all = journal.query(resolved);
    for (const count of [1, 5, 1000, 5000]) {
      expect(journal.tail(resolved, count).map((record) => record.seq), `${JSON.stringify(query)} last ${String(count)}`).toEqual(
        all.slice(-count).map((record) => record.seq),
      );
    }
  }
  journal.close();
});
