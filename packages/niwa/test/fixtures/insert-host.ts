// The host program for the insert test.
//
// "Insert. A nested session spawned by the harness is linked to its parent.
// A session the owner opens by hand is registered at once with its exact id."
//
// The host installs the shared insert plugin, so it declares the action
// "insert.report" and writes the records of the insert.
//
// The test runs the hook scripts directly, with the JSON the harness would send them on stdin.

import { createNiwa } from "@niwa-labs/host";
import { insertPlugin } from "@niwa-labs/sessions";

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun insert-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(insertPlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
