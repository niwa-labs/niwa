// The host program for the scenario "catching up".
//
// "Stop the host. Write records through a second, short-lived
// host or before the stop without the handler installed. Start with the handler.
// Each record is handled exactly once, in order."
//
// The plugin declares one record type, Item { n }, and one handler that calls the
// action "seen". The handler is installed or not, depending on the variant:
//
//   bun catch-up-host.ts <home> nohandler   — the type is declared, no handler is installed
//   bun catch-up-host.ts <home> handler     — the type is declared, the handler is installed
//
// The type is declared in both variants: a record of an undeclared type cannot be
// written at all, so the variant without a handler must still be able to receive
// the items it does not handle.
//
// The action "seen" is counted and returns its input, so the journal holds the
// number of the item it was called with: the order of the calls is visible in the
// records the core writes for the outcomes of the steps.
//
// The home directory comes from argv[2], the variant from argv[3]. The test imports
// this file for the record type, so the host only starts when the file is run
// directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** The item the handler handles. */
export const Item = record("catch-up.item", z.object({ n: z.number() }), { open: true });

/** The variants this program knows. */
export const VARIANTS = ["nohandler", "handler"] as const;

/** One of the variants. */
export type Variant = (typeof VARIANTS)[number];

/**
 * The plugin of this scenario.
 *
 * With `withHandler` the plugin handles Item and calls the action "seen" for it.
 * Without it the plugin only declares the type: the records it receives stay in
 * the journal, unhandled, until a host with the handler starts.
 */
export function makePlugin(home: string, withHandler: boolean) {
  // The work itself. Every call is counted, and the call carries the number of
  // the item, so the journal shows which item was handled and in what order.
  const seen = stubAction("seen", {
    home,
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    result: (input) => input,
  });

  return plugin("catch-up", (api) => {
    api.declare(Item);
    api.action(seen);

    if (withHandler) {
      // A new subscription starts where the journal is; this one asks for what was written before it.
      api.on(Item, { from: "start" }, async (data, step) => {
        await step(seen, { n: data.n });
      });
    }
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  const variant = process.argv[3];
  if (!home || variant === undefined) {
    console.error("usage: bun catch-up-host.ts <home> <nohandler|handler>");
    process.exit(2);
  }
  if (!VARIANTS.includes(variant as Variant)) {
    console.error(`usage: bun catch-up-host.ts <home> <nohandler|handler>: unknown variant "${variant}"`);
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home, variant === "handler"));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
