// The host program for the script bridge: workflow, timers, requests and the
// stub plugin, on the real clock. The home directory comes from argv[2].

import { WfNote, createNiwa, requests, stub, timers } from "@niwa-labs/testing";
import { workflow } from "../../src/index.ts";

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun bridge-host.ts <home>");
    process.exit(2);
  }
  const niwa = createNiwa({ home });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(stub(home));
  niwa.use(workflow({ emits: [WfNote] }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
