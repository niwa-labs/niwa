// The copy of the session actions the cockpit module keeps reads what the host answers and sends what it takes.

import { expect, test } from "bun:test";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { sessionList, sessionRead } from "../src/index.ts";
import { listAction, readAction } from "../src/cockpit/actions.ts";

test("the session list is read from what the host answers", () => {
  expect(listAction.name).toBe(String(sessionList.name));
  expect(unsendable(listAction.input, sessionList.input)).toEqual([]);
  expect(unreadable(listAction.output, sessionList.output)).toEqual([]);
});

test("a transcript is read from what the host answers", () => {
  expect(readAction.name).toBe(String(sessionRead.name));
  expect(unsendable(readAction.input, sessionRead.input)).toEqual([]);
  expect(unreadable(readAction.output, sessionRead.output)).toEqual([]);
});
