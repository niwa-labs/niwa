// The host program for the scenario "one writer".
//
// "A second host on the same home is refused while the first lives.
// Kill the first without a clean shutdown; the second takes over. A stale holder that tries
// to write learns it has lost ownership and writes nothing."
//
// The plugin declares one record type, Start { n }, and a handler that steps through a gate:
//
//   await step(block, { n })     // parks inside a step until the gate is open
//   await step(finish, { n })    // what the host tries to write after the gate opens
//
// The gate is what the test uses to park the host in the middle of a step: the invocation
// holds the journal open while it waits, so the second host can be started against a live
// first host.
//
// The gate name and the plugin name come from the arguments, so two hosts on the same home do
// not share a gate: the host that is parked waits on its own gate, and the host that took the
// journal over waits on its own.
//
// The home directory comes from argv[2]. The test imports this file for the record types, so
// the host only starts when the file is run directly. The third argument is "takeover": the
// host takes the journal from a living holder when it is told to. The fourth is the gate name
// and the fifth is the plugin name.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** The external input that wakes the handler. */
export const Start = record("single-writer.start", z.object({ n: z.number() }), { open: true });

/**
 * A record nobody handles.
 *
 * The test writes one of these to find out which host holds the journal: a write that
 * succeeds means the writer is the new holder. It has no handler, so no invocation runs
 * and the journal holds nothing but the record itself.
 */
export const Probe = record("single-writer.probe", z.object({ n: z.number() }), { open: true });

/** The shape of the input of the actions. */
const N = z.object({ n: z.number() });

/** The shape of the output of the actions. */
const Ok = z.object({ ok: z.boolean() });

/**
 * The plugin of this scenario.
 *
 * It needs the home: the stubs count there. The gate and the plugin name are given, so two
 * hosts on the same home park on different gates and are told apart in the journal.
 */
export function makePlugin(home: string, gateName = "block", pluginName = "single-writer") {
  // The step the host is parked in: it waits for the gate.
  const block = stubAction("block", {
    home,
    input: N,
    output: Ok,
    recovery: "repeat",
    gate: gateName,
    result: () => ({ ok: true }),
  });

  // The step after the gate: the write that must fail after the take-over. Its
  // name carries the plugin name, so a client can tell which host is listening:
  // the description lists the actions of the host that answers.
  const finish = stubAction(`${pluginName}-finish`, {
    home,
    input: N,
    output: Ok,
    recovery: "repeat",
    result: () => ({ ok: true }),
  });

  return plugin(pluginName, (api) => {
    api.declare(Start, Probe);
    api.action(block);
    api.action(finish);
    api.on(Start, async (data, step) => {
      await step(block, { n: data.n });
      await step(finish, { n: data.n });
    });
  });
}
if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun single-writer-host.ts <home> [takeover] [gate] [plugin]");
    process.exit(2);
  }

  // The arguments after the home: "takeover" says that this host takes the
  // journal even from a living holder, and the gate and the plugin names tell
  // two hosts on the same home apart.
  const rest = process.argv.slice(3);
  const takeover = rest.includes("takeover");
  const names = rest.filter((argument) => argument !== "takeover");
  const gateName = names[0] ?? "block";
  const pluginName = names[1] ?? "single-writer";

  const niwa = createNiwa({ home, takeover });
  niwa.use(makePlugin(home, gateName, pluginName));
  // The handler is installed before the host listens: `ready()` answers as soon as the socket
  // does, and a SIGTERM in that gap would kill the process without a clean close.
  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
  await niwa.serve();
}
