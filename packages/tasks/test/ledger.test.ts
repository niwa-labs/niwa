// The ledger of tasks: what the journal says of a task is read from its own records.
//
// Updates change neither the creation nor the end of a task, so a reader of one task, and the
// state of every task, never reads them: a series of reports costs nothing to the reads after it.

import { expect, test } from "bun:test";

import { recordId, seq } from "@niwa-labs/core";
import type { Address, Caller, JournalQuery, JournalReader, RecordTypeName, StoredRecord } from "@niwa-labs/core";

import { TaskCreated, TaskDone, TaskUpdated, taskLedger } from "../src/index.ts";
import type { TaskContract } from "../src/index.ts";

const ASKER: Address = { kind: "owner" };
const WORKER: Address = { kind: "agent", id: "worker" };

const CONTRACT: TaskContract = {
  id: "task-aaaaaa" as TaskContract["id"],
  kind: "change",
  description: "Move argument parsing" as TaskContract["description"],
  text: "Move it.",
  askedBy: ASKER,
  responsible: WORKER,
  reportTo: ASKER,
};

/** A journal reader over a list of records that counts the records it hands out. */
function counting(records: StoredRecord[]): { reader: JournalReader; handedOut: () => number } {
  let out = 0;
  const give = (rows: StoredRecord[]) => {
    out += rows.length;
    return rows;
  };
  const at = (query: JournalQuery) => (row: StoredRecord) => {
    if (row.type !== query.type) return false;
    if (query.field === undefined) return true;
    return (row.data as Record<string, unknown>)[query.field] === query.equals;
  };
  const reader: JournalReader = {
    get: (id) => records.find((row) => row.id === id),
    since: (from, types) => give(records.filter((row) => row.seq > from && (types === undefined || types.includes(row.type)))),
    find: (query) => give(records.filter(at(query))),
    query: () => [],
    last: () => seq(records.length),
  };
  return { reader, handedOut: () => out };
}

function stored(position: number, type: RecordTypeName, data: unknown): StoredRecord {
  return {
    id: recordId(`r-${String(position)}`),
    seq: seq(position),
    stream: "s" as never,
    type,
    schema: 1,
    data,
    actor: { kind: "host" } as Caller,
    cause: null,
    root: recordId(`r-${String(position)}`),
    at: 0 as never,
  };
}

test("the state of one task, and of every task, is read without the updates", () => {
  const records: StoredRecord[] = [stored(1, TaskCreated.name, CONTRACT)];
  for (let index = 0; index < 300; index += 1) {
    records.push(stored(2 + index, TaskUpdated.name, { task: CONTRACT.id, text: `step ${String(index)}` }));
  }
  records.push(stored(400, TaskDone.name, { task: CONTRACT.id, outcome: { status: "result", result: 1 } }));

  const one = counting(records);
  const state = taskLedger(() => one.reader).state(CONTRACT.id);
  expect(state?.status).toBe("done");
  // Its creation and its end, whatever the journal holds besides.
  expect(one.handedOut()).toBe(2);

  const all = counting(records);
  expect(taskLedger(() => all.reader).states().get(CONTRACT.id)?.status).toBe("done");
  expect(all.handedOut()).toBe(2);

  // A task that was never created is not found, and nothing else is read for it.
  const none = counting(records);
  expect(taskLedger(() => none.reader).state("task-bbbbbb")).toBeUndefined();
  expect(none.handedOut()).toBe(0);
});

