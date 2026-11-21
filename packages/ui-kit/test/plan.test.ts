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
  test("a step and everything after it run again; earlier results are kept", () => {
    expect(recomputeImpact(plan, { phase: "build", step: "compile" })).toEqual({ rerun: 5, kept: 1, effectsRepeated: 1 });
    expect(describeRecompute(plan, { phase: "build", step: "compile" })).toBe(
      "Recompute from “Compile”: 5 steps run again, 1 earlier kept. 1 step that already acted outside may act again.",
    );
  });

  test("choosing a step that already acted outside never promises it is kept", () => {
    expect(recomputeImpact(plan, { phase: "build", step: "notify" })).toEqual({ rerun: 4, kept: 2, effectsRepeated: 1 });
    expect(describeRecompute(plan, { phase: "build", step: "notify" })).toBe(
      "Recompute from “Notify the channel”: 4 steps run again, 2 earlier kept. 1 step that already acted outside may act again.",
    );
  });

  test("a plan without outside effects carries no warning", () => {
    expect(describeRecompute(plan, { phase: "ship" })).toBe("Recompute from “Ship”: 2 steps run again, 4 earlier kept.");
  });

  test("a phase starts at its first step; skipped steps count on neither side", () => {
    expect(recomputeImpact(plan, { phase: "prepare" })).toEqual({ rerun: 6, kept: 0, effectsRepeated: 1 });
    expect(recomputeImpact(plan, { phase: "ship" })).toEqual({ rerun: 2, kept: 4, effectsRepeated: 0 });
  });

  test("an unknown target affects nothing", () => {
    expect(recomputeImpact(plan, { phase: "nope" })).toEqual({ rerun: 0, kept: 0, effectsRepeated: 0 });
    expect(recomputeImpact(plan, { phase: "build", step: "nope" })).toEqual({ rerun: 0, kept: 0, effectsRepeated: 0 });
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
