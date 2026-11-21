// The MCP surface of a session that may see only some actions.
//
// A real host process and the MCP surface linked to an SDK client over memory. The server is
// given a visible list: the tools it shows are only those the list names, and a tool it does
// not show is not a tool — calling it is refused by name.

import { expect, test } from "bun:test";

import { spawnHost, tempHome } from "@niwa-labs/testing";
import { jsonOf, mcpPair, textOf } from "./fixtures/mcp-pair.ts";

const HOST_SCRIPT = new URL("./fixtures/surface-host.ts", import.meta.url).pathname;

test("a session that may see some actions sees only those, and the others are unknown tools", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;

  try {
    await host.ready();
    pair = await mcpPair(home.path, ["surface.greet"]);

    // The tools are only the ones the list names.
    const names = (await pair.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(["surface_greet"]);

    // The tool that is there works.
    const greeted = await pair.client.callTool({ name: "surface_greet", arguments: { text: "hello" } });
    expect(greeted.isError).toBeFalsy();
    expect(jsonOf(greeted)).toEqual({ ok: true });

    // A tool that is not there is not a tool: the call is refused by name.
    const refused = await pair.client.callTool({ name: "surface_whoami", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("surface_whoami");

    // An observation tool is a tool only when it is named.
    const traced = await pair.client.callTool({ name: "niwa_trace", arguments: { id: "r_1" } });
    expect(traced.isError).toBe(true);
    expect(textOf(traced)).toContain("niwa_trace");
  } finally {
    await pair?.close();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("a session that may see an observation action sees it, and the other tools stay out", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;

  try {
    await host.ready();
    // The list names actions, so the observation action is named by its action name.
    pair = await mcpPair(home.path, ["surface.greet", "niwa.describe"]);

    const names = (await pair.client.listTools()).tools.map((tool) => tool.name);
    expect(names.sort()).toEqual(["surface_greet", "niwa_describe"]);

    const described = await pair.client.callTool({ name: "niwa_describe", arguments: {} });
    expect(described.isError).toBeFalsy();
  } finally {
    await pair?.close();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("a server with no visible list shows every action and every observation tool", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;

  try {
    await host.ready();
    pair = await mcpPair(home.path);

    const names = (await pair.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("surface_greet");
    expect(names).toContain("surface_whoami");
    expect(names).toContain("niwa_trace");
  } finally {
    await pair?.close();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
