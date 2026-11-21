/**
 * The tasks module: a task is a contract and nothing else.
 *
 * - **task.create** returns at once with the id niwa issues (`task-3fa9c2`); the Assignment goes to the
 *   responsible address. The creator gives a short description, and may declare the shape the result
 *   must have (`result`, a JSON Schema of an object).
 * - **task.report** is what the responsible party says while the work goes on.
 * - **task.finish** ends the task with its result, **task.fail** ends it as failed, with the reason.
 *   A task ends once: the first end stands. A result that does not fit the declared schema is
 *   refused, and the task stays open.
 * - **task.result** gives the result, and waits for it when the task is not done yet.
 * - **task.list** and **task.get** show the tasks; **task.assigned** shows the caller the open tasks
 *   it is responsible for that declared a result schema.
 *
 * Where a task says to report, that is where the updates and the end go: the Update on every
 * report, the Result or the Failure when the task is done. Both go from the responsible party
 * to the address of the contract.
 *
 * The state of a task is folded from the journal (`owner.ts`). The actions are values: a
 * responsible party holds the one it needs and calls it as a step of its own invocation.
 */

import { z } from "zod";

import { IdIndex, action, seq } from "@niwa-labs/core";
import type { Action, ActionContext, Address, Caller, JournalReader } from "@niwa-labs/core";
import { bindingOf, COCKPIT_MODULE, plugin } from "@niwa-labs/plugin";
import { fileURLToPath } from "node:url";
import type { CallerBinding, MessagesOptions, Plugin } from "@niwa-labs/plugin";
import { birthOf, issuedIds, messageSendRef } from "@niwa-labs/messages/records";
import type { MessageBody } from "@niwa-labs/messages/records";

import { TaskRefusal, decide, fold, sameAddress, stateOf } from "./owner.ts";
import type { TaskState } from "./owner.ts";
import {
  CreateInput,
  FailInput,
  FinishInput,
  OutcomeOutput,
  ReportInput,
  taskAssigned,
  taskCreate,
  taskFail,
  taskFinish,
  taskGet,
  taskList,
  taskReport,
  taskResult as taskResultRef,
} from "./actions.ts";
import type { TaskEntity } from "./actions.ts";
import { TaskContract, TaskCreated, TaskDone, TaskId, TaskOutcome, TaskUpdated } from "./records.ts";
import { ExecutorAssignment, executorHandler } from "./executor.ts";

/** The facts of the tasks module: the records that say what happened to a task. */
export type TaskFacts = () => readonly unknown[];

/** The facts of the tasks, read from the journal of a plugin. */
export function taskFacts(journal: () => JournalReader | undefined): TaskFacts {
  return () => {
    const reader = journal();
    if (reader === undefined) return [];
    return reader
      .since(seq(0), [TaskCreated.name, TaskUpdated.name, TaskDone.name])
      .map((record) => record.data);
  };
}

/** The ids of tasks: a task is born in the record that creates it. */
export function taskIds(journal: () => JournalReader | undefined): IdIndex<"task"> {
  return new IdIndex("task", () => issuedIds(journal(), [TaskCreated], (contract) => contract.id));
}

/** The actions that write facts about a task. */
export interface TaskActions {
  readonly create: Action<z.infer<typeof CreateInput>, { id: TaskId }, z.input<typeof CreateInput>>;
  readonly report: Action<z.infer<typeof ReportInput>, { task: TaskId }, z.input<typeof ReportInput>>;
  readonly finish: Action<
    z.infer<typeof FinishInput>,
    z.infer<typeof OutcomeOutput>,
    z.input<typeof FinishInput>
  >;
  readonly fail: Action<z.infer<typeof FailInput>, z.infer<typeof OutcomeOutput>, z.input<typeof FailInput>>;
}

/** What the plugin is given. */
export interface TasksOptions {
  /** The binding says what address a caller speaks as: the same one the messages module uses. */
  readonly messages?: MessagesOptions;
}

/** The tasks module. */
export function tasks(opts: TasksOptions = {}): Plugin {
  const bind = bindingOf(opts.messages);
  const waiting = new Map<string, Set<() => void>>();

  return plugin("tasks", (api) => {
    // The page of this plugin in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "tasks", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });
    const journal = () => api.journal?.();
    const facts = taskFacts(journal);
    const ids = taskIds(journal);
    const written = taskActions(facts, ids, bind);
    const result = taskResult(facts, {
      watch(task) {
        let wake = () => {};
        const woken = new Promise<void>((resolve) => (wake = resolve));
        const set = waiting.get(task) ?? new Set();
        set.add(wake);
        waiting.set(task, set);
        return { woken, stop: () => set.delete(wake) };
      },
    });
    const reads = taskReads(facts, ids, bind);

    api.declare(TaskCreated, TaskUpdated, TaskDone);

    api.action(written.create);
    api.action(written.report);
    api.action(written.finish);
    api.action(written.fail);
    api.action(result);
    api.action(reads.list);
    api.action(reads.get);
    api.action(reads.assigned);

    // Hand the work over: the Assignment goes to the responsible address, on behalf of the asker.
    // It carries the result schema the task declared, so whoever does the work is shown it.
    api.on(TaskCreated, async (data, step) => {
      await step(messageSendRef, {
        from: data.askedBy,
        to: data.responsible,
        task: data.id,
        body: {
          type: "assignment",
          text: data.text,
          kind: data.kind,
          ...(data.result === undefined ? {} : { result: data.result }),
        },
      });
    });

    // An assignment for an executor is work to do: the executor starts a session, asks it for
    // the result and ends the task with what the session said.
    // Each task is worked on by its own session, for as long as it takes.
    api.on(ExecutorAssignment, { concurrency: Number.POSITIVE_INFINITY }, executorHandler(facts));

    // The updates go where the task says to report: from the responsible party to that address.
    api.on(TaskUpdated, async (data, step) => {
      const contract = stateOf(facts(), data.task)?.contract;
      if (contract === undefined) return;
      await step(messageSendRef, {
        from: contract.responsible,
        to: contract.reportTo,
        task: data.task,
        body: {
          type: "update",
          text: data.text,
          ...(data.data === undefined ? {} : { data: data.data }),
        },
      });
    });

    // The end of the task goes there too: the Result, or the Failure.
    api.on(
      TaskDone,
      { id: "task.done.report" },
      async (data, step) => {
        const contract = stateOf(facts(), data.task)?.contract;
        if (contract === undefined) return;
        await step(messageSendRef, {
          from: contract.responsible,
          to: contract.reportTo,
          task: data.task,
          body: outcomeBody(data.outcome),
        });
      },
    );

    // Wake the callers waiting for the result: they read it from the journal.
    api.on(
      TaskDone,
      { id: "task.done.wake" },
      async (data) => {
        const wakes = waiting.get(data.task);
        waiting.delete(data.task);
        for (const wake of wakes ?? []) wake();
      },
    );
  });
}

/** The actions that write facts, made from the facts and the binding of callers to addresses. */
export function taskActions(facts: TaskFacts, ids: IdIndex<"task">, bind: CallerBinding): TaskActions {
  /** The address the caller speaks as; a caller that is bound to none speaks for nobody. */
  const speaksAs = (caller: Caller): Address => {
    const address = bind(caller);
    if (address === undefined) {
      throw new TaskRefusal("unbound", "the caller is not bound to an address, so it speaks for no task");
    }
    return address;
  };

  const create = action(taskCreate, {
    // A task is made once: a create that was cut off may have made the task, and a second
    // create of the same task is refused. So the call is not made again.
    recovery: "do-not-repeat",
    async run(input, ctx) {
      const contract: TaskContract = { ...input, id: ids.issue(birthOf(ctx)) };
      decide(stateOf(facts(), contract.id), { kind: "create", contract });
      await ctx.emit(TaskCreated, contract);
      return { id: contract.id };
    },
  });

  const report = action(taskReport, {
    // A report is a fact written on the task: the same report may be written again, so
    // it may be made again.
    recovery: "repeat",
    async run(input, ctx) {
      decide(stateOf(facts(), input.task), {
        kind: "report",
        task: input.task,
        by: speaksAs(ctx.caller),
      });
      await ctx.emit(TaskUpdated, input);
      return { task: input.task };
    },
  });

  /** End a task with an outcome: the fact is written once, and the first end stands. */
  const end = async (
    ctx: ActionContext,
    task: TaskId,
    outcome: TaskOutcome,
  ): Promise<z.infer<typeof OutcomeOutput>> => {
    decide(stateOf(facts(), task), { kind: "finish", task, by: speaksAs(ctx.caller), outcome });
    await ctx.emit(TaskDone, { task, outcome });
    return { task, outcome };
  };

  const finish = action(taskFinish, {
    // A task ends once: an end that was cut off may have written it, so it is not
    // made again.
    recovery: "do-not-repeat",
    run: (input, ctx) => end(ctx, input.task, { status: "result", result: input.result }),
  });

  const fail = action(taskFail, {
    // The same as finish: the end may have been written.
    recovery: "do-not-repeat",
    run: (input, ctx) => end(ctx, input.task, { status: "failure", reason: input.reason }),
  });

  return { create, report, finish, fail };
}

/** What a task is, as `task.get` shows it. */
function entityOf(state: TaskState): TaskEntity {
  return { ...state.contract, status: state.status, ...(state.status === "done" ? { outcome: state.outcome } : {}) };
}

/** The actions that read tasks: the list, one task, and the open tasks of the caller that declared a result schema. */
function taskReads(facts: TaskFacts, ids: IdIndex<"task">, bind: CallerBinding) {
  const list = action(taskList, {
    recovery: "repeat",
    run: async (input) => ({
      items: [...fold(facts()).values()]
        .filter((state) => input.status === undefined || state.status === input.status)
        .map((state) => ({
          id: state.contract.id,
          description: state.contract.description,
          status: state.status,
          kind: state.contract.kind,
          responsible: state.contract.responsible,
        })),
    }),
  });

  const get = action(taskGet, {
    recovery: "repeat",
    run: async (input) => {
      const id = ids.require(input.id);
      const state = stateOf(facts(), id);
      if (state === undefined) throw new TaskRefusal("unknown", `the task "${id}" does not exist`);
      return entityOf(state);
    },
  });

  const assigned = action(taskAssigned, {
    recovery: "repeat",
    run: async (_input, ctx) => {
      const me = bind(ctx.caller);
      if (me === undefined) return { tasks: [] };
      return {
        tasks: [...fold(facts()).values()].flatMap((state) =>
          state.status === "open" && state.contract.result !== undefined && sameAddress(state.contract.responsible, me)
            ? [{ task: state.contract.id, description: state.contract.description, result: state.contract.result }]
            : [],
        ),
      };
    },
  });

  return { list, get, assigned };
}

/** The ways the action that asks for a result is woken. */
interface Watcher {
  /** Watch for the end of a task. Watching starts before the state is read, so no end is missed. */
  watch(task: string): { woken: Promise<void>; stop(): void };
}

/** The action that gives the result of a task, and waits for it when the task is not done. */
function taskResult(facts: TaskFacts, watcher: Watcher) {
  return action(taskResultRef, {
    // The result is read from the journal: it may be asked again.
    recovery: "repeat",
    async run(input) {
      for (;;) {
        const watch = watcher.watch(input.task);
        try {
          const state = stateOf(facts(), input.task);
          if (state === undefined) {
            throw new TaskRefusal("unknown", `the task "${input.task}" does not exist`);
          }
          if (state.status === "done") return { task: input.task, outcome: state.outcome };
          await watch.woken;
        } finally {
          watch.stop();
        }
      }
    },
  });
}

/**
 * The body of the message that says how the task ended: the Result, or the Failure.
 *
 * The text says what came of it, so a reader that only unfolds the envelope knows how the work
 * went; the result and the reason are carried along as they are.
 */
function outcomeBody(outcome: TaskOutcome): MessageBody {
  if (outcome.status === "failure") {
    return { type: "failure", text: outcome.reason, reason: outcome.reason };
  }
  return {
    type: "result",
    text: textOf(outcome.result),
    data: outcome.result,
  };
}

/**
 * The text of a result: what it is, as a reader sees it.
 *
 * A body always carries text, so a result that says nothing in words still says that the work
 * is done.
 */
function textOf(result: unknown): string {
  if (typeof result === "string") return result.length === 0 ? "the task is done" : result;
  if (result === undefined) return "the task is done";
  try {
    return JSON.stringify(result) ?? "the task is done";
  } catch {
    return "the task is done";
  }
}

export {
  CreateInput,
  TaskEntity,
  TaskStatus,
  taskAssigned,
  taskCreate,
  taskFail,
  taskFinish,
  taskGet,
  taskList,
  taskReport,
  taskResult,
} from "./actions.ts";
export { TaskCreated, TaskDone, TaskId, TaskUpdated, TASK_TYPES } from "./records.ts";
export type { TaskContract, TaskKind, TaskOutcome } from "./records.ts";
export { TaskRefusal, decide, fold, sameAddress, stateOf } from "./owner.ts";
export type { Command, TaskState } from "./owner.ts";
export { ExecutorAssignment, executor, executorHandler } from "./executor.ts";
export type { Strategy, TaskAnswer } from "./strategy.ts";
