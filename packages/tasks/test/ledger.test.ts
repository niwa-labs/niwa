// The ledger of tasks: what the journal says of a task is read from its own records.
//
// Updates change neither the creation nor the end of a task, so a reader of one task, and the
// state of every task, never reads them: a series of reports costs nothing to the reads after it.
// A call that was cut off asks the record it wrote first what it did.

import { expect, test } from "bun:test";

import { recordId, seq } from "@niwa-labs/core";
import type { Address, Caller, JournalQuery, JournalReader, OperationId, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, messages, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { TaskCreated, TaskDone, TaskUpdated, taskActions, taskCreate, taskFail, taskFinish, taskIds, taskLedger, taskReport } from "../src/index.ts";
import type { TaskActions, TaskContract, TaskLedger } from "../src/index.ts";

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

/** The actions of the module and its ledger, taken from inside a plugin of a running host. */
async function served(
  run: (taken: { ledger: TaskLedger; acts: TaskActions }, host: Host, home: string) => Promise<void>,
) {
  const home = await tempHome();
  // A client speaks as the worker, which is responsible for the tasks; the host stands for nobody.
  const bind: CallerBinding = (caller) => (caller.kind === "client" ? WORKER : undefined);
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  let taken: { ledger: TaskLedger; acts: TaskActions } | undefined;
  niwa.use(
    plugin("tasks", (api) => {
      const ledger = taskLedger(() => api.journal?.());
      const acts = taskActions(ledger, taskIds(() => api.journal?.()), bind);
      api.declare(TaskCreated, TaskUpdated, TaskDone);
      api.action(acts.create);
      api.action(acts.report);
      api.action(acts.finish);
      api.action(acts.fail);
      taken = { ledger, acts };
    }),
  );
  await niwa.serve();
  try {
    if (taken === undefined) throw new Error("the plugin did not run");
    await run(taken, niwa, home.path);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}

/** The operation id a record was written under: the record is `<operation>/emit/1`. */
const operationOf = (written: StoredRecord | undefined) => (written?.id ?? "").slice(0, -"/emit/1".length) as OperationId;

test("a call that was cut off is answered from the record it wrote: create, report, finish and fail", async () => {
  await served(async ({ ledger, acts }, niwa, home) => {
    const caller: Caller = { kind: "host" };
    const asked = (operation: OperationId) => ({ operationId: operation, caller });
    const input = { kind: "change", description: CONTRACT.description, text: CONTRACT.text, askedBy: ASKER, responsible: WORKER, reportTo: ASKER };
    const worker = await connectAsOwner(home, "worker");
    try {
      const { id } = await niwa.call(taskCreate, input);
      await worker.call(taskReport, { task: id, text: "half way" });
      await worker.call(taskFinish, { task: id, result: "done" });

      // The task has ended, so the same report made again would be refused; the one that was
      // written stands, and the check says so.
      const reported = operationOf((await niwa.records.read({ types: [TaskUpdated.name] }))[0]);
      expect(await acts.report.check?.(reported, asked(reported))).toEqual({
        status: "completed",
        value: { task: id },
      });
      const made = operationOf(ledger.created(id));
      expect(await acts.create.check?.(made, asked(made))).toEqual({ status: "completed", value: { id } });
      const [end] = await niwa.records.read({ types: [TaskDone.name] });
      const finished = operationOf(end);
      expect(await acts.finish.check?.(finished, asked(finished))).toEqual({
        status: "completed",
        value: { task: id, outcome: { status: "result", result: "done" } },
      });

      const failing = (await niwa.call(taskCreate, input)).id;
      await worker.call(taskFail, { task: failing, reason: "broke" });
      const ends = await niwa.records.read({ types: [TaskDone.name] });
      const failed = operationOf(ends[1]);
      expect(await acts.fail.check?.(failed, asked(failed))).toEqual({
        status: "completed",
        value: { task: failing, outcome: { status: "failure", reason: "broke" } },
      });

      // An operation that wrote nothing is not known to have done anything, and one that wrote
      // another kind of fact is not an answer to the question.
      const none = "op-none" as OperationId;
      expect(await acts.create.check?.(none, asked(none))).toEqual({ status: "unknown" });
      expect(await acts.finish.check?.(made, asked(made))).toEqual({ status: "unknown" });
    } finally {
      await worker.close().catch(() => {});
    }
  });
}, 30_000);
