// The host program for the tests of the generated surfaces and of the caller.
//
// "Declare a new action in a plugin. It appears as an MCP tool and as
// a CLI command with no change to either surface."
// "A payload that claims to come from someone else does not change who
// the caller is."
//
// The plugin declares two actions:
//
//   "surface.greet"     — greets, and says who the caller is
//   "surface.whoami"    — returns the caller the core bound to the call
//
// The second one is what the caller test reads: the action is given an argument that claims to be
// somebody else, and it answers with the caller the transport bound. The two must be the same
// person: the core binds the caller by the connection, never by a payload a model wrote
//.
//
// The control actions let the test change what the host declares:
//
//   "surface.add-action" — install a second plugin, which declares a new action
//
// The home directory comes from argv[2]. The test imports this file for the actions and the
// record types, so the host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import { z } from "zod";

/** A record type the plugin declares: the tool surface shows it in the description. */
export const Note = record("surface.note", z.object({ text: z.string() }), { open: true });

/** The shape of the input of the actions. */
const Text = z.object({ text: z.string() });

/** The shape of the output of the actions. */
const Ok = z.object({ ok: z.boolean() });

/** The shape of the input of the action that says who the caller is. */
const Who = z.object({
  /** What the payload claims the caller is. It is only an argument: it changes nothing. */
  caller: z.string().optional(),
});

/** The shape of the output of the action that says who the caller is. */
const Caller = z.object({
  /** The caller the core bound to the call. */
  caller: z.string(),
  /** The kind of caller: a client, a handler, or the host. */
  kind: z.string(),
});

/** The host this program runs. */
let host: Host | undefined;

/** Greets. */
export const greet = action("surface.greet", {
  description: "Greets the given text.",
  input: Text,
  output: Ok,
  recovery: "repeat",
  run: async () => ({ ok: true }),
});

/** Says who the caller is: the one the core bound, not the one the payload claims. */
export const whoami = action("surface.whoami", {
  description: "Says who the caller is.",
  input: Who,
  output: Caller,
  recovery: "repeat",
  run: async (_input, ctx) => ({
    caller: ctx.caller.kind === "client" ? ctx.caller.id : ctx.caller.kind,
    kind: ctx.caller.kind,
  }),
});

/**
 * A second plugin, installed by the control action.
 *
 * It declares an action of its own: after it is installed, that action is a tool of the MCP
 * surface, with no change to the surface.
 */
const extra = plugin("surface-extra", (api) => {
  api.declare(record("surface.extra", z.object({ text: z.string() })));
  api.action(
    action("surface.extra-ping", {
      description: "Answers with pong.",
      input: z.object({}),
      output: z.object({ pong: z.boolean() }),
      recovery: "repeat",
      run: async () => ({ pong: true }),
    }),
  );
});

/** Install the second plugin: its action appears on the surfaces. */
export const addAction = action("surface.add-action", {
  description: "Install a second plugin, which declares a new action.",
  input: z.object({}),
  output: Ok,
  recovery: "repeat",
  run: async () => {
    if (host === undefined) {
      throw new Error("surface.add-action: the host is not running");
    }
    host.use(extra);
    return { ok: true };
  },
});

/** The plugin of the checks. */
export function makePlugin() {
  // The action the handler steps through: a step is recorded, so the journal shows the call.
  const handled = action("surface.handled", {
    description: "Records that the message was handled.",
    input: Text,
    output: Ok,
    recovery: "repeat",
    run: async () => ({ ok: true }),
  });

  return plugin("surface", (api) => {
    api.declare(Note);
    api.action(greet);
    api.action(whoami);
    api.action(addAction);
    api.action(handled);
    // The handler of Note: it writes to the journal, so the CLI has records to read.
    api.on(Note, async (data, step) => {
      await step(handled, { text: data.text });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun surface-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  host = niwa;
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
