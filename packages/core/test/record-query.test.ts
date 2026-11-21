// One query for every reader of the journal: exact names and families, equality on paths of the
// data, a stream and an exclusive position, read the same way by the journal and by the matcher.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordQuerySchema,
  isTypeSelector,
  matchesQuery,
  overlaps,
  queryOf,
  record,
  recordId,
  recordTypeName,
  resolveQuery,
  seq,
  streamId,
} from "../src/index.ts";
import { openJournal } from "../src/journal.ts";
import { z } from "zod";
import type { Journal, NewRecord, PathFilter, ResolvedQuery } from "../src/index.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

/** A journal with a few records of three types on two streams. */
async function filled(): Promise<Journal> {
  const path = await mkdtemp(join(tmpdir(), "niwa-query-test-"));
  homes.push(path);
  const journal = openJournal(path);
  const rec = (n: number, type: string, data: unknown, stream = "a"): NewRecord => ({
    id: recordId(`r${n}`),
    stream: streamId(stream),
    type: recordTypeName(type),
    schema: 1,
    data,
    actor: { kind: "host" },
    cause: null,
    root: recordId(`r${n}`),
  });
  journal.appendMany([
    rec(1, "task.done", { task: "t1", outcome: { status: "result" } }),
    rec(2, "task.done", { task: "t2", outcome: { status: "failed" } }, "b"),
    rec(3, "wf.ping", { n: 1 }),
    rec(4, "wf.pong", { n: 2 }, "b"),
    rec(5, "workflow.run.started", { n: 1 }),
    rec(6, "task.done", { task: "t3", outcome: { status: "result" }, "outcome.status": "dotted" }),
  ]);
  return journal;
}

const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

/** What the journal and the matcher answer for one query, which must be the same. */
function both(journal: Journal, query: ResolvedQuery): { journal: string[]; matcher: string[] } {
  return {
    journal: ids(journal.query(query)),
    matcher: ids(journal.since(seq(0)).filter((record) => matchesQuery(query, record))),
  };
}

test("a type is an exact name or a family; every other pattern is refused", () => {
  expect(["task.done", "wf.*", "a.b.*"].every(isTypeSelector)).toBe(true);
  expect(["", "*", ".*", "wf*", "!wf.*", "w*.x", "wf.*.x"].some(isTypeSelector)).toBe(false);
  expect(RecordQuerySchema.safeParse({ types: ["!task.*"] }).success).toBe(false);
  expect(RecordQuerySchema.safeParse({ types: ["wf.*"], filter: { "a.b": 1 }, stream: "s", from: 3 }).success).toBe(true);
  expect(() => resolveQuery({ types: ["task.*.x"] })).toThrow(TypeError);
});

test("an exact name does not select a family's members, and a family selects every type under it", async () => {
  const journal = await filled();
  expect(both(journal, { types: [recordTypeName("wf")] })).toEqual({ journal: [], matcher: [] });
  expect(both(journal, { types: [recordTypeName("wf.*")] })).toEqual({ journal: ["r3", "r4"], matcher: ["r3", "r4"] });
  // `wf.*` is the prefix `wf.`: `workflow.run.started` is not under it.
  expect(both(journal, { types: [recordTypeName("wf.*"), recordTypeName("task.done")] }).journal).toEqual(["r1", "r2", "r3", "r4", "r6"]);
  journal.close();
});

test("the filter is equality on dotted paths, a field named with a dot winning over the path", async () => {
  const journal = await filled();
  const result = both(journal, { types: [recordTypeName("task.done")], filter: { "outcome.status": "result" } });
  expect(result.journal).toEqual(["r1"]);
  expect(result.matcher).toEqual(["r1"]);
  expect(both(journal, { filter: { "outcome.status": "dotted" } }).journal).toEqual(["r6"]);
  expect(both(journal, { filter: { outcome: { status: "failed" } } }).journal).toEqual(["r2"]);
  journal.close();
});

test("the position is exclusive and the stream narrows", async () => {
  const journal = await filled();
  expect(both(journal, { from: seq(2) }).journal).toEqual(["r3", "r4", "r5", "r6"]);
  expect(both(journal, { from: seq(2), stream: streamId("b") }).journal).toEqual(["r4"]);
  expect(ids(journal.query({ types: [recordTypeName("task.done")], filter: { "outcome.status": "result" } }, 1))).toEqual(["r1"]);
  journal.close();
});

test("a filtered query with a limit reads past the rows the filter drops", async () => {
  const path = await mkdtemp(join(tmpdir(), "niwa-query-test-"));
  homes.push(path);
  const journal = openJournal(path);
  const rows: NewRecord[] = [];
  for (let n = 1; n <= 2500; n++) {
    rows.push({
      id: recordId(`r${n}`),
      stream: streamId("s"),
      type: recordTypeName("tick"),
      schema: 1,
      data: { even: n % 2 === 0, n },
      actor: { kind: "host" },
      cause: null,
      root: recordId(`r${n}`),
    });
  }
  journal.appendMany(rows);
  const found = journal.query({ types: [recordTypeName("tick")], filter: { n: 2400 } }, 1);
  expect(ids(found)).toEqual(["r2400"]);
  expect(journal.query({ filter: { even: true } }).length).toBe(1250);
  journal.close();
});

test("two selectors overlap when one type falls under both", () => {
  expect(overlaps("wf.*", "wf.ping")).toBe(true);
  expect(overlaps("wf.ping", "wf.*")).toBe(true);
  expect(overlaps("wf.*", "wf.a.*")).toBe(true);
  expect(overlaps("wf.*", "workflow.*")).toBe(false);
  expect(overlaps("task.done", "task.created")).toBe(false);
});

test("a typed filter takes the paths of the data with the values they have", () => {
  type Done = { task: string; outcome: { status: "result" | "failed" } };
  const good: PathFilter<Done> = { "outcome.status": "result" };
  // @ts-expect-error a value the data never has at that path
  const wrongValue: PathFilter<Done> = { "outcome.status": "maybe" };
  // @ts-expect-error a path the data does not have
  const wrongPath: PathFilter<Done> = { "outcome.code": 1 };
  expect([good, wrongValue, wrongPath].length).toBe(3);
});

test("a query of one declared type keeps the type and its filter, and resolves as any query does", () => {
  const Done = record("task.done", z.object({ task: z.string(), outcome: z.object({ status: z.string() }) }));
  const query = queryOf(Done, { task: "task-1", "outcome.status": "result" });
  expect(query.types).toEqual([Done]);
  expect(query.filter).toEqual({ task: "task-1", "outcome.status": "result" });
  expect(resolveQuery(query)).toEqual({ types: ["task.done"], filter: { task: "task-1", "outcome.status": "result" } });
  expect(queryOf(Done)).toEqual({ types: [Done] });
});
