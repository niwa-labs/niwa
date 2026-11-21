/**
 * A session held to a set of tools is given the MCP servers niwa names and no other. These tests
 * run niwa's own adapter entry over a stand-in for the `claude` program that only records how it
 * was started, so what is proved is what reaches Claude Code's command line, not what a fake says.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { promptFromText } from "@niwa-labs/harness";
import type { StartOptions } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { claudeCodeControl } from "../../src/code/control.ts";
import type { ClaudeCodeSessionControl } from "../../src/code/control.ts";
import { denialOf, toolGuardHooks } from "../../src/code/acp/tool-guard.ts";

let dir = "";
let control: ClaudeCodeSessionControl | undefined;

beforeEach(async () => {
  dir = await tempDir("claude-mcp-sources");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  await rm(dir, { recursive: true, force: true });
});

const NIWA = { name: "niwa", command: "/bin/niwa", args: ["mcp"], env: {} };

/** The command line `claude` was started with for a start of the session; the start itself is never answered. */
async function commandLineOf(options: Partial<StartOptions>): Promise<string[]> {
  const log = join(dir, "argv.log");
  const program = join(dir, "claude.js");
  await writeFile(
    program,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nsetInterval(() => {}, 1000);\n`,
  );
  await chmod(program, 0o755);
  control = claudeCodeControl({ harness: "mcp-sources", executable: program, callTimeoutMs: 2_500 });
  await expect(control.start({ prompt: promptFromText(""), ...options })).rejects.toThrow();
  const line = (await readFile(log, "utf8")).trim().split("\n")[0];
  return JSON.parse(line ?? "[]") as string[];
}

test("a session of niwa's tools only, or held to an allow-list, is started with strict MCP config and its own servers", async () => {
  for (const tools of ["niwa-only", { allow: ["Read"] }] as const) {
    const argv = await commandLineOf({ tools, servers: [NIWA] });
    expect(argv).toContain("--strict-mcp-config");
    const config = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as { mcpServers: Record<string, unknown> };
    // The adapter's own in-process server of file and terminal tools (`acp`) has no tool the client lets it serve, and the guard denies any it names.
    expect(Object.keys(config.mcpServers).filter((name) => name !== "acp")).toEqual(["niwa"]);
    await control?.dispose();
    await rm(join(dir, "argv.log"), { force: true });
  }
}, 20_000);

test("a session with all of its tools keeps the MCP servers of the owner's settings", async () => {
  expect(await commandLineOf({ tools: "all", servers: [NIWA] })).not.toContain("--strict-mcp-config");
}, 20_000);

test("the guard denies a built-in tool the set leaves out and a tool of a server the session was not given", () => {
  const builtins = ["Bash", "Read", "Write"];
  const config = { allow: ["Read"], servers: ["niwa", "my server"] };
  expect(denialOf(config, "Read", builtins)).toBeUndefined();
  expect(denialOf(config, "Bash", builtins)).toContain("not in the set");
  expect(denialOf(config, "mcp__niwa__session_send", builtins)).toBeUndefined();
  // Claude Code spells the server of a name it cannot carry with underscores.
  expect(denialOf(config, "mcp__my_server__tool", builtins)).toBeUndefined();
  expect(denialOf(config, "mcp__github__create_issue", builtins)).toContain("was not given");
  // A server whose name only begins like a given one is another server.
  expect(denialOf(config, "mcp__niwa2__tool", builtins)).toContain("was not given");
  // What is neither a built-in nor an MCP tool is not the guard's to judge.
  expect(denialOf(config, "SomethingNew", builtins)).toBeUndefined();
});

test("a session with all of its tools has no guard, a restricted one has a hook that answers the denial in Claude Code's words", async () => {
  expect(toolGuardHooks(undefined, ["Bash"])).toEqual([]);
  expect(toolGuardHooks({ servers: ["niwa"] }, ["Bash"])).toEqual([]);
  const [hook] = toolGuardHooks({ tools: [], servers: ["niwa"] }, ["Bash"]);
  expect(await hook?.({ tool_name: "Bash" })).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
  });
  expect(await hook?.({ tool_name: "mcp__niwa__x" })).toEqual({});
});
