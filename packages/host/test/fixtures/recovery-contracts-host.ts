// The host program for the scenario "the recovery contracts".
//
// The plugin declares the record Start { n }. Its handler has one step:
//
//   await step(effect, { n })   // effect hits its counter, then blocks on the gate "g1"
//
// The recovery contract of the action is chosen by the third argument: "repeat" or
// "repeat-with-key". The contract says what may be done after a call whose outcome is unknown:
//
//   repeat          — the action may be called again, with the same operation id
//   repeat-with-key — the action may be called again, with an operation id built from the
//                     same key, so the other side can dedupe it
//
// The test kills the host while the action is blocked, so the step has an intent and no
// outcome. On restart the contract decides: the action is called again and the invocation
// finishes. With "repeat-with-key" the operation id of the second call is the one of the first.
//
// The home directory comes from argv[2], the recovery contract from argv[3]. The test imports
// this file for the Start record type, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

export const Start = record("recovery-contracts.start", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs the home: the stub counts and waits there. */
export function makePlugin(home: string, recovery: "repeat" | "repeat-with-key") {
  const effect = stubAction("effect", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery,
    effect: "write",
    gate: "g1",
    // The operation id of every call is recorded, so the test can compare the first call with
    // the second one across the crash.
    operations: "effect",
    result: (input) => input.n,
  });

  const after = stubAction("after", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    effect: "write",
    result: (input) => input.n,
  });

  return plugin("recovery-contracts", (api) => {
    api.declare(Start);
    api.action(effect);
    api.action(after);
    api.on(Start, async (data, step) => {
      const value = await step(effect, { n: data.n });
      await step(after, { n: value });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  const recovery = process.argv[3];
  if (!home || (recovery !== "repeat" && recovery !== "repeat-with-key")) {
    console.error("usage: bun recovery-contracts-host.ts <home> <repeat|repeat-with-key>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home, recovery));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
