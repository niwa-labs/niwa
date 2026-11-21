// The extension that gives a pi session niwa's tools: it registers, as MCP servers of pi, the
// servers the process was given, and every one of them is directly callable by the model.

import { afterEach, expect, test } from "bun:test";

import niwaPiTools, { PI_MCP_SERVERS_ENV, decodeServers, encodeServers, piToolPattern } from "../src/mcp/index.ts";
import type { PiMcpApi, PiMcpServerConfig } from "../src/mcp/index.ts";

const was = process.env[PI_MCP_SERVERS_ENV];
afterEach(() => {
  if (was === undefined) delete process.env[PI_MCP_SERVERS_ENV];
  else process.env[PI_MCP_SERVERS_ENV] = was;
});

/** What pi does with an extension: it hands it an API, and the extension registers. */
function load(): Array<{ name: string; config: PiMcpServerConfig }> {
  const registered: Array<{ name: string; config: PiMcpServerConfig }> = [];
  const api: PiMcpApi = { registerMcpServer: (name, config) => void registered.push({ name, config }) };
  niwaPiTools(api);
  return registered;
}

const niwa = { name: "niwa", command: "/usr/bin/bun", args: ["/opt/niwa/bin/niwa.ts", "--home", "/h", "mcp"], env: { NIWA_ID: "tok", NIWA_VISIBLE: "task.create,session.send" } };

test("a server the process was given is registered with pi under its own name, callable directly", () => {
  process.env[PI_MCP_SERVERS_ENV] = encodeServers([niwa]);
  expect(load()).toEqual([
    { name: "niwa", config: { command: niwa.command, args: niwa.args, env: niwa.env, exposure: "direct" } },
  ]);
});

test("a process that was given no server registers nothing", () => {
  delete process.env[PI_MCP_SERVERS_ENV];
  expect(load()).toEqual([]);
  process.env[PI_MCP_SERVERS_ENV] = "";
  expect(load()).toEqual([]);
});

test("servers that do not read back are an error of the extension, not a session without tools", () => {
  process.env[PI_MCP_SERVERS_ENV] = "not json";
  expect(() => load()).toThrow();
  process.env[PI_MCP_SERVERS_ENV] = JSON.stringify([{ name: "niwa" }]);
  expect(() => load()).toThrow();
});

test("the servers go through the environment and come back as they went", () => {
  expect(decodeServers(encodeServers([niwa]))).toEqual([niwa]);
});

test("pi names the tools of a server mcp__<server>__<tool>, with every other character of the server a `_`", () => {
  expect(piToolPattern("niwa")).toBe("mcp__niwa__*");
  expect(piToolPattern("my-server.v2")).toBe("mcp__my_server_v2__*");
});
