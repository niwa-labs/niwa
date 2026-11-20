// The host program for the scenario "client".
//
// The plugin declares the record Note { n } and the action "echo", which
// returns its input. The test calls the action to show that a client can call
// an action of the host, and writes the record to put notes into the journal,
// where another client reads them back.
//
// The home directory comes from argv[2]. The test imports this file for the
// Note record type and for the echo action, so the host only starts when the
// file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";

/** The record the clients write and read. */
export const Note = record("client.note", z.object({ n: z.number() }), { open: true });

/** The action a client calls: it returns its input, unchanged. */
export const echo = action("echo", {
  description: "Returns its input.",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  recovery: "repeat",
  run: async (input) => input,
});

/** The plugin of this scenario. It needs no home: nothing of it counts effects. */
export function makePlugin() {
  return plugin("client", (api) => {
    api.declare(Note);
    api.action(echo);
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun client-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
