// The host program for the scenario "replay mismatch".
//
// The plugin declares the record Start { n }. Its handler has one step:
//
//   await step(effect, { n: stepInput })   // stepInput comes from argv[3]
//
// The number the step is called with comes from the third argument of the host, so the test can
// restart the host with a different number under the same step key.
//
// The scenario:
//
//   1. spawn the host with n = 7, connect a client, emit Start { n }
//   2. the handler calls the action "effect", which blocks on the gate "g1"
//   3. kill the host with SIGKILL — a real crash, in the middle of the call
//   4. spawn the host again with n = 9: the invocation resumes on the same record, but the
//      step is now called with a different input under the same key
//   5. the invocation pauses with a mismatch, and no second effect happens
//
// The home directory comes from argv[2], the step input from argv[3]. The test imports this
// file for the Start record type, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

export const Start = record("replay-mismatch.start", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs the home: the stub counts and waits there. */
export function makePlugin(home: string, stepInput: number) {
  const effect = stubAction("effect", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    effect: "write",
    gate: "g1",
    result: (input) => input.n,
  });

  return plugin("replay-mismatch", (api) => {
    api.declare(Start);
    api.action(effect);
    api.on(Start, async (_data, step) => {
      await step(effect, { n: stepInput });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  const stepInput = Number(process.argv[3]);
  if (!home || !Number.isFinite(stepInput)) {
    console.error("usage: bun replay-mismatch-host.ts <home> <step-input>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home, stepInput));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
