// Generated surfaces.
// "Declare a new action in a plugin. It appears as an MCP tool and as a CLI command with no
// change to either surface."
//
// A real host process and the MCP surface linked to an SDK client over memory. The tools must
// equal what describe() says, a new action must be a tool on the next tools/list, and the
// tools that were there must still be there.

import { expect, test } from "bun:test";

import { spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { Note } from "./fixtures/surface-host.ts";
import { jsonOf, mcpPair, textOf } from "./fixtures/mcp-pair.ts";

const HOST_SCRIPT = new URL("./fixtures/surface-host.ts", import.meta.url).pathname;

interface Described {
  actions: Array<{ name: string; input: Record<string, unknown> }>;
}

test("generated surfaces: the tools are the list of actions, and a new action is a tool without any change to the surface", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;

  try {
    await host.ready();
    pair = await mcpPair(home.path);
    const client = pair.client;

    // The tools are exactly the described actions, with the described input schemas.
    const described = jsonOf(await client.callTool({ name: "niwa_describe", arguments: {} })) as Described;
    const before = (await client.listTools()).tools;
    expect(before.map((tool) => tool.name).sort()).toEqual(
      described.actions.map((action) => action.name.replace(/[.-]/g, "_")).sort(),
    );
    for (const action of described.actions) {
      const tool = before.find((candidate) => candidate.name === action.name.replace(/[.-]/g, "_"));
      expect(tool?.inputSchema).toEqual({ ...action.input, type: "object" });
      expect(tool?.description).toContain(action.name);
    }
    const names = before.map((tool) => tool.name);
    expect(names).toContain("surface_greet");
    expect(names).not.toContain("surface_extra_ping");

    // Calling a tool calls the action: its output comes back.
    const greeted = await client.callTool({ name: "surface_greet", arguments: { text: "hello" } });
    expect(greeted.isError).toBeFalsy();
    expect(jsonOf(greeted)).toEqual({ ok: true });

    // An argument the action's schema does not allow is refused, not turned into success.
    const refused = await client.callTool({ name: "surface_greet", arguments: { text: 1 } });
    expect(refused.isError).toBe(true);
    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("no_such_tool");
    const badRecord = await client.callTool({ name: "niwa_trace", arguments: {} });
    expect(badRecord.isError).toBe(true);

    // The observation tools read: records_read returns what is committed, without waiting for more.
    const writer = await connectAsOwner(home.path);
    const written = await writer.emit(Note, { text: "seen" });
    await writer.close();
    const since = jsonOf(
      await client.callTool({ name: "niwa_records_read", arguments: { from: 0, types: ["surface.note"] } }),
    );
    expect((since as { records: Array<{ id: string }> }).records.map((entry) => entry.id)).toEqual([written.id]);
    const traced = jsonOf(await client.callTool({ name: "niwa_trace", arguments: { id: written.id } }));
    expect((traced as Array<{ id: string }>)[0]?.id).toBe(written.id);

    // A plugin declares a new action in the running host.
    expect(jsonOf(await client.callTool({ name: "surface_add_action", arguments: {} }))).toEqual({ ok: true });

    // The next tools/list shows it, with the schema describe() gives, and the old tools stay.
    const after = (await client.listTools()).tools;
    const extra = after.find((tool) => tool.name === "surface_extra_ping");
    expect(extra).toBeDefined();
    const describedAfter = jsonOf(await client.callTool({ name: "niwa_describe", arguments: {} })) as Described;
    expect(extra?.inputSchema).toEqual({
      ...describedAfter.actions.find((action) => action.name === "surface.extra-ping")?.input,
      type: "object",
    });
    for (const tool of before) expect(after.map((candidate) => candidate.name)).toContain(tool.name);

    expect(jsonOf(await client.callTool({ name: "surface_extra_ping", arguments: {} }))).toEqual({ pong: true });
  } finally {
    await pair?.close();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
