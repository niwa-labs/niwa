// `niwa agent attach [<agent>]` from inside a native session: the harness and the session come from the
// environment, mcode's from --session or its latest session in the directory once confirmed, and a command
// that cannot tell its session is refused with why.

import { afterEach, expect, test } from "bun:test";

import { run } from "@niwa-labs/cli";
import type { CliArgs } from "@niwa-labs/cli";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading } from "@niwa-labs/harness";
import { ownerTokenOf } from "@niwa-labs/testing";

import { HARNESS, KIND, agentHost, dataOf } from "./fixtures/agent-host.ts";
import type { AgentHost } from "./fixtures/agent-host.ts";

const open: AgentHost[] = [];
afterEach(async () => {
  for (const host of open.splice(0)) await host.close();
});

const RIN = { name: "rin", harness: HARNESS, prompt: "You keep the owner's work in order." };

/** An mcode installation whose reading side lists two sessions of /work, the later one first. */
const mcode: Harness = { id: harnessId("mcode"), kind: harnessKind("mcode"), machine: machineId("m"), home: "/tmp/mcode", sides: { reading: { list: true, read: true, watch: false } } };
const mcodeReading: SessionReading = {
  async *list() {
    yield { id: sessionId(harnessId("mcode"), "older"), cwd: "/work", title: "the older one", updatedAt: 1_000 as never };
    yield { id: sessionId(harnessId("mcode"), "latest"), cwd: "/work", title: "the latest one", updatedAt: 2_000 as never };
  },
  async *read() {},
  raw: async () => undefined,
  rawSchema: { parse: (value: unknown) => value } as never,
  coverage: async () => ({ status: "not-scanned" }),
};

async function served(): Promise<AgentHost> {
  const host = await agentHost({ agents: [RIN], default: "rin" }, { harnesses: [{ instance: mcode, reading: mcodeReading }] });
  open.push(host);
  return host;
}

function attach(host: AgentHost, args: string[], env: Record<string, string>, json = false) {
  const cli: CliArgs = { home: host.home, token: ownerTokenOf(host.home), command: "agent", args: ["attach", ...args], json, env, cwd: "/work" };
  return run(cli, () => {});
}

test("the session the environment names is attached to the agent, and the briefing is printed", async () => {
  const host = await served();
  const result = await attach(host, [], { CLAUDE_CODE_SESSION_ID: "ext-1" });
  // The test host's harness is not Claude Code: the kind is refused by the host, with why.
  expect(result.code).toBe(1);
  expect(result.output).toContain('no harness of the kind "claude-code"');

  const named = await attach(host, ["rin", "--harness", HARNESS, "--session", "ext-1"], {});
  expect(named.code).toBe(0);
  expect(named.output).toContain("Agent rin (agent:rin)");
  expect(dataOf(await host.records(), "agent.attached")).toEqual([{ agent: "rin", session: `${HARNESS} ext-1`, cwd: "/work" }]);
});

test("a command that cannot tell its session is refused with what it looked for", async () => {
  const host = await agentHost({ agents: [RIN], default: "rin" });
  open.push(host);
  const result = await attach(host, [], {});
  expect(result.code).toBe(1);
  expect(result.output).toContain("ZCODE_SESSION_ID");
  expect(result.output).toContain("--session");
  expect(dataOf(await host.records(), "agent.attached")).toEqual([]);
});

test("under mcode the latest session of the directory is attached only once confirmed, or the one --session names", async () => {
  const host = await served();
  const unconfirmed = await attach(host, [], {});
  expect(unconfirmed.code).toBe(1);
  expect(unconfirmed.output).toContain("mcode latest");
  expect(unconfirmed.output).toContain("--yes");
  expect(dataOf(await host.records(), "agent.attached")).toEqual([]);

  const confirmed = await attach(host, ["--yes"], {});
  expect(confirmed.code).toBe(0);
  const named = await attach(host, ["--session", "older"], {}, true);
  expect(named.code).toBe(0);
  expect(JSON.parse(named.output)).toMatchObject({ agent: "rin", session: "mcode older" });
  expect(dataOf(await host.records(), "agent.attached")).toEqual([
    { agent: "rin", session: "mcode latest", cwd: "/work" },
    { agent: "rin", session: "mcode older", cwd: "/work" },
  ]);
});
