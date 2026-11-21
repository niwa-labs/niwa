// An action that takes a string, not an object, is a tool a client can call: through the MCP surface its input
// is the argument `input`, and the host runs it with the string.

import { afterEach, expect, test } from "bun:test";

import { action } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

import { jsonOf, mcpPair, textOf } from "./fixtures/mcp-pair.ts";
import type { McpPair } from "./fixtures/mcp-pair.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

const measure = action("scalar.measure", {
  description: "Measures a text.",
  input: z.string().min(1),
  output: z.object({ length: z.number() }),
  recovery: "repeat",
  effect: "read",
  run: async (text) => ({ length: text.length }),
});

async function served(): Promise<{ host: Host; pair: McpPair }> {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const host = createNiwa({ home: home.path });
  host.use(plugin("scalar", (api) => api.action(measure)));
  await host.serve();
  cleanups.push(() => host.close());
  const pair = await mcpPair(home.path, ["scalar.measure"]);
  cleanups.unshift(() => pair.close());
  return { host, pair };
}

test("a tool whose action takes a string is called with the string in `input`", async () => {
  const { pair } = await served();
  const [tool] = (await pair.client.listTools()).tools;
  expect(tool?.name).toBe("scalar_measure");
  expect(tool?.inputSchema).toMatchObject({ type: "object", required: ["input"], properties: { input: { type: "string", minLength: 1 } } });

  const measured = await pair.client.callTool({ name: "scalar_measure", arguments: { input: "four" } });
  expect(measured.isError).toBeFalsy();
  expect(jsonOf(measured)).toEqual({ length: 4 });

  const missing = await pair.client.callTool({ name: "scalar_measure", arguments: {} });
  expect(missing.isError).toBe(true);
  expect(textOf(missing)).toMatch(/expected string/i);
}, 30_000);
