// The host program for the live test of a task through MCP.
//
// It serves the messages, sessions, tasks and requests modules. The sessions module is bound to
// two installations: the "mcode-test" harness, the one the executor of a task addresses, and the
// "claude-test" harness, the one the asker of the task talks through. The executor of the tasks
// module reaches the first installation by its id, so an assignment for "executor:mcode-test"
// starts a real MiniMax Code session.
//
// The sessions module is given niwa's own MCP server, so a session that may see niwa actions is
// given that server when it starts. The Claude Code session of the check sees niwa through it.
//
// The plugin "mcpask" declares one action, "mcpask.caller": it says who the caller is. The test reads it
// through the MCP surface, so it knows the address the transport bound the client to — the
// address the task reports to.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { action } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { messages } from "@niwa-labs/messages";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { tasks } from "@niwa-labs/tasks";
import { z } from "zod";

import { claudeCodeKind, claudeCodeSides } from "@niwa-labs/harness-claude";
import type { ClaudeCodeSessionControl } from "@niwa-labs/harness-claude";
import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation the executor of the check addresses. */
const HARNESS = harnessId("mcode-test");

/** The model the session runs on. */
const MODEL = "minimax/MiniMax-M3.1-Flash";

/** Where the installation keeps its sessions. */
const INSTALLATION_HOME = join(homedir(), ".minimax");

/** The kind of the installation: the mcode kind, bound to this home. */
const kind = mcode({ harness: HARNESS, home: INSTALLATION_HOME, control: { mode: "full", model: MODEL } });

/** The installation the sessions module serves. */
const instance: Harness = {
  id: HARNESS,
  kind: kind.kind,
  machine: machineId("machine-1"),
  home: INSTALLATION_HOME,
  sides: mcodeSides,
};

/** The id of the installation the asker of the check talks through. */
const ASKER_HARNESS = harnessId("claude-test");

/** The model the asker runs on. */
const ASKER_MODEL = "haiku";

/** Where the Claude Code installation keeps its sessions. */
const ASKER_HOME = join(homedir(), ".claude");

/** The kind of the asker's installation: the claude-code kind, bound to this home. */
const askerKind = claudeCodeKind({
  harness: ASKER_HARNESS,
  home: ASKER_HOME,
  control: {
    model: ASKER_MODEL,
    // The ACP adapter is a dependency of the package, not a program on the PATH.
    command: [join(import.meta.dir, "../../node_modules/.bin/claude-code-acp")],
  },
});

/** The installation the asker of the check talks through. */
const askerInstance: Harness = {
  id: ASKER_HARNESS,
  kind: askerKind.kind,
  machine: machineId("machine-1"),
  home: ASKER_HOME,
  sides: claudeCodeSides,
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

const askerControl = askerKind.control;
if (askerControl === undefined) {
  throw new Error("the claude-code kind has no control side");
}
if (!stoppable<ClaudeCodeSessionControl>(askerControl)) {
  throw new Error("the control side of the claude-code kind cannot stop what it started");
}

/** Who the caller is: the caller the core bound, not one a payload claims. */
const caller = action("mcpask.caller", {
  description: "Says who the caller is.",
  input: z.object({}),
  output: z.object({ caller: z.string(), kind: z.string() }),
  recovery: "repeat",
  effect: "write",
  run: async (_input, ctx) => ({
    caller: ctx.caller.kind === "client" ? ctx.caller.id : ctx.caller.kind,
    kind: ctx.caller.kind,
  }),
});

/** The plugin of the check: it holds the one action the test reads before it assigns. */
function b1Plugin() {
  return plugin("mcpask", (api) => {
    api.action(caller);
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun task-mcp-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(b1Plugin());
  niwa.use(messages());
  niwa.use(sessions({
    harnesses: [
      { instance, reading: kind.reading, control },
      { instance: askerInstance, reading: askerKind.reading, control: askerControl },
    ],
    // A session that may see niwa actions is given niwa's own server, with this home.
    niwaMcp: {
      command: "bun",
      args: [join(import.meta.dir, "../../bin/niwa.ts"), "--home", home, "mcp"],
    },
  }));
  niwa.use(tasks());
  niwa.use(requests());
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      await control.dispose();
      await askerControl.dispose();
      await niwa.close();
      process.exit(0);
    })();
  });
}
