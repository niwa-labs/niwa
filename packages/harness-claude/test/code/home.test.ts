import { claudeTempEnv } from "../../src/code/needs.ts";
/** An instance bound to a Claude Code installation: its processes write where its reading side looks. */

import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import { admit, nono, onSpawn, resolveProfile, sandbox, spawnAgent } from "@niwa-labs/sandbox";
import type { BoxRequest } from "@niwa-labs/sandbox";
import { fakeSdkQuery, live, tempDir } from "@niwa-labs/testing";

import { claudeCodeControl } from "../../src/code/control.ts";
import { claudeCodeKind } from "../../src/code/index.ts";
import { claudeHomeEnv } from "../../src/code/needs.ts";
import { claudeSdkKind } from "../../src/sdk/index.ts";
import { ClaudeSdkControl } from "../../src/sdk/control.ts";
import { StartupDiagnostics } from "../../src/startup-diagnostics.ts";

const OTHER = "/tmp/niwa-other-claude-home";
const DEFAULT = join(homedir(), ".claude");

test("a process is told its installation only when it is not the default one", () => {
  expect(claudeHomeEnv(undefined)).toEqual({});
  expect(claudeHomeEnv(DEFAULT)).toEqual({});
  expect(claudeHomeEnv(OTHER)).toEqual({ CLAUDE_CONFIG_DIR: OTHER });
});

test("an installation's profile writes its directory, and the configuration file beside the default one", () => {
  const resolved = (kind: typeof claudeCodeKind | typeof claudeSdkKind, home?: string) =>
    resolveProfile(kind.bind({ id: "claude-a", ...(home === undefined ? {} : { home }) }).profile ?? {}, "claude-a", { home: homedir(), env: { PATH: "/nowhere" } });
  for (const kind of [claudeCodeKind, claudeSdkKind]) {
    expect(resolved(kind, OTHER).write).toEqual([OTHER]);
    expect(resolved(kind).write).toEqual([DEFAULT, join(homedir(), ".claude.json")]);
    // The runtime niwa's adapter runs on is in it.
    expect(resolved(kind).read).toContain(process.execPath);
    expect(kind.profile.status).toBe("admitted");
  }
});

test("the boxed ACP profile keeps package lookup links and their targets", async () => {
  const binding = claudeCodeKind.bind({ id: "claude-a" });
  const profile = resolveProfile(binding.profile ?? {}, "claude-a", { home: homedir(), env: process.env });
  const adapter = Bun.resolveSync("@zed-industries/claude-code-acp", import.meta.dir);
  const mcp = Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", adapter);
  const minimatch = Bun.resolveSync("minimatch", join(dirname(adapter), "settings.js"));
  for (const entry of [adapter, mcp, minimatch]) {
    expect(profile.read.some((dir) => entry.startsWith(`${dir}/`))).toBe(true);
  }
  const lookup = join(dirname(adapter), "../../..", "minimatch");
  if (existsSync(lookup)) {
    const target = realpathSync(lookup);
    expect(minimatch.startsWith(`${target}/`)).toBe(true);
    const host = sandbox();
    host.install("claude-a", binding.profile ?? {});
    const plan = host.plan({ cwd: await tempDir("claude-profile"), owner: "claude-a", defaults: { allow: [] }, network: false });
    const adapter = nono();
    const manifest = adapter.manifest(admit(plan, adapter, () => undefined).spec);
    expect(manifest.flags).toEqual(expect.arrayContaining([lookup, target]));
    expect(manifest.flags).not.toContain(dirname(lookup));
  }
});

/** Loading the actual adapter and answering initialize requires no model or login. */
async function initializeAdapter(cwd: string, box?: BoxRequest): Promise<void> {
  const entry = fileURLToPath(new URL("../../src/code/acp/adapter.ts", import.meta.url));
  const child = await spawnAgent({
    harness: "claude-acp-initialize",
    program: process.execPath,
    args: [entry],
    cwd,
    env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin:/bin" },
    unset: Object.keys(process.env),
    box,
  });
  const diagnostics = new StartupDiagnostics();
  child.stdin.on("error", (error) => diagnostics.error(error));
  child.stderr.setEncoding("utf8").on("data", diagnostics.stderr);
  child.on("exit", (code) => diagnostics.exit(code));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 },
    }) + "\n");
    for await (const line of lines) {
      let reply: { id?: number; result?: { protocolVersion?: number } } | null;
      try {
        reply = JSON.parse(line);
      } catch {
        throw new Error("ACP initialize returned invalid JSON");
      }
      if (reply?.id !== 1) continue;
      if (reply.result?.protocolVersion === 1) return;
      throw new Error(diagnostics.describe("ACP initialize returned an invalid response"));
    }
    await closed;
    throw new Error(diagnostics.describe("ACP initialize failed"));
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill("SIGKILL");
    await closed;
  }
}

test("the real ACP adapter loads and answers initialize", async () => {
  await initializeAdapter(await tempDir("claude-acp-initialize"));
}, 15_000);

test.skipIf(!live || process.platform !== "darwin")("the real ACP adapter loads through its nono profile", async () => {
  const cwd = await tempDir("claude-acp-nono");
  const home = join(cwd, ".claude");
  await mkdir(home);
  const binding = claudeCodeKind.bind({ id: "claude-acp-initialize", home });
  const host = sandbox();
  host.install("claude-acp-initialize", binding.profile ?? {});
  const plan = host.plan({ cwd, owner: "claude-acp-initialize", defaults: { allow: ["project"] }, network: false });
  const adapter = nono();
  const { spec } = admit(plan, adapter, () => undefined);
  await initializeAdapter(cwd, { sandbox: adapter, spec });
}, 25_000);

test("the ACP adapter is started bound to the installation of its instance", async () => {
  const spawned: Array<Readonly<Record<string, string>>> = [];
  const stop = onSpawn((event) => spawned.push(event.env));
  try {
    for (const home of [OTHER, DEFAULT]) {
      const control = claudeCodeControl({ harness: "home-proof", command: ["/usr/bin/true"], executable: "/opt/claude/claude", home });
      await expect(control.start({ prompt: promptFromText("one") })).rejects.toThrow();
      await control.dispose();
    }
  } finally {
    stop();
  }
  expect(spawned[0]?.CLAUDE_CONFIG_DIR).toBe(OTHER);
  expect(spawned[1]?.CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("a query of the SDK is bound to the installation of its instance", async () => {
  const fake = fakeSdkQuery();
  const bound = new ClaudeSdkControl({ harness: harnessId("home-proof"), query: fake.query, home: OTHER });
  const plain = new ClaudeSdkControl({ harness: harnessId("home-proof"), query: fake.query });
  try {
    await bound.start({ prompt: promptFromText("one") });
    expect(fake.asked()[0]?.env?.CLAUDE_CONFIG_DIR).toBe(OTHER);
    await plain.start({ prompt: promptFromText("one") });
    expect(fake.asked()[1]?.env?.CLAUDE_CONFIG_DIR).not.toBe(OTHER);
  } finally {
    await bound.dispose();
    await plain.dispose();
  }
});

test("only boxed Claude launches use the assigned session temporary directory", () => {
  const env = { TMPDIR: "/session/temp", CLAUDE_CODE_TMPDIR: "/other" };
  expect(claudeTempEnv(true, env)).toEqual({ CLAUDE_CODE_TMPDIR: "/session/temp" });
  expect(claudeTempEnv(false, env)).toEqual({});
  expect(claudeTempEnv(true, {})).toEqual({});
});
