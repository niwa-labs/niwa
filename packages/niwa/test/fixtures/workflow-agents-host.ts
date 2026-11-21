// The host program for the live test of a workflow that calls agents.
//
// It serves the sessions module with one installation: the "mcode-test" harness, whose control
// side drives a real MiniMax Code session, and the workflow module, whose agent calls go to
// that installation.
//
// The installation answers natively (the mcode harness has structured output), so the answer of
// an agent call comes back as a value that passed the schema of the call.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { messages } from "@niwa-labs/messages";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { workflow } from "@niwa-labs/workflow";

import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation the sessions live on. */
const HARNESS = harnessId("mcode-test");

/** The model the sessions run on. */
const MODEL = "minimax/MiniMax-M3.1-Flash";

/** Where the installation keeps its sessions. */
const INSTALLATION_HOME = join(homedir(), ".minimax");

/** The kind of the installation: the mcode kind, bound to this home. */
const kind = mcode({ id: HARNESS, home: INSTALLATION_HOME, model: MODEL, control: { mode: "full", turnTimeoutMs: 600_000 } });

/** The installation the sessions module serves. */
const instance: Harness = {
  id: HARNESS,
  kind: kind.instance.kind,
  machine: machineId("machine-1"),
  home: INSTALLATION_HOME,
  sides: mcodeSides,
};

/** Does this control side stop what it started? */
function stoppable<T extends SessionControl & { dispose(): Promise<void> }>(
  control: SessionControl,
): control is T {
  return "dispose" in control;
}

const control = kind.control;
if (control === undefined) {
  throw new Error("the mcode kind has no control side");
}
if (!stoppable<McodeSessionControl>(control)) {
  throw new Error("the control side of the mcode kind cannot stop what it started");
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun workflow-agents-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(messages());
  niwa.use(requests());
  niwa.use(
    sessions({
      harnesses: [{ instance, reading: kind.reading, control }],
      // A session that may see niwa actions is given niwa's own server, with this home.
      niwaMcp: {
        command: "bun",
        args: [join(import.meta.dir, "../../bin/niwa.ts"), "--home", home, "mcp"],
      },
    }),
  );
  // The agent calls of a script go to the mcode installation: a script that names the harness
  // reaches the agents of that harness with no hand glue.
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      // Each part is stopped even when the one before it failed, and the process always exits.
      await control.dispose().catch(() => undefined);
      await niwa.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}
