// The host program for the scenario "an action that waits inside itself is waiting, not cut off".
//
// The plugin declares two record types, one action and one handler:
//
//   on Start { n }  — call the action "waiter"
//   "waiter"        — an effect that must not be repeated (recovery "do-not-repeat"); it waits
//                     inside itself for Answer { n } and returns it
//
// The invocation suspends inside the action. After a restart the step is entered again as a
// waiting step: the recovery contract is for a call that was cut off, and this one was not.
//
// The home directory comes from argv[2]. The test imports this file for the record types, so the
// host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";

/** Wakes the handler. */
export const Start = record("action-wait-restart.start", z.object({ n: z.number() }), { open: true });

/** What the action waits for. */
export const Answer = record("action-wait-restart.answer", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. */
export function makePlugin() {
  const waiter = action("waiter", {
    description: "An effect that is not repeated and waits inside itself for its answer.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "do-not-repeat",
    async run(input, ctx) {
      return (await ctx.wait(Answer, { filter: { n: input.n } })).data;
    },
  });

  return plugin("action-wait-restart", (api) => {
    api.declare(Start, Answer);
    api.action(waiter);
    api.on(Start, async (data, step) => {
      await step(waiter, { n: data.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun action-wait-restart-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
