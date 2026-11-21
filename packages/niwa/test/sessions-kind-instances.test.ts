// Two installations of one kind in one host, each with its own control options.
//
// A kind registry resolves the sides by kind, so one kind has one control side. Two instances of
// Claude Code that differ in the model are bound by hand: each binding carries the sides of its
// own `claudeCode(...)`, and a session starts on the model of the instance it was started on.

import { expect, test } from "bun:test";

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";
import { claudeCode, claudeCodeSides } from "@niwa-labs/harness-claude";
import { sessions } from "@niwa-labs/sessions";
import { tempDirSync } from "@niwa-labs/testing";

/** A fake ACP adapter that records every model it is told to use, under the name it was given. */
const AGENT = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = process.argv[2];
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.method === "initialize") out({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (frame.method === "session/new") out({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s-" + process.pid, modes: { currentModeId: "default", availableModes: [] }, models: { currentModelId: "default", availableModels: [] }, configOptions: [] } });
    else if (frame.method === "session/set_model") { appendFileSync(log, frame.params.modelId + "\\n"); out({ jsonrpc: "2.0", id: frame.id, result: {} }); }
    else if (frame.method === "session/set_mode") out({ jsonrpc: "2.0", id: frame.id, result: {} });
    else if (frame.method === "session/prompt") {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-" + process.pid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      out({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
    }
  }
}
`;

test("two instances of one kind start their sessions on their own models", async () => {
  const home = tempDirSync("kind-instances");
  const agent = join(home, "fake-acp");
  writeFileSync(agent, AGENT);
  chmodSync(agent, 0o755);

  const bind = (id: string, model: string) => {
    const kind = claudeCode({
      harness: harnessId(id),
      home: join(home, id),
      control: { model, command: [agent, join(home, `${id}.models`)] },
    });
    const instance: Harness = {
      id: harnessId(id),
      kind: kind.kind,
      machine: machineId("machine-1"),
      home: join(home, id),
      sides: claudeCodeSides,
    };
    return { instance, reading: kind.reading, control: kind.control };
  };

  const niwa = createNiwa({ home: join(home, "niwa") });
  niwa.use(sessions({ harnesses: [bind("claude-haiku", "haiku"), bind("claude-sonnet", "sonnet")] }));
  await niwa.serve();
  try {
    for (const harness of ["claude-haiku", "claude-sonnet"]) {
      await niwa.call("session.start" as ActionName, { harness, prompt: "hi" } as never);
    }
    const modelsOf = (id: string) => readFileSync(join(home, `${id}.models`), "utf8").trim().split("\n");
    expect(modelsOf("claude-haiku")).toEqual(["haiku"]);
    expect(modelsOf("claude-sonnet")).toEqual(["sonnet"]);
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
