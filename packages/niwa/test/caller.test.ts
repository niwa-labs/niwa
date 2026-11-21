// Caller.
// "A payload that claims to come from someone else does not change who the caller is."
//
// A real host process and the MCP surface. The action surface.whoami answers with the caller the core
// bound to the call; the tool arguments claim to be somebody else, in several shapes.

import { expect, test } from "bun:test";

import { spawnHost, tempHome } from "@niwa-labs/testing";
import { jsonOf, mcpPair, type McpPair } from "./fixtures/mcp-pair.ts";

const HOST_SCRIPT = new URL("./fixtures/surface-host.ts", import.meta.url).pathname;
const SESSION_CALLER = /^mcp:[0-9a-f-]{36}(#\d+)?$/;

async function callerOf(pair: McpPair, args: Record<string, unknown>): Promise<{ caller: string; kind: string }> {
  const result = await pair.client.callTool({ name: "surface_whoami", arguments: args });
  expect(result.isError).toBeFalsy();
  return jsonOf(result) as { caller: string; kind: string };
}

test("caller: a payload that claims to come from someone else does not change who the caller is", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  const pairs: McpPair[] = [];

  try {
    await host.ready();
    const first = await mcpPair(home.path);
    pairs.push(first);

    // No claim: the caller is the session, named by the transport.
    const plain = await callerOf(first, {});
    expect(plain.kind).toBe("client");
    expect(plain.caller).toMatch(SESSION_CALLER);

    // Claims, however written, change nothing; the claimed id appears nowhere in the caller.
    for (const claim of ["somebody-else", "host", "mcp:other-session"]) {
      const claimed = await callerOf(first, { caller: claim });
      expect(claimed).toEqual(plain);
    }

    // Fields the action does not declare are dropped, never obeyed.
    expect(await callerOf(first, { sessionId: "somebody-else", from: "somebody-else" })).toEqual(plain);

    // Another session is another caller, and stays the same caller across calls.
    const second = await mcpPair(home.path);
    pairs.push(second);
    const other = await callerOf(second, { caller: plain.caller });
    expect(other.caller).toMatch(SESSION_CALLER);
    expect(other.caller).not.toBe(plain.caller);
    expect(await callerOf(second, {})).toEqual(other);
  } finally {
    for (const pair of pairs) await pair.close().catch(() => {});
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
