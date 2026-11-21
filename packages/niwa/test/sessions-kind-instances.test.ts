// Several installations of one harness kind in one host, each bound by the kind to its own options.
//
// A kind is code and binds an installation (`kind.bind({ id, home, model, ... })`): the sides it gives
// are read from and started in that installation's own home, under its own id, on its own model. The
// default composition takes the registry of those installations, so `claude-haiku` and
// `claude-sonnet`, or two Codex installations with homes of their own, sit side by side.

import { expect, test } from "bun:test";

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import type { ActionName } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { HarnessInstanceRegistry, HarnessKindRegistry } from "@niwa-labs/harness";
import { claudeCodeKind } from "@niwa-labs/harness-claude";
import { codexKind, codexSides, writeCodexFixtures } from "@niwa-labs/harness-codex";
import { sessions } from "@niwa-labs/sessions";
import { openBoxes, tempHome } from "@niwa-labs/testing";

import { defaultComposition } from "../src/index.ts";

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

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input as never) as Promise<O>;

/** The registry of installations, checked against the kinds that bind them. */
function registry(): HarnessInstanceRegistry {
  const kinds = new HarnessKindRegistry();
  kinds.register(claudeCodeKind);
  kinds.register(codexKind);
  return new HarnessInstanceRegistry(kinds);
}

test("two installations of one kind start their sessions on their own models through the default composition", async () => {
  const home = await tempHome();
  try {
    const agent = join(home.path, "fake-acp");
    writeFileSync(agent, AGENT);
    chmodSync(agent, 0o755);
    const harnesses = registry();
    for (const [id, model] of [["claude-haiku", "haiku"], ["claude-sonnet", "sonnet"]] as const) {
      harnesses.register(
        claudeCodeKind.bind({ id, model, home: join(home.path, id), control: { command: [agent, join(home.path, `${id}.models`)] } }),
      );
    }

    const niwa = createNiwa({ home: join(home.path, "niwa") });
    niwa.use(...defaultComposition({ home: join(home.path, "niwa"), harnesses, sandbox: openBoxes() }));
    await niwa.serve();
    try {
      for (const harness of ["claude-haiku", "claude-sonnet"]) await call(niwa, "session.start", { harness, prompt: "hi" });
      // A start that names its own model still has it.
      await call(niwa, "session.start", { harness: "claude-haiku", prompt: "hi", model: "opus" });
    } finally {
      await niwa.close();
    }
    const modelsOf = (id: string) => readFileSync(join(home.path, `${id}.models`), "utf8").trim().split("\n");
    expect(modelsOf("claude-haiku")).toEqual(["haiku", "opus"]);
    expect(modelsOf("claude-sonnet")).toEqual(["sonnet"]);
  } finally {
    await home.cleanup();
  }
}, 30_000);

test("the history of each installation is read in its own home and named by its own id", async () => {
  const home = await tempHome();
  try {
    const luna = join(home.path, "codex-luna");
    const sol = join(home.path, "codex-sol");
    const lunaSession = (await writeCodexFixtures(luna, "running")).session.native;
    const solSession = (await writeCodexFixtures(sol, "compaction")).session.native;
    const harnesses = registry();
    harnesses.register(codexKind.bind({ id: "codex-luna", home: luna, model: "gpt-6-luna" }));
    harnesses.register(codexKind.bind({ id: "codex-sol", home: sol, model: "gpt-6.2-sol" }));

    const niwa = createNiwa({ home: join(home.path, "niwa") });
    niwa.use(...defaultComposition({ home: join(home.path, "niwa"), harnesses }));
    await niwa.serve();
    try {
      const listed = async (harness: string) =>
        (await call<{ sessions: Array<{ session: { harness: string; native: string } }> }>(niwa, "history.list", { harness })).sessions.map(
          (one) => `${one.session.harness} ${one.session.native}`,
        );
      expect(await listed("codex-luna")).toEqual([`codex-luna ${lunaSession}`]);
      expect(await listed("codex-sol")).toEqual([`codex-sol ${solSession}`]);
      const read = await call<{ records: unknown[] }>(niwa, "history.read", { session: { harness: "codex-sol", native: solSession } });
      expect(read.records.length).toBeGreaterThan(0);
    } finally {
      await niwa.close();
    }
  } finally {
    await home.cleanup();
  }
}, 30_000);

test("harness.list and harness.get show each installation with its kind, its model and what it can do", async () => {
  const home = await tempHome();
  try {
    const harnesses = registry();
    harnesses.register(codexKind.bind({ id: "codex-luna", home: join(home.path, "codex"), model: "gpt-6-luna" }));
    harnesses.register(codexKind.bind({ id: "codex-sol", home: join(home.path, "codex"), model: "gpt-6.2-sol", sides: { reading: { list: true, read: true, watch: false } } }));
    harnesses.register(claudeCodeKind.bind({ id: "claude-code", home: join(home.path, "claude") }));
    const niwa = createNiwa({ home: join(home.path, "niwa") });
    niwa.use(sessions({ harnesses }));
    await niwa.serve();
    try {
      const { items } = await call<{ items: Array<Record<string, unknown>> }>(niwa, "harness.list", {});
      expect(items.map(({ name, kind, model }) => ({ name, kind, model }))).toEqual([
        { name: "claude-code", kind: "claude-code", model: undefined },
        { name: "codex-luna", kind: "codex", model: "gpt-6-luna" },
        { name: "codex-sol", kind: "codex", model: "gpt-6.2-sol" },
      ]);
      expect(items[1]?.["capabilities"]).toEqual(codexSides);
      // What a machine showed narrows what an installation can do, and the list says so.
      expect(items[2]?.["capabilities"]).toEqual({ reading: { list: true, read: true, watch: false } });
      const sol = await call<Record<string, unknown>>(niwa, "harness.get", { name: "codex-sol" });
      expect(sol).toMatchObject({ name: "codex-sol", kind: "codex", model: "gpt-6.2-sol", machine: "local", block: "codex" });
      expect(sol["capabilities"]).toEqual({ reading: { list: true, read: true, watch: false } });
    } finally {
      await niwa.close();
    }
  } finally {
    await home.cleanup();
  }
}, 30_000);

test("one id is one installation: two bindings under it are refused before the plugin serves", () => {
  const twice = [codexKind.bind({ id: "codex", home: "/tmp/codex-a" }), codexKind.bind({ id: "codex", home: "/tmp/codex-b" })];
  expect(() => sessions({ harnesses: twice })).toThrow(/"codex" is bound twice/);
});
