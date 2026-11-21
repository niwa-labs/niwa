/**
 * The actions of the tasks module, as typed references: name, description and the two schemas.
 *
 * A caller imports these to call a task action with the input and the output checked by the type
 * checker, on the host and on a client, without any data of the module. The module's factory builds
 * its real actions from the same references (`action(taskCreate, { recovery, run })`), so the
 * schemas here are the ones the host checks against.
 */

import { z } from "zod";

import { JsonValueSchema, actionRef, getRef, listRef, Address } from "@niwa-labs/core";

import { ResultSchema } from "@niwa-labs/messages/records";

import { TaskContract, TaskId, TaskKind, TaskOutcome } from "./records.ts";

/** The input of the action that makes a task: the contract without its id, which niwa issues. */
export const CreateInput = TaskContract.omit({ id: true }).strict();

/** The input of the action that reports on a task. */
export const ReportInput = z.object({ task: TaskId, text: z.string().min(1), data: JsonValueSchema.optional() });

/** The input of the action that finishes a task with a result. */
export const FinishInput = z.object({
  task: TaskId,
  /** The result of the work: when the task declared a result schema, it must fit it. */
  result: JsonValueSchema,
});

/** The input of the action that ends a task as failed. */
export const FailInput = z.object({
  task: TaskId,
  /** Why the work did not succeed. */
  reason: z.string().min(1),
});

/** What the actions that finish or fail a task and ask for its result return. */
export const OutcomeOutput = z.object({ task: TaskId, outcome: TaskOutcome });

export const taskCreate = actionRef("task.create", {
  description:
    "Make a task: a few words of description, what to do, who asked, who is responsible, where to report. " +
    "`result` may declare the shape the result must have, as a JSON Schema of an object: " +
    "whoever does the work is shown it, and `task.finish` refuses a result that does not fit. " +
    "It returns the id niwa issued at once, and the work goes on in the background.",
  input: CreateInput,
  output: z.object({ id: TaskId }),
});

export const taskReport = actionRef("task.report", {
  description: "Report what happened on a task while the work goes on.",
  input: ReportInput,
  output: z.object({ task: TaskId }),
});

export const taskFinish = actionRef("task.finish", {
  description:
    "Finish a task with its result. When the task declared a result schema, the result must fit it, or the task stays open. " +
    "A task ends once, with a result or a failure; the first end stands.",
  input: FinishInput,
  output: OutcomeOutput,
});

export const taskFail = actionRef("task.fail", {
  description: "End a task as failed, with the reason. A task ends once, with a result or a failure; the first end stands.",
  input: FailInput,
  output: OutcomeOutput,
});

export const taskResult = actionRef("task.result", {
  description:
    "The result of a task. If the task is not done yet, this waits for it. The answer is read from the journal.",
  input: z.object({ task: TaskId }),
  output: OutcomeOutput,
});

/** Whether a task is still being worked on. */
export const TaskStatus = z.enum(["open", "done"]);

/** One task as `task.get` shows it: the contract, where it stands, and how it ended when it did. */
export const TaskEntity = TaskContract.extend({ status: TaskStatus, outcome: TaskOutcome.optional() });
export type TaskEntity = z.infer<typeof TaskEntity>;

export const taskList = listRef("task.list", {
  kind: "task",
  noun: "task",
  detail: "The filter `status` keeps the open tasks or the done ones.",
  filter: { status: TaskStatus.optional() },
  item: { status: TaskStatus, kind: TaskKind, responsible: Address },
});

export const taskGet = getRef("task.get", {
  kind: "task",
  noun: "task",
  detail: "It shows the whole contract, where the task stands and how it ended.",
  entity: TaskEntity,
});

/** The open tasks that declared a result schema and that the caller is responsible for. */
export const taskAssigned = actionRef("task.assigned", {
  description:
    "The open tasks the caller is responsible for that declare a result schema: the id, the description and the schema each result must fit.",
  input: z.object({}),
  output: z.object({
    tasks: z.array(z.object({ task: TaskId, description: TaskContract.shape.description, result: ResultSchema })),
  }),
});
