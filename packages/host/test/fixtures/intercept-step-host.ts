// The host program for the intercept step.
//
// "An intercept that itself needs a call to the outside (asking
// a model which lessons apply) makes it as a step of the invocation that is calling the action.
// No transaction is held while it waits."
//
// The plugin declares one record type, Start, and two actions:
//
//   - "send"  — the action the guard is registered on; it blocks on the gate "g1";
//   - "look"  — the call to the outside the guard makes; it counts its calls.
//
// The guard of "send" calls "look" through `ctx.step`, the step function of the invocation that
// is calling "send". Outside an invocation there is no such step: the guard says so in the log
// and allows the call.
//
// The home directory comes from argv[2]. The test imports this file for the record type and the
// actions, so the host only starts when the file is run directly.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** The record the test writes: it wakes the handler. */
export const Start = record("interceptstep.start", z.object({}), { open: true });

/** The file the guard writes what it saw into. */
export const GUARD_LOG = "guard.log";

/** The home this program was started with. */
function home(): string {
  return process.argv[2] as string;
}

/** The actions of the plugin: they need the home, because they count and wait there. */
export function actionsOf(homePath: string) {
  // The call to the outside the guard makes. It counts its calls, so the test can tell one call
  // from a repeat.
  const look = stubAction("look", {
    home: homePath,
    input: z.object({ q: z.string() }),
    output: z.object({ answer: z.string() }),
    recovery: "repeat",
    effect: "write",
    result: (input) => ({ answer: `answer:${input.q}` }),
  });

  // The action the guard is registered on. It blocks on the gate, so the host can be killed
  // while the call to the outside is already recorded.
  const send = stubAction("send", {
    home: homePath,
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    recovery: "repeat",
    effect: "write",
    gate: "g1",
    result: (input) => ({ text: input.text }),
  });

  return { look, send };
}

/** The plugin of the intercept step. It needs the home: the stubs count and wait there. */
export function makePlugin(homePath: string) {
  const { look, send } = actionsOf(homePath);

  return plugin("interceptstep", (api) => {
    api.declare(Start);
    api.action(look);
    api.action(send);

    // The guard: it needs a call to the outside, so it makes it as a step of the invocation
    // that is calling the action.
    api.guard(send, async (_input, ctx) => {
      const step = ctx.step;
      appendFileSync(join(homePath, GUARD_LOG), `${step === undefined ? "outside" : "inside"}\n`);
      if (step === undefined) return;
      await step(look, { q: "lessons" });
    });

    // The handler: it calls the action the guard is registered on.
    api.on(Start, async (_data, step) => {
      await step(send, { text: "hello" }, { key: "k" });
    });
  });
}

if (import.meta.main) {
  const homeArg = process.argv[2];
  if (!homeArg) {
    console.error("usage: bun intercept-step-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home: homeArg });
  niwa.use(makePlugin(homeArg));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
