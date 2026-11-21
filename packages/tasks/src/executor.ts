/**
 * The executor: the plain way of doing a task.
 *
 * The address "an agent in this harness" is `executor(harnessId)`. It means: somebody who runs
 * in that harness and does the work. It is the simplest responsible party there is — one agent,
 * one session, one answer.
 *
 * It names a harness by id and imports no harness kind. How it works is the business of the
 * sessions module; a different way of working is a strategy (see `strategy.ts`).
 *
 * The work is plain: a session is started with the assignment, the session is asked for the
 * result, and the task ends with what the session said. The sessions module is reached by the
 * name of its actions, the way the messages module reaches "session.send": the tasks module
 * imports no sessions module and names no harness kind.
 */

import { actionName, jsonOf } from "@niwa-labs/core";
import type { ActionName, Address, RecordType, Step } from "@niwa-labs/core";
import { z } from "zod";

import { trigger } from "@niwa-labs/plugin";
import type { Trigger } from "@niwa-labs/plugin";
import { MessageSent, render } from "@niwa-labs/messages/records";
import type { Message } from "@niwa-labs/messages/records";

import type { TaskLedger } from "./ledger.ts";
import { TaskRefusal, decide } from "./owner.ts";
import { TaskDone } from "./records.ts";
import type { TaskOutcome } from "./records.ts";

/** The name of the action that starts a session. */
export const SESSION_START: ActionName = actionName("session.start");

/** The name of the action that asks a session for an answer by schema. */
export const SESSION_ASK: ActionName = actionName("session.ask");

/** The prefix of the address of an executor: "executor:<harness>". */
const EXECUTOR_PREFIX = "executor:";

/** The schema the answer of the session must pass when the task declared none: one field, the result of the task. */
const RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
};

/** The answer of the session, as the schema says it is. */
const Answer = z.object({ result: z.string() });

/**
 * The trigger: the assignments that are for an agent.
 *
 * It is the type "message.sent" narrowed to the assignments sent to an agent. Whether the agent is
 * an executor — its id names a harness — and whether there is a task to answer for is more than
 * equality says: the handler checks it, and passes over the assignments for anybody else.
 */
export const ExecutorAssignment: Trigger<Message> = trigger(MessageSent, {
  name: "message.sent:executor",
  filter: { "to.kind": "agent", "body.type": "assignment" },
});

/** Is the assignment one for an executor: an agent whose id names a harness, with a task to answer for? */
export function forExecutor(message: Message): boolean {
  if (message.to.kind !== "agent" || !message.to.id.startsWith(EXECUTOR_PREFIX)) return false;
  return typeof message.task === "string" && message.task.length > 0;
}

/**
 * The handler of the executor: it does the work of one task.
 *
 * The session is started with the assignment, the session is asked for the result, and the task
 * ends with what it said. When the task declared a result schema, the session is asked by that
 * schema and its whole answer is the result; otherwise the result is a text. The end of the task
 * is written here, by the responsible party itself:
 * the executor is the party the task named, so it may end it, and it does it through the same
 * rule and the same record the actions "task.finish" and "task.fail" use.
 */
export function executorHandler(
  ledger: TaskLedger,
): (message: Message, step: Step) => Promise<void> {
  return async (message, step) => {
    if (!forExecutor(message)) return;
    if (message.task === undefined) {
      throw new TaskRefusal("no-task", "the assignment names no task");
    }
    const task = message.task;
    const harness = harnessOf(message);
    const address = { kind: "agent" as const, id: `${EXECUTOR_PREFIX}${harness}` };

    // A task that cannot be ended by this executor is refused before any work is done.
    const before = ledger.state(task);
    if (before?.status === "done") return;
    decide(before, { kind: "finish", task, by: address });
    const declared = before?.contract.result;

    const { session } = await step<{ harness: string; prompt: string }, { session: string }>(SESSION_START, {
      harness,
      prompt: render(message),
    });

    const { value } = await step<
      { session: string; prompt: string; schema: Record<string, unknown> },
      { value: unknown }
    >(SESSION_ASK, {
      session,
      prompt: "Give the result of the task.",
      schema: declared ?? RESULT_SCHEMA,
    });

    const state = ledger.state(task);
    if (state?.status === "done") return; // the end already stands: the same fact, written once
    const outcome = outcomeOf(value, declared !== undefined);
    decide(state, { kind: "finish", task, by: address, outcome });
    await step.emit(TaskDone, { task, outcome });
  };
}

/**
 * The address of an agent in a harness.
 *
 * It is the address of an agent, not of a session: the session is started later, and a task and
 * a session are different things.
 */
export function executor(harness: string): Address {
  if (typeof harness !== "string" || harness.trim().length === 0) {
    throw new TypeError("a harness id must be a non-empty string");
  }
  return { kind: "agent", id: `executor:${harness}` };
}

/** The harness an executor address names. */
function harnessOf(message: Message): string {
  if (message.to.kind !== "agent" || !message.to.id.startsWith(EXECUTOR_PREFIX)) {
    throw new TaskRefusal("not-an-executor", "the assignment is not for an executor");
  }
  const harness = message.to.id.slice(EXECUTOR_PREFIX.length);
  if (harness.length === 0) {
    throw new TaskRefusal("not-an-executor", `"${message.to.id}" names no harness`);
  }
  return harness;
}

/**
 * How the task ended, from what the session answered.
 *
 * The answer is a result or nothing: a session that did not answer with a result did not do
 * the task, and the task ends in a failure rather than with a made-up result. When the task
 * declared a schema, the session has answered by it and the answer is the result.
 */
function outcomeOf(value: unknown, declared: boolean): TaskOutcome {
  if (declared) return { status: "result", result: jsonOf(value) };
  const parsed = Answer.safeParse(value);
  if (parsed.success) return { status: "result", result: parsed.data.result };
  return { status: "failure", reason: "the session did not answer with a result" };
}
