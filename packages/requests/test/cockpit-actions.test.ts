// The copy of the request actions the cockpit module keeps reads what the host answers and sends what it takes.

import { expect, test } from "bun:test";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { requestAnswer, requestOpen } from "../src/index.ts";
import { answerAction, openAction } from "../src/cockpit/actions.ts";

test("the open requests are read from what the host lists", () => {
  expect(openAction.name).toBe(String(requestOpen.name));
  expect(unreadable(openAction.output, requestOpen.output)).toEqual([]);
});

test("an answer is sent as the host takes it, and the host's reply is read", () => {
  expect(answerAction.name).toBe(String(requestAnswer.name));
  expect(unsendable(answerAction.input, requestAnswer.input)).toEqual([]);
  expect(unreadable(answerAction.output, requestAnswer.output)).toEqual([]);
});
