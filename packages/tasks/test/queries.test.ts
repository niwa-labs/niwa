// The query builders of the tasks records entry: the records of one task, as a script waits for
// them, a reader reads them and a handler subscribes to them.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import { TaskDone, TaskUpdated, taskDone, taskUpdates } from "../src/records-entry.ts";

test("the end and the updates of one task are a query of their type, filtered on the task", () => {
  const task = "task-3fa9c2";
  expect(taskDone(task)).toEqual({ types: [TaskDone], filter: { task } });
  expect(taskUpdates(task)).toEqual({ types: [TaskUpdated], filter: { task } });
  expect(resolveQuery(taskDone(task))).toEqual({ types: ["task.done"], filter: { task } });
});

test("a text that is not the id of a task is refused when the query is made", () => {
  expect(() => taskDone("run-3fa9c2")).toThrow();
});
