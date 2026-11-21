/**
 * The contract a strategy implements as the responsible party of a task.
 *
 * A task is a contract and nothing else. How the work is brought
 * to a result is not part of the task: it is the business of the party that is responsible for it.
 *
 * The responsible party is always one address. It may be an agent, which then simply does the
 * work. It may be a strategy: a plugin that accepts the task, starts sessions and subtasks as it
 * sees fit, and answers for the result. A new way of working is a new strategy; the base does not
 * change.
 *
 * So a strategy is two things and no more:
 *
 * - it accepts a task, or it does not;
 * - it answers for the result of a task it accepted.
 *
 * Nothing else is asked of it. The base does not tell a strategy how to work, does not count its
 * attempts, and does not supervise it.
 */

import type { JsonValue, Address } from "@niwa-labs/core";

import type { TaskContract } from "./records.ts";

/**
 * A strategy: the way a task is brought to a result.
 *
 * The contract is small on purpose: a strategy that accepts a task is asked for the result, and
 * nothing else.
 */
export interface Strategy {
  /**
   * The address this strategy speaks as.
   *
   * It is the address of the task's responsible party: a task assigned to a strategy names it
   * here.
   */
  readonly address: Address;

  /**
   * Accept a task.
   *
   * Return true when the strategy takes the task, and false when it does not: a strategy that
   * does not accept a task leaves it to somebody else. The base does not ask again.
   */
  accept(task: TaskContract): boolean | Promise<boolean>;

  /**
   * Answer for the result of a task.
   *
   * The strategy does the work however it likes, and says how the task ended. The base writes
   * what it says: the task is finished, once.
   */
  answer(task: TaskContract): Promise<TaskAnswer>;
}

/** How a task ended, as a strategy says it. */
export type TaskAnswer =
  | { readonly status: "result"; readonly result: JsonValue }
  | { readonly status: "failure"; readonly reason: string };
