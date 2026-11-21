// The host program for the action-step check (an action may call another action as a step).
//
// The plugin declares one record type, four actions and one handler:
//
//   on Start { n }  — the handler calls the action the mode names
//   "outer"         — calls the action "inner" through ctx.step, by name, and returns its answer
//   "inner"         — an effect that counts its calls and returns a fixed result
//   "missing"       — calls a name nobody serves
//   "outcome"       — asks for the outcome of a name nobody serves
//
// The inner call is a step of the same invocation, under the key of the step that made it.
// The recovery contract of "inner" comes from the third argument: "repeat" or "do-not-repeat".
//
// The gates: "g-inner" holds the nested call, and "g-outer" holds the action after it, so a
// test can cut the run off at either point.
//
// The home directory comes from argv[2], the recovery contract from argv[3]. The test imports
// this file for the record types, so the host only starts when the file is run directly.

import { action, actionName, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName } from "@niwa-labs/core";
import { counter, gate, stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler. */
export const Start = record("action-step.start", z.object({ n: z.number(), mode: z.string().optional() }), { open: true });

/** What the outer action wrote down: the answer the inner call gave. */
export const Answered = record("action-step.answered", z.object({ n: z.number() }));

/** The name the inner action is called by: the contract between two modules. */
export const INNER: ActionName = actionName("inner");

/** A name nobody serves: the nested call to it cannot be made. */
export const NOBODY: ActionName = actionName("nobody");

/** The plugin of the action-step check. It needs the home: the stub counts there. */
export function makePlugin(home: string, recovery: "repeat" | "do-not-repeat") {
  // The inner action waits on a gate, so a test can cut the call off in the middle of it:
  // the gate is closed when the host is killed, and opened when the call may finish.
  const inner = stubAction("inner", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery,
    effect: "write",
    gate: "g-inner",
    result: (input) => input.n,
  });

  const outer = action("outer", {
    description: "Calls another action as a step of its own, by name.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    effect: "write",
    async run(input, ctx) {
      // The nested call: it is a step of the invocation this action runs in.
      const value = await ctx.step(INNER, { n: input.n });
      // The gate holds the action after the nested call, so a test can cut the run off in the
      // window between the nested call's outcome and the end of this action.
      await gate(home, "g-outer").wait();
      return { n: value };
    },
  });

  // An action that calls a name nobody serves: the call is a failed step, and the invocation
  // pauses on it even when the code catches the error.
  const missing = action("missing", {
    description: "Calls an action nobody serves.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    effect: "write",
    async run(input, ctx) {
      try {
        await ctx.step(NOBODY, { n: input.n });
      } catch {
        // The code swallows the error: the invocation still pauses.
      }
      return { n: input.n };
    },
  });

  // An action that asks for the outcome of a name nobody serves: the answer is "failed", and
  // the nested step still takes its key.
  const outcome = action("outcome", {
    description: "Asks for the outcome of an action nobody serves.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    effect: "write",
    async run(input, ctx) {
      const answer = await ctx.step.outcome(NOBODY, { n: input.n });
      return { n: answer.status === "failed" ? input.n : -1 };
    },
  });

  // An action that always fails, and an action that must not be repeated and calls it: the
  // nested step fails, the invocation pauses on it, and the owner's answer is about that step.
  const boom = action("boom", {
    description: "Fails every time it is called.",
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    effect: "write",
    async run() {
      counter(home, "boom").hit();
      throw new Error("boom");
    },
  });

  const careful = action("careful", {
    description: "Must not be repeated; calls an action that fails.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "do-not-repeat",
    effect: "write",
    async run(input, ctx) {
      return { n: await ctx.step(actionName("boom"), { n: input.n }) };
    },
  });

  return plugin("action-step", (api) => {
    api.declare(Start, Answered);
    api.action(inner);
    api.action(outer);
    api.action(missing);
    api.action(outcome);
    api.action(boom);
    api.action(careful);
    api.on(Start, async (data, step) => {
      // The mode says which action the handler calls: "outer" calls "inner", "missing" calls
      // a name nobody serves, and "outcome" asks for the outcome of such a name.
      const target =
        data.mode === "missing"
          ? missing
          : data.mode === "outcome"
            ? outcome
            : data.mode === "careful"
              ? careful
              : outer;
      const answer = await step(target, { n: data.n });
      await step.emit(Answered, { n: answer.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  const recovery = process.argv[3];
  if (!home || (recovery !== "repeat" && recovery !== "do-not-repeat")) {
    console.error("usage: bun action-step-host.ts <home> <repeat|do-not-repeat>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home, recovery));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
