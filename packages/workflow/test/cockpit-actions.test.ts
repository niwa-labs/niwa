// The copy of the workflow actions the cockpit module keeps reads what the host answers and sends what it takes.

import { expect, test } from "bun:test";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { workflowCancel, workflowInspect, workflowResume, workflowRuns } from "../src/index.ts";
import { cancelAction, inspectAction, resumeAction, runsAction } from "../src/cockpit/actions.ts";

test.each([
  ["workflow.runs", runsAction, workflowRuns],
  ["workflow.inspect", inspectAction, workflowInspect],
  ["workflow.resume", resumeAction, workflowResume],
  ["workflow.cancel", cancelAction, workflowCancel],
] as const)("%s is sent as the host takes it and its answer is read", (name, copy, real) => {
  expect(copy.name).toBe(name);
  expect(String(real.name)).toBe(name);
  expect(unsendable(copy.input, real.input)).toEqual([]);
  expect(unreadable(copy.output, real.output)).toEqual([]);
});
