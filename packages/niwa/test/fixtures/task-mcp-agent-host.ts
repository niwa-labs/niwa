// The host program for the live test of a task through MCP, asked by a real mcode session.
//
// It is the mirror of the test of a task through MCP with a Claude Code asker, with the asker being a real MiniMax Code session
// instead of a Claude Code one: the asker is started by niwa with niwa's own MCP server, so it
// sees niwa through that server and creates the task through it.
//
// The sessions module is bound to two installations: the "mcode-executor" harness, the one the
// executor of the task addresses, and the "mcode-asker" harness, the one the asker of the task
// talks through. The executor of the tasks module reaches the first installation by its id, so
// an assignment for "executor:mcode-executor" starts a real MiniMax Code session.
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
import { tasks } from "@niwa-labs/tasks";

import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation the executor of the task addresses. */
const EXECUTOR_HARNESS = harnessId("mcode-executor");

/** The id of the installation the asker of the task talks through. */
const ASKER_HARNESS = harnessId("mcode-asker");

/** The model the sessions run on. */
const MODEL = "minimax/MiniMax-M3.1-Flash";

/** Where the installation keeps its sessions. */
const INSTALLATION_HOME = join(homedir(), ".minimax");

/** The kind of the executor installation: the mcode kind, bound to this home. */
const executorKind = mcode({
  id: EXECUTOR_HARNESS,
  home: INSTALLATION_HOME,
  model: MODEL,
  control: { mode: "full", turnTimeoutMs: 600_000 },
});

/** The installation the executor of the task addresses. */
const executorInstance: Harness = {
  id: EXECUTOR_HARNESS,
  kind: executorKind.instance.kind,
  machine: machineId("machine-1"),
  home: INSTALLATION_HOME,
  sides: mcodeSides,
};

/** The kind of the asker installation: the mcode kind, bound to this home. */
const askerKind = mcode({
  id: ASKER_HARNESS,
  home: INSTALLATION_HOME,
  model: MODEL,
  control: { mode: "full", turnTimeoutMs: 600_000 },
});

/** The installation the asker of the task talks through. */
const askerInstance: Harness = {
  id: ASKER_HARNESS,
  kind: askerKind.instance.kind,
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

const executorControl = executorKind.control;
if (executorControl === undefined) {
  throw new Error("the mcode kind has no control side");
}
if (!stoppable<McodeSessionControl>(executorControl)) {
  throw new Error("the control side of the mcode kind cannot stop what it started");
}

const askerControl = askerKind.control;
if (askerControl === undefined) {
  throw new Error("the mcode kind has no control side");
}
if (!stoppable<McodeSessionControl>(askerControl)) {
  throw new Error("the control side of the mcode kind cannot stop what it started");
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun task-mcp-agent-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(messages());
  niwa.use(requests());
  niwa.use(
    sessions({
      harnesses: [
        { instance: executorInstance, reading: executorKind.reading, control: executorControl },
        { instance: askerInstance, reading: askerKind.reading, control: askerControl },
      ],
      // A session that may see niwa actions is given niwa's own server, with this home.
      niwaMcp: {
        command: "bun",
        args: [join(import.meta.dir, "../../bin/niwa.ts"), "--home", home, "mcp"],
      },
    }),
  );
  niwa.use(tasks());
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      // Each part is stopped even when the one before it failed, and the process always exits.
      await executorControl.dispose().catch(() => undefined);
      await askerControl.dispose().catch(() => undefined);
      await niwa.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}
