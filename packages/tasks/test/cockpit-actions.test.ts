// The copy of the task actions the cockpit module keeps reads what the host answers and sends what it takes.

import { expect, test } from "bun:test";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { taskGet, taskList } from "../src/index.ts";
import { getAction, listAction } from "../src/cockpit/actions.ts";

test("the task list is read from what the host answers", () => {
  expect(listAction.name).toBe(String(taskList.name));
  expect(unsendable(listAction.input, taskList.input)).toEqual([]);
  expect(unreadable(listAction.output, taskList.output)).toEqual([]);
});

test("one task is read from what the host answers", () => {
  expect(getAction.name).toBe(String(taskGet.name));
  expect(unsendable(getAction.input, taskGet.input)).toEqual([]);
  expect(unreadable(getAction.output, taskGet.output)).toEqual([]);
});
