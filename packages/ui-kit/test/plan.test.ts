import { describe, expect, test } from "bun:test";

import { describeRecompute, describeStop, recomputeImpact, stopImpact, type PlanPhase } from "../src/index.ts";

const plan: PlanPhase[] = [
  {
    id: "prepare",
    title: "Prepare",
    state: "done",
    steps: [
      { id: "fetch", title: "Fetch sources", state: "done" },
      { id: "lint", title: "Lint", state: "skipped" },
    ],
  },
  {
    id: "build",
    title: "Build",
    state: "running",
    steps: [
      { id: "compile", title: "Compile", state: "done" },
      { id: "notify", title: "Notify the channel", state: "done", effect: true },
      { id: "test", title: "Test", state: "running" },
    ],
  },
  {
    id: "ship",
    title: "Ship",
    state: "pending",
    steps: [
      { id: "push", title: "Push", state: "pending", effect: true },
      { id: "announce", title: "Announce", state: "pending" },
    ],
  },
];

describe("recompute impact", () => {
  test("selecting a completed send warns about redelivery", () => {
    const target = { phase: "build", step: "notify" };
    expect(recomputeImpact(plan, target)).toEqual({ selected: 1, flagged: 1 });
    expect(describeRecompute(plan, target)).toContain("Previously sent messages or other external changes may be repeated.");
  });

  test("a phase counts its recorded steps without forecasting later branches", () => {
    expect(recomputeImpact(plan, { phase: "build" })).toEqual({ selected: 3, flagged: 1 });
    expect(describeRecompute(plan, { phase: "build" })).toContain("3 steps in this phase");
    expect(recomputeImpact(plan, { phase: "build", step: "compile" })).toEqual({ selected: 1, flagged: 0 });
  });

  test("missing effect metadata and a failed send both retain the external-effect warning", () => {
    for (const effect of [true, undefined]) {
      const phases: PlanPhase[] = [{ id: "p", title: "Send", state: "failed", steps: [{ id: "send", title: "Send", state: "failed", effect }] }];
      expect(describeRecompute(phases, { phase: "p", step: "send" })).toContain("external changes may be repeated");
    }
  });

  test("an unknown selection has no recorded steps", () => {
    expect(recomputeImpact(plan, { phase: "nope" })).toEqual({ selected: 0, flagged: 0 });
  });
});

describe("stop impact", () => {
  test("stopping a phase stops what runs in it and keeps later steps from starting", () => {
    expect(stopImpact(plan, { phase: "build" })).toEqual({ stopping: 1, notStarting: 2 });
    expect(describeStop(plan, { phase: "build" })).toBe("Stop “Build”: 1 step running stop, 2 steps will not start.");
  });

  test("stopping a step that does not run only keeps the pending ones from starting", () => {
    expect(stopImpact(plan, { phase: "ship", step: "push" })).toEqual({ stopping: 0, notStarting: 2 });
    expect(describeStop(plan, { phase: "ship", step: "push" })).toBe("Stop “Push”: 2 steps will not start.");
  });
});
