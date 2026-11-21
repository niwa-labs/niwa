// The host program for the scenario "declared values".
//
// "A declared action appears in the self-description with its schemas.
// Writing a record of an undeclared type is rejected. Reading a record of an unknown type
// returns it with its raw data and runs no handler."
//
// The plugin declares one record type, Note { text }, an action, and a handler on Note:
// the handler counts, so the test can tell that it ran from that it did not.
//
// A second plugin, "declared-values-extra", declares the type declared-values.extra. It exists so the test can unload
// one plugin and leave a type that no plugin declares any more, with a record of it already in
// the journal.
//
// The control actions let the test unload the extra plugin through the public API:
//
//   "fixture.unload" — niwa.unload("declared-values-extra")
//
// The home directory comes from argv[2]. The test imports this file for the record types and
// the control action, so the host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** The record type the plugin declares. */
export const Note = record("declared-values.note", z.object({ text: z.string() }), { open: true });

/** The shape of the input of the actions. */
const Text = z.object({ text: z.string() });

/** The shape of the output of the actions. */
const Ok = z.object({ ok: z.boolean() });

/** The host this program runs. */
let host: Host | undefined;

/** The action the plugin declares: it shows up in the self-description. */
export const shout = action("declared-values.shout", {
  description: "Returns its input, upper-cased.",
  input: Text,
  output: Text,
  recovery: "do-not-repeat",
  effect: "write",
  run: async (input) => ({ text: input.text.toUpperCase() }),
});

/** Unload the extra plugin. Its declarations go; the records it wrote stay. */
export const unloadExtra = action("declared-values.unload-extra", {
  description: "Unload the plugin declared-values-extra.",
  input: z.object({}),
  output: Ok,
  recovery: "repeat",
  effect: "write",
  run: async () => {
    if (host === undefined) {
      throw new Error("declared-values.unload-extra: the host is not running");
    }
    host.unload("declared-values-extra" as never);
    return { ok: true };
  },
});

/** The plugin of this scenario. It needs the home: the stub counts there. */
export function makePlugin(home: string) {
  // The handler of Note: it counts, so the test knows it ran.
  const handle = stubAction("declared-values-handle", {
    home,
    input: Text,
    output: Ok,
    recovery: "repeat",
    effect: "write",
    result: () => ({ ok: true }),
  });

  return plugin("declared-values", (api) => {
    api.declare(Note);
    api.action(shout);
    api.action(handle);
    api.action(unloadExtra);
    api.on(Note, async (data, step) => {
      await step(handle, { text: data.text });
    });
  });
}

/** The extra plugin: when it is unloaded, no plugin declares declared-values.extra any more. */
export const extra = plugin("declared-values-extra", (api) => {
  api.declare(record("declared-values.extra", z.object({ text: z.string() }), { open: true }));
});

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun declared-values-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  host = niwa;
  niwa.use(makePlugin(home));
  niwa.use(extra);
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
