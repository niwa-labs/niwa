/**
 * The records of the tasks module: a task was created, a task was updated, a task is done.
 *
 * A task is a contract and nothing else: what to do, who asked,
 * who is responsible, where to report, what kind of work it is, and how it ended. The records
 * hold that contract and nothing more — no session, no model, no way of working. Those are
 * chosen by intercepts and strategies, and are never encoded in advance.
 *
 * The kind of work is an open label: a plain string, never a closed list in the core.
 */

import { Address, EntityDescription, JsonValueSchema, idSchema, principalSchema, queryOf, record } from "@niwa-labs/core";
import type { Id, TypeQuery } from "@niwa-labs/core";
import { z } from "zod";

import { ResultSchema } from "@niwa-labs/messages/records";

/** The id of a task: `task-3fa9c2`. Niwa issues it when the task is made; the creator never chooses it. */
export const TaskId = idSchema("task");
export type TaskId = Id<"task">;

/**
 * The kind of work a task is.
 *
 * An open label on purpose: the kinds of work are not a closed list in the core.
 */
export const TaskKind = z.string().min(1);

/** How a task ended: a result or a failure. */
export const TaskOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("result"), result: JsonValueSchema }),
  z.object({ status: z.literal("failure"), reason: z.string().min(1) }),
]);

/** How a task ended. */
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** What a task holds when it is created. */
export const TaskContract = z.object({
  /** The id of the task. */
  id: TaskId,
  /** The kind of work this is: an open label. */
  kind: TaskKind,
  /** A few words a list shows, from whoever made the task. */
  description: EntityDescription,
  /** What to do. */
  text: z.string().min(1),
  /** Who asked for the work. */
  askedBy: Address,
  /** Who is responsible for it: one address. */
  responsible: Address,
  /** Where updates and the result go. */
  reportTo: Address,
  /**
   * The shape the result must have: a JSON Schema of an object, declared by whoever asked for the work.
   * `task.finish` checks the result against it, and whoever does the work is shown it.
   */
  result: ResultSchema.optional(),
});

/** One task, as it was created. */
export type TaskContract = z.infer<typeof TaskContract>;

/**
 * A task was created.
 *
 * The record holds the whole contract, so the task can be read without knowing anything else.
 */
export const TaskCreated = record("task.created", TaskContract.extend({ initiator: principalSchema.optional() }));

/**
 * A task was updated.
 *
 * An update is what the responsible party says while the work goes on: a note, a progress
 * report. It says nothing about the end of the task.
 */
export const TaskUpdated = record(
  "task.updated",
  z.object({
    /** The task that was updated. */
    task: TaskId,
    /** What was reported. */
    text: z.string().min(1),
    /** Anything the reporter wants to carry along. */
    data: JsonValueSchema.optional(),
  }),
);

/**
 * A task is done.
 *
 * A task ends once: a second end of the same task is refused, and the first one stands.
 */
export const TaskDone = record(
  "task.done",
  z.object({
    /** The task that is done. */
    task: TaskId,
    /** How it ended. */
    outcome: TaskOutcome,
  }),
);

/**
 * The end of one task: what a script waits for (`wait(taskDone(task.id), { timeout })`), a reader
 * reads and a handler subscribes to. A text that is not the id of a task is refused here.
 */
export function taskDone(task: string): TypeQuery<z.output<typeof TaskDone.schema>> {
  return queryOf(TaskDone, { task: TaskId.parse(task) });
}

/** The updates of one task, in the order they were written. */
export function taskUpdates(task: string): TypeQuery<z.output<typeof TaskUpdated.schema>> {
  return queryOf(TaskUpdated, { task: TaskId.parse(task) });
}

/** Every record type of the tasks module. */
export const TASK_TYPES = [TaskCreated, TaskUpdated, TaskDone] as const;
