// The host program for the web trace test.
//
// The plugin declares one record type, Start, and one result type, Done. The handler of Start
// writes a Done record with the step's own emit: the record belongs to the chain the handler was
// woken in, so the external input that started it is its cause.
//
// The home directory comes from argv[2].

import { record } from "@niwa-labs/core";
import { createNiwa, plugin } from "@niwa-labs/testing";
import { z } from "zod";

/** The external input: the test writes it, and the chain starts there. */
export const Start = record("why.start", z.object({ text: z.string() }), { open: true });

/** The result: what the handler produces, and what the trace page is opened for. */
export const Done = record("why.done", z.object({ text: z.string() }));

/** The plugin of this host. */
export function makePlugin() {
  return plugin("why", (api) => {
    api.declare(Start);
    api.declare(Done);
    api.on(Start, async (data, step) => {
      await step.emit(Done, { text: `done: ${data.text}` });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun why-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
