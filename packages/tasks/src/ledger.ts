/**
 * The ledger of tasks: what the journal says of them, read the way each question needs.
 *
 * A task is born in the record that creates it and ends in the record that ends it; an update
 * changes neither. So the state of every task is folded from the creations and the ends, and the
 * state of one task is read from its own two records, never from the journal as a whole.
 */

import { recordId, seq } from "@niwa-labs/core";
import type { JournalReader, StoredRecord } from "@niwa-labs/core";

import { fold } from "./owner.ts";
import type { TaskState } from "./owner.ts";
import { TaskCreated, TaskDone } from "./records.ts";

/** What the journal says of the tasks. */
export interface TaskLedger {
  /** The state of every task, folded from the records that create and end them. */
  states(): Map<string, TaskState>;
  /** The state of one task, from its own records. */
  state(task: string): TaskState | undefined;
  /** The record that created a task. */
  created(task: string): StoredRecord | undefined;
  /** The record a call wrote first under an operation id: what a call that was cut off may have done. */
  written(operation: string): StoredRecord | undefined;
}

/** The ledger of the tasks in the journal of a plugin. */
export function taskLedger(journal: () => JournalReader | undefined): TaskLedger {
  const createdIn = (reader: JournalReader, task: string): StoredRecord | undefined =>
    reader
      .find({ type: TaskCreated.name, field: "id", equals: task })
      .find((stored) => TaskCreated.schema.safeParse(stored.data).success);

  return {
    states() {
      const reader = journal();
      if (reader === undefined) return new Map();
      return fold(reader.since(seq(0), [TaskCreated.name, TaskDone.name]).map((stored) => stored.data));
    },
    state(task) {
      const reader = journal();
      if (reader === undefined) return undefined;
      const created = createdIn(reader, task);
      if (created === undefined) return undefined;
      const ends = reader.find({ type: TaskDone.name, field: "task", equals: task });
      return fold([created.data, ...ends.map((stored) => stored.data)]).get(task);
    },
    created(task) {
      const reader = journal();
      return reader === undefined ? undefined : createdIn(reader, task);
    },
    written(operation) {
      return journal()?.get(recordId(`${operation}/emit/1`));
    },
  };
}
