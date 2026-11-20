// The host program for the scenario "a call that must not be repeated".
//
// The plugin declares the record Start { n }. Its handler has one step:
//
//   await step(effect, { n })   // effect hits its counter, then blocks on the gate "g1"
//
// The action has the "do-not-repeat" recovery contract: after a call whose outcome is unknown,
// the effect may have happened, so the action must not be called again on its own.
//
// The test kills the host while the action is blocked, so the step has an intent and no
// outcome: the call was cut off. On restart the outcome is unknown, the invocation pauses, and
// the pause offers the owner three choices: retry, skip, cancel.
//
// The test then calls "niwa.invocation.resolve" over the client:
//
//   retry — the step is called again, as a new attempt
//   skip  — the step is not called again, the code continues
//
// The home directory comes from argv[2]. The test imports this file for the Start record
// type, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

export const Start = record("no-repeat-crash.start", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs the home: the stub counts and waits there. */
export function makePlugin(home: string) {
  // The effect that must not be repeated.
  const effect = stubAction("effect", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "do-not-repeat",
    gate: "g1",
    result: (input) => input.n,
  });

  // What the handler does after the step, so a test can see the code continued.
  const after = stubAction("after", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    result: (input) => input.n,
  });

  return plugin("no-repeat-crash", (api) => {
    api.declare(Start);
    api.action(effect);
    api.action(after);
    api.on(Start, async (data, step) => {
      const value = await step(effect, { n: data.n });
      // A skipped step gives no value: the code continues without it.
      await step(after, { n: value ?? -1 });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun no-repeat-crash-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
