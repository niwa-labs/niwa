// The host program for the live test of a day's work.
//
// It serves the sessions module with two installations: the "mcode-test" harness, on the
// MiniMax Code model, and the "claude-test" harness, on haiku. It serves the workflow
// module with one "session.start.<harness>" action per harness, so `ask()` in a script
// reaches the named harness.
//
// The host supplies the enabled harnesses through the `harnesses` option.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";
import { workflow } from "@niwa-labs/workflow";

import { claudeCode, claudeCodeSides } from "@niwa-labs/harness-claude";
import type { ClaudeCodeSessionControl } from "@niwa-labs/harness-claude";
import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation the studies on MiniMax Code run in. */
const MCODE_HARNESS = harnessId("mcode-test");

/** The id of the installation the studies on Claude Code run in. */
const CLAUDE_HARNESS = harnessId("claude-test");

/** The model the MiniMax Code sessions run on. */
const MCODE_MODEL = "minimax/MiniMax-M3.1-Flash";

/** The model the Claude Code sessions run on. */
const CLAUDE_MODEL = "haiku";

/** Where the MiniMax Code installation keeps its sessions. */
const MCODE_HOME = join(homedir(), ".minimax");

/** Where the Claude Code installation keeps its sessions. */
const CLAUDE_HOME = join(homedir(), ".claude");

/** The MiniMax Code installation the studies run in. */
const mcodeKind = mcode({
  id: MCODE_HARNESS,
  home: MCODE_HOME,
  model: MCODE_MODEL,
  control: { mode: "full" },
});

const mcodeInstance: Harness = {
  id: MCODE_HARNESS,
  kind: mcodeKind.instance.kind,
  machine: machineId("machine-1"),
  home: MCODE_HOME,
  sides: mcodeSides,
};

/** The Claude Code installation the studies run in. */
const claudeKind = claudeCode({
  id: CLAUDE_HARNESS,
  home: CLAUDE_HOME,
  model: CLAUDE_MODEL,
  control: {
    // The ACP adapter is a dependency of the package, not a program on the PATH.
    command: [join(import.meta.dir, "../../node_modules/.bin/claude-code-acp")],
  },
});

const claudeInstance: Harness = {
  id: CLAUDE_HARNESS,
  kind: claudeKind.instance.kind,
  machine: machineId("machine-1"),
  home: CLAUDE_HOME,
  sides: claudeCodeSides,
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
    console.error("usage: bun day-host.ts <home>");
    process.exit(2);
  }

  const mcodeControl = mcodeKind.control;
  if (mcodeControl === undefined) throw new Error("the mcode kind has no control side");
  if (!stoppable<McodeSessionControl>(mcodeControl)) {
    throw new Error("the control side of the mcode kind cannot stop what it started");
  }
  const claudeControl = claudeKind.control;
  if (claudeControl === undefined) throw new Error("the claude-code kind has no control side");
  if (!stoppable<ClaudeCodeSessionControl>(claudeControl)) {
    throw new Error("the control side of the claude-code kind cannot stop what it started");
  }

  const niwa = createNiwa({ home });
  niwa.use(
    sessions({
      harnesses: [
        { instance: mcodeInstance, reading: mcodeKind.reading, control: mcodeControl },
        { instance: claudeInstance, reading: claudeKind.reading, control: claudeControl },
      ],
    }),
  );
  niwa.use(
    workflow({ harnesses: [MCODE_HARNESS, CLAUDE_HARNESS] }),
  );
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      await mcodeControl.dispose();
      await claudeControl.dispose();
      await niwa.close();
      process.exit(0);
    })();
  });
}
