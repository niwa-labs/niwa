import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { spawnHost, tempHome } from "@niwa-labs/testing";

import { jsonOf, mcpPair } from "./fixtures/mcp-pair.ts";

const HOST = new URL("../../sessions/test/fixtures/restart-host.ts", import.meta.url).pathname;
const CLI = new URL("../bin/niwa.ts", import.meta.url).pathname;

async function cli(home: string, ...args: string[]): Promise<unknown> {
  const child = Bun.spawn([process.execPath, CLI, "--home", home, "--json", ...args], {
    env: { ...process.env, NIWA_ID: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

test("the generated CLI and MCP surfaces perform immediate and deferred turn waits", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST, home.path, ["--tracked"]);
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;
  const session = "fake-harness session-1";
  try {
    await host.ready();
    await cli(home.path, "session.start", "--harness", "fake-harness", "--prompt", "open");

    const now = await cli(home.path, "session.ask-and-wait", "--session", session, "--message", "instant CLI now");
    expect(now).toMatchObject({ result: { status: "completed", value: "CLI now" } });

    const later = await cli(home.path, "session.send", "--session", session, "--message", "instant CLI later", "--operation", "cli-later", "--track");
    expect(later).toMatchObject({ handle: { session, turn: 3, operation: "cli-later" } });
    expect(await cli(home.path, "session.turn-wait", "--session", session, "--operation", "cli-later", "--turn", "3", "--timeout-ms", "1000"))
      .toEqual({ status: "completed", value: "CLI later" });

    pair = await mcpPair(home.path);
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const result = await pair!.client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return jsonOf(result);
    };
    expect(await mcp("session_ask", {
      session, prompt: "legacy ask", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    })).toEqual({ value: { answer: "legacy" } });
    expect(await mcp("session_ask_and_wait", { session, message: "instant MCP now" }))
      .toMatchObject({ result: { status: "completed", value: "MCP now" } });
    const sent = await mcp("session_turn_send", { session, message: "instant MCP later" }) as { handle: Record<string, unknown> };
    expect(await mcp("session_turn_wait", sent.handle)).toEqual({ status: "completed", value: "MCP later" });
  } finally {
    await pair?.close();
    await host.stop();
    await home.cleanup();
  }
}, 20_000);

test("session.start answers the handle of the first turn: two CLI calls cover the question and its answer", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST, home.path, ["--tracked"]);
  try {
    await host.ready();
    const started = (await cli(home.path, "session.start", "--harness", "fake-harness", "--prompt", "open the shop", "--operation", "shop")) as {
      session: string; handle: { session: string; operation: string; turn?: number };
    };
    expect(started.handle).toEqual({ session: "fake-harness session-1", operation: "shop", turn: 1 });
    appendFileSync(join(home.path, "life.log"), "turn-started 1\nturn-ended 1 completed CLI shop answer\n");
    expect(await cli(home.path, "session.turn-wait", "--session", started.handle.session, "--operation", "shop", "--turn", "1", "--timeout-ms", "5000"))
      .toEqual({ status: "completed", value: "CLI shop answer" });
    expect(await cli(home.path, "session.turn-wait-many", "--handles", JSON.stringify([started.handle]), "--until", "all", "--timeout-ms", "5000"))
      .toEqual({
        done: [{ index: 0, handle: started.handle, result: { status: "completed", value: "CLI shop answer" } }],
        pending: [],
        timedOut: false,
      });
  } finally {
    await host.stop();
    await home.cleanup();
  }
}, 20_000);

/** A real `niwa mcp` over stdio: the tools it lists, and a tools/call that counts itself. */
async function stdioMcp(home: string): Promise<{
  listTools: () => Promise<Array<{ name: string }>>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  calls: string[];
  close(): Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "--home", home, "mcp"],
    env: { ...process.env, NIWA_ID: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "check", version: "0.1.0" });
  await client.connect(transport);
  const calls: string[] = [];
  return {
    listTools: async () => (await client.listTools()).tools,
    call: (name, args) => {
      calls.push(name);
      return client.callTool({ name, arguments: args }).then(jsonOf);
    },
    calls,
    close: () => client.close(),
  };
}

test("a real MCP server over stdio answers a started session's first turn in exactly two tools/call", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST, home.path, ["--tracked"]);
  let mcp: Awaited<ReturnType<typeof stdioMcp>> | undefined;
  try {
    await host.ready();
    mcp = await stdioMcp(home.path);
    expect((await mcp.listTools()).map((tool) => tool.name)).toContain("session_turn_wait_many");
    const started = await mcp.call("session_start", {
      harness: "fake-harness", prompt: "open over stdio", operation: "stdio-start",
    }) as { handle: { session: string; operation: string; turn?: number } };
    expect(started.handle).toEqual({ session: "fake-harness session-1", operation: "stdio-start", turn: 1 });
    appendFileSync(join(home.path, "life.log"), "turn-started 1\nturn-ended 1 completed MCP stdio answer\n");
    expect(await mcp.call("session_turn_wait", { ...started.handle, timeoutMs: 5000 }))
      .toEqual({ status: "completed", value: "MCP stdio answer" });
    expect(mcp.calls).toEqual(["session_start", "session_turn_wait"]);
  } finally {
    await mcp?.close();
    await host.stop();
    await home.cleanup();
  }
}, 30_000);

test("a real MCP server over stdio waits on a group of turns, first and all", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST, home.path, ["--tracked"]);
  let mcp: Awaited<ReturnType<typeof stdioMcp>> | undefined;
  try {
    await host.ready();
    mcp = await stdioMcp(home.path);
    const started = await mcp.call("session_start", {
      harness: "fake-harness", prompt: "first of the group", operation: "group-first",
    }) as { handle: Record<string, unknown> };
    const sent = await mcp.call("session_turn_send", {
      session: "fake-harness session-1", message: "second of the group", operation: "group-second",
    }) as { handle: Record<string, unknown> };
    const handles = [started.handle, sent.handle];
    appendFileSync(join(home.path, "life.log"), "turn-started 1\nturn-ended 1 completed group first\n");
    expect(await mcp.call("session_turn_wait_many", { handles, until: "first", timeoutMs: 5000 })).toEqual({
      done: [{ index: 0, handle: handles[0], result: { status: "completed", value: "group first" } }],
      pending: [{ index: 1, handle: handles[1] }],
      timedOut: false,
    });
    appendFileSync(join(home.path, "life.log"), "turn-started 2\nturn-ended 2 completed group second\n");
    expect(await mcp.call("session_turn_wait_many", { handles, until: "all", timeoutMs: 5000 })).toEqual({
      done: [
        { index: 0, handle: handles[0], result: { status: "completed", value: "group first" } },
        { index: 1, handle: handles[1], result: { status: "completed", value: "group second" } },
      ],
      pending: [],
      timedOut: false,
    });
    expect(mcp.calls).toEqual(["session_start", "session_turn_send", "session_turn_wait_many", "session_turn_wait_many"]);
  } finally {
    await mcp?.close();
    await host.stop();
    await home.cleanup();
  }
}, 30_000);
