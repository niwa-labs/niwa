// A step that names its action: the host resolves the name.
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. a step by name calls the action the host serves under it, and its answer is the value
//   2. a name nobody serves throws the typed UnknownAction to the code, and the invocation
//      pauses on the step even when the code swallows the error
//   3. `step.outcome` with a name nobody serves answers "failed" and still takes the step's key,
//      so the step after it keeps its own

import { expect, test } from "bun:test";

import { action, actionName, CORE_TYPES, record, seq, UnknownAction } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Trigger = record("sbn.trigger", z.object({ mode: z.enum(["found", "missing", "outcome"]) }));
const Result = record("sbn.result", z.object({ text: z.string() }));

const SERVED: ActionName = actionName("sbn.upper");
const MISSING: ActionName = actionName("sbn.nobody");

const upper = action("sbn.upper", {
  description: "Upper-cases a text.",
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  recovery: "repeat",
  run: async (input) => ({ text: input.text.toUpperCase() }),
});

const start = action("sbn.start", {
  description: "Writes the trigger.",
  input: z.object({ mode: z.enum(["found", "missing", "outcome"]) }),
  output: z.object({}),
  recovery: "repeat",
  run: async (input, ctx) => {
    await ctx.emit(Trigger, { mode: input.mode });
    return {};
  },
});

const caller = plugin("sbn", (api) => {
  api.declare(Trigger, Result);
  api.action(upper);
  api.action(start);
  api.on(Trigger, async (trigger, step) => {
    if (trigger.mode === "found") {
      const answer = await step<{ text: string }, { text: string }>(SERVED, { text: "done" });
      await step.emit(Result, { text: answer.text });
    } else if (trigger.mode === "missing") {
      try {
        await step(MISSING, {});
      } catch (error) {
        // The code swallows the error: the invocation still pauses.
        await step.emit(Result, { text: error instanceof UnknownAction ? error.action : "other" });
      }
    } else {
      const outcome = await step.outcome(MISSING, {});
      const after = await step<{ text: string }, { text: string }>(SERVED, { text: outcome.status });
      await step.emit(Result, { text: after.text });
    }
  });
});

async function recordsOf(niwa: Host, type: RecordTypeName): Promise<StoredRecord[]> {
  return niwa.records.read({ types: [type] });
}

async function run(mode: "found" | "missing" | "outcome", then: (niwa: Host) => Promise<void>) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(caller);
  await niwa.serve();
  try {
    await niwa.call(start, { mode });
    await then(niwa);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}

test("a step by name calls the action the host serves", async () => {
  await run("found", async (niwa) => {
    await eventually(async () => (await recordsOf(niwa, Result.name)).length === 1, 5_000, "the result");
    expect((await recordsOf(niwa, Result.name))[0]?.data).toEqual({ text: "DONE" });
  });
});

test("a name nobody serves is a typed error, and the invocation pauses on the step", async () => {
  await run("missing", async (niwa) => {
    await eventually(
      async () =>
        (await recordsOf(niwa, CORE_TYPES.invocationState)).some(
          (r) => (r.data as { state?: string }).state === "paused",
        ),
      5_000,
      "the invocation should pause",
    );
    const results = await recordsOf(niwa, Result.name);
    expect(results.map((r) => r.data)).toEqual([{ text: MISSING }]);
    const paused = (await recordsOf(niwa, CORE_TYPES.invocationState)).filter(
      (r) => (r.data as { state?: string }).state === "paused",
    );
    expect(JSON.stringify(paused[0]?.data)).toContain(MISSING);
  });
});

test("an outcome by an unserved name is failed, and the next step keeps its key", async () => {
  await run("outcome", async (niwa) => {
    await eventually(async () => (await recordsOf(niwa, Result.name)).length === 1, 5_000, "the result");
    expect((await recordsOf(niwa, Result.name))[0]?.data).toEqual({ text: "FAILED" });
    const intents = await recordsOf(niwa, CORE_TYPES.stepIntent);
    expect(intents.map((r) => (r.data as { key?: string }).key)).toEqual(["2"]);
  });
});
