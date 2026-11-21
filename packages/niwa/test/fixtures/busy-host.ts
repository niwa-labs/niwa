// The host program for the live test of sending to a busy session.
//
// It serves the sessions module with the "codex-test" installation, whose control side starts
// sessions, sends into them and says what became of the message.
//
// The plugin "busy" declares the action "busy.hold": it starts a session with a long prompt and
// keeps the turn running, so a second message has a busy session to wait behind.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";

import { codex, codexSides } from "@niwa-labs/harness-codex";
import type { CodexSessionControl } from "@niwa-labs/harness-codex";

/** The id of the installation the sessions run in. */
const HARNESS = harnessId("codex-test");

/** The model the sessions run on. */
const MODEL = "gpt-6-luna";

/** Where the codex installation keeps its sessions. */
const HOME = join(homedir(), ".codex");

/** The kind of the codex installation. */
const kind = codex({ harness: HARNESS, home: HOME, control: { model: MODEL } });

/** The installation the sessions module serves. */
const instance: Harness = {
  id: HARNESS,
  kind: kind.kind,
  machine: machineId("machine-1"),
  home: HOME,
  sides: codexSides,
};

/** Does this control side stop what it started? */
function stoppable<T extends SessionControl & { dispose(): Promise<void> }>(
  control: SessionControl,
): control is T {
  return "dispose" in control;
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun busy-host.ts <home>");
    process.exit(2);
  }

  const control = kind.control;
  if (control === undefined) throw new Error("the codex kind has no control side");
  if (!stoppable<CodexSessionControl>(control)) {
    throw new Error("the control side of the codex kind cannot stop what it started");
  }

  const niwa = createNiwa({ home });
  niwa.use(
    sessions({
      harnesses: [{ instance, reading: kind.reading, control }],
    }),
  );
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      await control.dispose();
      await niwa.close();
      process.exit(0);
    })();
  });
}
