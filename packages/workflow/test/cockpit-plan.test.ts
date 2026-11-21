// The plan of a run page: the declared phases, then the steps that named none.

import { expect, test } from "bun:test";

import type { Inspection, Step } from "../src/cockpit/actions.ts";
import { planOf, stepDuration, stepState, STEPS_PHASE } from "../src/cockpit/plan.ts";

function step(id: string, status: Step["status"], extra: Partial<Step> = {}): Step {
  return { id, label: id, key: id, action: "niwa.now", startedAt: "2026-01-01T00:00:00.000Z", status, ...extra };
}

function inspection(over: Partial<Inspection>): Inspection {
  return {
    run: "run-1",
    status: { run: "run-1", state: "running", requests: [] },
    origin: { file: "/w/a.js", requestedAt: "2026-01-01T00:00:00.000Z" },
    phases: [],
    steps: [],
    ...over,
  };
}

const plain = (one: Step) => ({ id: one.id, title: one.label, state: stepState(one) });

test("a step status is shown as the state of a ring", () => {
  expect(stepState(step("a", "paused"))).toBe("waiting");
  expect(stepState(step("a", "completed"))).toBe("done");
  expect(stepState(step("a", "cancelled"))).toBe("stopped");
  expect(stepState(step("a", "unknown"))).toBe("pending");
});

test("how long a step took is known once it ended", () => {
  expect(stepDuration(step("a", "running"))).toBeUndefined();
  expect(stepDuration(step("a", "completed", { endedAt: "2026-01-01T00:00:02.500Z" }))).toBe(2500);
  expect(stepDuration(step("a", "completed", { endedAt: "2025-12-31T00:00:00.000Z" }))).toBeUndefined();
});

test("a script with no phases has one phase that holds its steps and its controls", () => {
  const plan = planOf(inspection({ steps: [step("s1", "completed")] }), plain);
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({ title: "Run", state: "running", steps: [{ id: "s1", state: "done" }] });
});

test("a run with no step yet still has a row", () => {
  const plan = planOf(inspection({}), plain);
  expect(plan).toMatchObject([{ title: "Run", state: "running", steps: [] }]);
});

test("declared phases keep their order, and the steps outside every phase follow as the last", () => {
  const plan = planOf(
    inspection({
      phases: [
        { title: "Plan", state: "done", steps: [step("p1", "completed")] },
        { title: "Build", state: "current", steps: [step("b1", "paused")] },
        { title: "Ship", state: "ahead", steps: [] },
      ],
      steps: [step("loose", "running")],
      status: { run: "run-1", state: "paused", requests: ["req-1"], reason: "asks" },
    }),
    plain,
  );
  expect(plan.map((phase) => [phase.title, phase.state])).toEqual([
    ["Plan", "done"],
    ["Build", "waiting"],
    ["Ship", "pending"],
    [STEPS_PHASE, "running"],
  ]);
});

test("the current phase takes on how the run ended", () => {
  const phases = [{ title: "Build", state: "current" as const, steps: [] }];
  expect(planOf(inspection({ phases, status: { run: "r", state: "finished", requests: [], outcome: { status: "failed", error: { message: "boom" } } } }), plain)[0]?.state).toBe("failed");
  expect(planOf(inspection({ phases, status: { run: "r", state: "finished", requests: [], outcome: { status: "cancelled" } } }), plain)[0]?.state).toBe("stopped");
});
