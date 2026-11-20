// The host program for the scenario "repeated write".
//
// The plugin declares one record type, Note { n }. Nothing is handled here: the
// check is about the write itself, so the record type only has to be declared
// for the host to accept it.
//
// The home directory comes from argv[2]. The test imports this file for the
// record type, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { z } from "zod";

/** The record the test writes. */
export const Note = record("repeated-write.note", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs no home: nothing of it counts effects. */
export function makePlugin() {
  return plugin("repeated-write", (api) => {
    api.declare(Note);
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun repeated-write-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
