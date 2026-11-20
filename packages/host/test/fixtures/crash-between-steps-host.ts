// The host program for the scenario "crash between steps".
//
// The plugin declares the record Start { n }. Its handler has two steps:
//
//   await step(a1, { n })   // a1 completes and its outcome is recorded
//   await step(a2, { n })   // a2 hits its counter, then blocks on the gate "g2"
//
// The test kills the host while a2 is blocked, so nothing about a2 is recorded.
// On restart the invocation resumes: step 1 replays from the recorded outcome
// (a1 is not called again) and step 2 is called again (a2 is called twice in
// total). The gate is opened by the test, so a2 finishes and the invocation
// ends as done.
//
// The home directory comes from argv[2]. The test imports this file for the
// Start record type, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

export const Start = record("crash-between-steps.start", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs the home: the stubs count and wait there. */
export function makePlugin(home: string) {
  const a1 = stubAction("a1", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    result: (input) => input.n,
  });

  const a2 = stubAction("a2", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    gate: "g2",
    result: (input) => input.n,
  });

  return plugin("crash-between-steps", (api) => {
    api.declare(Start);
    api.action(a1);
    api.action(a2);
    api.on(Start, async (data, step) => {
      await step(a1, { n: data.n });
      await step(a2, { n: data.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun crash-between-steps-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
