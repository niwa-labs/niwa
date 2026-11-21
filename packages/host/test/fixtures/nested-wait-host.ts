// The host program for the nested-wait check (a wait inside a nested call is waiting, not cut off).
//
// The plugin declares three record types, five actions and one handler:
//
//   on Start { n, mode } — call "top" (a chain three calls deep) or "after" (a wait, then a call)
//   "top"    -> "middle" -> "waiter"   each do-not-repeat
//   "waiter"                           waits inside itself for Answer { n }
//   "after"  -> "waiter", then "slow"  a repeatable action whose second call is cut off on a gate
//
// After a restart the chain is entered again as waiting: no call of it is judged by its recovery
// contract while the wait inside the deepest one is pending.
//
// The home directory comes from argv[2]. The test imports this file for the record types, so the
// host only starts when the file is run directly.

import { action, actionName, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler. */
export const Start = record("nested-wait.start", z.object({ n: z.number(), mode: z.enum(["top", "after"]) }), { open: true });

/** What the waiter waits for. */
export const Answer = record("nested-wait.answer", z.object({ n: z.number() }), { open: true });

/** What the handler wrote down when the chain ended. */
export const Done = record("nested-wait.done", z.object({ n: z.number() }));

const Input = z.object({ n: z.number() });
const Output = z.object({ n: z.number() });

/** The plugin of the nested-wait check. It needs the home: the counters live there. */
export function makePlugin(home: string) {
  const waiter = action("waiter", {
    description: "A call that is not repeated if cut off and waits inside itself for its answer.",
    input: Input,
    output: Output,
    recovery: "do-not-repeat",
    effect: "write",
    async run(input, ctx) {
      return (await ctx.wait(Answer, { filter: { n: input.n } })).data;
    },
  });

  const middle = action("middle", {
    description: "A call that is not repeated if cut off and calls the waiter.",
    input: Input,
    output: Output,
    recovery: "do-not-repeat",
    effect: "write",
    async run(input, ctx) {
      return ctx.step(actionName("waiter"), input);
    },
  });

  const top = action("top", {
    description: "A call that is not repeated if cut off and calls the middle one.",
    input: Input,
    output: Output,
    recovery: "do-not-repeat",
    effect: "write",
    async run(input, ctx) {
      return ctx.step(actionName("middle"), input);
    },
  });

  // Cut off on its gate, and it must not be repeated.
  const slow = stubAction("slow", {
    home,
    input: Input,
    output: z.number(),
    recovery: "do-not-repeat",
    effect: "write",
    gate: "g-slow",
    result: (input) => input.n,
  });

  const after = action("after", {
    description: "Calls the waiter, and after its answer calls an action that is cut off.",
    input: Input,
    output: Output,
    recovery: "repeat",
    effect: "write",
    async run(input, ctx) {
      await ctx.step(actionName("waiter"), input);
      return { n: await ctx.step(actionName("slow"), input) };
    },
  });

  return plugin("nested-wait", (api) => {
    api.declare(Start, Answer, Done);
    api.action(waiter);
    api.action(middle);
    api.action(top);
    api.action(slow);
    api.action(after);
    api.on(Start, async (data, step) => {
      const answer = await step(data.mode === "top" ? top : after, { n: data.n });
      await step.emit(Done, { n: answer.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun nested-wait-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
