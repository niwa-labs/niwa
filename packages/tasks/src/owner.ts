/**
 * The rules of a task. The state is folded from the journal, never kept in memory, and a decision
 * says whether a command is allowed before anything is written.
 *
 * - a task finishes once: the first end stands, and a second end is refused;
 * - only the responsible party reports and finishes;
 * - a report or a finish of a task that does not exist is refused;
 * - a result that does not fit the schema the task declared is refused, and the task stays open.
 */

import { z } from "zod";

import { CatchableError } from "@niwa-labs/core";
import type { Address } from "@niwa-labs/core";
import type { ResultSchema } from "@niwa-labs/messages/records";

import { TaskCreated, TaskDone } from "./records.ts";
import type { TaskContract, TaskId, TaskOutcome } from "./records.ts";

/**
 * The commands that can be made to a task.
 *
 * A finish with no outcome asks only whether the party may end the task; one with an outcome is
 * also held to the result schema the task declared.
 */
export type Command =
  | { readonly kind: "create"; readonly contract: TaskContract }
  | { readonly kind: "report"; readonly task: TaskId; readonly by: Address }
  | {
      readonly kind: "finish";
      readonly task: TaskId;
      readonly by: Address;
      readonly outcome?: TaskOutcome;
    };

/** What a task is now. */
export type TaskState =
  | { readonly status: "open"; readonly task: TaskId; readonly contract: TaskContract }
  | {
      readonly status: "done";
      readonly task: TaskId;
      readonly contract: TaskContract;
      readonly outcome: TaskOutcome;
    };

/** Why a command was refused. */
export type TaskRefusalCode =
  | "unbound"
  | "not-asker"
  | "exists"
  | "unknown"
  | "done"
  | "not-responsible"
  | "result-schema"
  | "result-invalid"
  | "no-task"
  | "not-an-executor"
  | "not-the-assignment";

/**
 * A refusal: a command that breaks a rule. Nothing was written, so it is the caller's to catch
 * (a result that does not fit is corrected and sent again), not a failed step.
 */
export class TaskRefusal extends CatchableError {
  override name = "TaskRefusal";
  /** The code of the refusal, so a caller can tell one from another. */
  override readonly code: TaskRefusalCode;

  constructor(code: TaskRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The state of every task, folded from the facts about them.
 *
 * The first creation and the first end of a task stand; a later one of the same task is passed
 * over, as is a record that is not a fact about a task.
 */
export function fold(facts: readonly unknown[]): Map<string, TaskState> {
  const states = new Map<string, TaskState>();
  for (const fact of facts) {
    const created = TaskCreated.schema.safeParse(fact);
    if (created.success) {
      if (!states.has(created.data.id)) {
        states.set(created.data.id, { status: "open", task: created.data.id, contract: created.data });
      }
      continue;
    }
    const done = TaskDone.schema.safeParse(fact);
    if (done.success) {
      const state = states.get(done.data.task);
      if (state === undefined || state.status === "done") continue;
      states.set(done.data.task, { ...state, status: "done", outcome: done.data.outcome });
    }
  }
  return states;
}

/** The state of one task, from the facts about it. */
export function stateOf(facts: readonly unknown[], task: string): TaskState | undefined {
  return fold(facts).get(task);
}

/** A declared result schema, read as a schema that checks. */
function readResultSchema(schema: ResultSchema): z.ZodType<unknown> {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** A result schema is refused unless it describes an object and can be read. */
function checkResultSchema(schema: ResultSchema): void {
  if (schema.type !== "object") {
    throw new TaskRefusal("result-schema", 'the result schema must describe an object: its "type" must be "object"');
  }
  try {
    readResultSchema(schema);
  } catch (error) {
    throw new TaskRefusal("result-schema", `the result schema cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Refuse a result that does not fit the schema the task declared; a task that declared none takes any. */
function checkResult(contract: TaskContract, outcome: TaskOutcome): void {
  if (outcome.status !== "result" || contract.result === undefined) return;
  const parsed = readResultSchema(contract.result).safeParse(outcome.result);
  if (parsed.success) return;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(result)"}: ${issue.message}`).join("; ");
  throw new TaskRefusal("result-invalid", `the result does not fit the schema the task "${contract.id}" declared: ${issues}`);
}

/** Refuse a command that breaks a rule. Nothing is written here: the caller writes the fact. */
export function decide(state: TaskState | undefined, command: Command): void {
  if (command.kind === "create") {
    if (state !== undefined) {
      throw new TaskRefusal("exists", `the task "${command.contract.id}" already exists`);
    }
    if (command.contract.result !== undefined) checkResultSchema(command.contract.result);
    return;
  }
  if (state === undefined) {
    throw new TaskRefusal("unknown", `the task "${command.task}" does not exist`);
  }
  if (state.status === "done") {
    throw new TaskRefusal("done", `the task "${command.task}" is already done`);
  }
  if (!sameAddress(command.by, state.contract.responsible)) {
    throw new TaskRefusal(
      "not-responsible",
      `only the responsible party of the task "${command.task}" may ${command.kind} it`,
    );
  }
  if (command.kind === "finish" && command.outcome !== undefined) checkResult(state.contract, command.outcome);
}

/** Are two addresses the same one? They are when they say the same thing, kind included. */
export function sameAddress(one: Address, other: Address): boolean {
  const left = Object.entries(one);
  return (
    left.length === Object.keys(other).length &&
    left.every(([key, value]) => (other as Record<string, unknown>)[key] === value)
  );
}
