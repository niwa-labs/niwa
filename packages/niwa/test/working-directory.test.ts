// An action that takes a `directory` is told where the caller works.
//
// The CLI and the MCP server read the schema of the action, not a list: any action with a `directory` field gets the
// working directory of the process when the caller names none, and keeps what the caller names.
//
//   1. the CLI fills the directory with its working directory, and leaves an explicit one alone
//   2. the MCP server fills it with the working directory of its process, and leaves an explicit one alone
//   3. an action with no such field is not given one

import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { action } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

import { jsonOf, mcpPair } from "./fixtures/mcp-pair.ts";

const Where = z.object({ directory: z.string().optional(), note: z.string().optional() });

const wherePlugin = plugin("where", (api) => {
  api.action(action("where.run", { description: "Says the directory it was given.", input: Where, output: z.object({ given: z.unknown() }), recovery: "repeat", run: (input) => ({ given: input }) }));
  api.action(action("where.plain", { description: "Takes no directory.", input: z.object({ note: z.string().optional() }), output: z.object({ given: z.unknown() }), recovery: "repeat", run: (input) => ({ given: input }) }));
});

async function withHost(run: (home: string, cwd: string) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const cwd = await realpath(await (async () => { await mkdir(join(home.path, "work"), { recursive: true }); return join(home.path, "work"); })());
  const niwa = createNiwa({ home: home.path });
  niwa.use(wherePlugin);
  await niwa.serve();
  try {
    await run(home.path, cwd);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}

async function cli(home: string, cwd: string, args: string[]): Promise<unknown> {
  const child = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home, "--json", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, err).toBe(0);
  return JSON.parse(out);
}

test("the CLI tells an action that takes a directory where it works, and keeps an explicit one", async () => {
  await withHost(async (home, cwd) => {
    expect(await cli(home, cwd, ["where.run"])).toEqual({ given: { directory: cwd } });
    expect(await cli(home, cwd, ["where.run", "--note", "x"])).toEqual({ given: { directory: cwd, note: "x" } });
    expect(await cli(home, cwd, ["where.run", "--directory", "/elsewhere"])).toEqual({ given: { directory: "/elsewhere" } });
    expect(await cli(home, cwd, ["where.plain"])).toEqual({ given: {} });
  });
}, 30_000);

test("the MCP server tells an action that takes a directory where its process works, and keeps an explicit one", async () => {
  await withHost(async (home, cwd) => {
    const before = process.cwd();
    process.chdir(cwd);
    const pair = await mcpPair(home);
    try {
      expect(jsonOf(await pair.client.callTool({ name: "where_run", arguments: {} }))).toEqual({ given: { directory: cwd } });
      expect(jsonOf(await pair.client.callTool({ name: "where_run", arguments: { directory: "/elsewhere" } }))).toEqual({ given: { directory: "/elsewhere" } });
      expect(jsonOf(await pair.client.callTool({ name: "where_plain", arguments: {} }))).toEqual({ given: {} });
    } finally {
      process.chdir(before);
      await pair.close();
    }
  });
}, 30_000);
