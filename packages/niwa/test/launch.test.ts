// The spawnAgent funnel.
//
// What it proves:
//   1. the funnel builds the environment: the inherited one, less what is unset, plus the additions
//   2. a boxed launch gets the harness's needs added to the spec, visibly; its environment is only
//      what is listed, never process.env; the manifest is recorded before the process starts
//   3. a box that is required and unavailable stops every harness's start with the typed error and
//      no process is born
//   4. the tool flags appear in the launch of each harness
//   5. every agent process is born in the funnel: a started session is counted by the funnel, and
//      no harness spawns a process of its own

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";

import { promptFromText, harnessId } from "@niwa-labs/harness";
import type { SessionControl } from "@niwa-labs/harness";
import {
  homePath,
  onBoxManifest,
  onSpawn,
  spawnAgent,
  useSandbox,
  SandboxUnavailable,
  SandboxUnsupported,
  boxSpec,
} from "@niwa-labs/sandbox";
import type {
  AgentProcess,
  BoxRecord,
  BoxRequest,
  SpawnEvent,
  LaunchedBox,
  Sandbox,
  SandboxName,
} from "@niwa-labs/sandbox";
import { claudeCodeControl, ClaudeSdkControl } from "@niwa-labs/harness-claude";
import type { SdkQuery } from "@niwa-labs/harness-claude";
import { CODEX_FIXED_TOOLS, codexControl, codexToolFlags } from "@niwa-labs/harness-codex";
import { mcodeControl } from "@niwa-labs/harness-mcode";
import { zcodeControl } from "@niwa-labs/harness-zcode";
import { PiControl, piToolFlags } from "@niwa-labs/harness-pi";

import { fakeSdkQuery, tempDir } from "@niwa-labs/testing";

let dir: string;
const spawns: SpawnEvent[] = [];
const manifests: BoxRecord[] = [];
const order: string[] = [];
const undo: Array<() => void> = [];
const controls: SessionControl[] = [];

beforeEach(async () => {
  dir = await tempDir("launch");
  spawns.length = 0;
  manifests.length = 0;
  order.length = 0;
  undo.push(
    onSpawn((event) => {
      spawns.push(event);
      order.push("spawn");
    }),
    onBoxManifest((record) => {
      manifests.push(record);
      order.push("manifest");
    }),
  );
});

afterEach(async () => {
  for (const made of controls.splice(0)) await (made as { dispose?: () => Promise<void> }).dispose?.().catch(() => undefined);
  for (const restore of undo.splice(0)) restore();
  await rm(dir, { recursive: true, force: true });
});

/** A sandbox that confines nothing: it runs the argv with exactly the listed environment. */
function passthrough(name: "srt" | "nono", launched: string[][] = []): Sandbox {
  return {
    name,
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: name, cwd: spec.cwd, env: spec.env }),
    async launch(spec, argv): Promise<LaunchedBox> {
      launched.push([...argv]);
      const child = Bun.spawn([...argv], { cwd: spec.cwd, env: { ...spec.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill() };
    },
  };
}

function unavailable(name: SandboxName): Sandbox {
  return {
    name,
    class: "process",
    available: async () => false,
    manifest: (spec) => ({ sandbox: name, cwd: spec.cwd, env: spec.env }),
    async launch() {
      throw new SandboxUnavailable(name, "not here");
    },
  };
}

async function output(child: AgentProcess): Promise<string> {
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text += chunk;
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return text;
}

const printEnv = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

test("the funnel's environment is the inherited one, less what is unset, plus the additions", async () => {
  process.env["LAUNCH_INHERITED"] = "yes";
  process.env["LAUNCH_UNSET"] = "yes";
  try {
    const child = await spawnAgent({
      harness: "t",
      program: process.execPath,
      args: printEnv,
      cwd: dir,
      env: { NIWA_ID: "k3f9" },
      unset: ["LAUNCH_UNSET"],
    });
    const env = JSON.parse(await output(child)) as Record<string, string>;
    expect(env["LAUNCH_INHERITED"]).toBe("yes");
    expect(env["LAUNCH_UNSET"]).toBeUndefined();
    expect(env["NIWA_ID"]).toBe("k3f9");
  } finally {
    delete process.env["LAUNCH_INHERITED"];
    delete process.env["LAUNCH_UNSET"];
  }
  expect(spawns).toEqual([
    { harness: "t", argv: [process.execPath, ...printEnv], cwd: dir, env: { NIWA_ID: "k3f9" }, sandbox: undefined },
  ]);
});

test("a boxed launch adds the harness's needs to the spec, records the manifest first, and gives the process only what is listed", async () => {
  process.env["LAUNCH_SECRET"] = "s3";
  const launched: string[][] = [];
  undo.push(useSandbox("srt", passthrough("srt", launched)));
  try {
    const box: BoxRequest = { sandbox: "srt", spec: { cwd: dir, write: [dir], net: ["registry.npmjs.org"], env: { FROM_SPEC: "1" } } };
    const child = await spawnAgent({
      harness: "t",
      program: process.execPath,
      args: printEnv,
      cwd: dir,
      env: { NIWA_ID: "k3f9" },
      box,
      needs: { write: [homePath(".thing")], net: ["api.example.com"] },
    });
    const env = JSON.parse(await output(child)) as Record<string, string>;

    // Only what is listed: the spec's, the session's, and what the harness needs to find itself.
    expect(env["FROM_SPEC"]).toBe("1");
    expect(env["NIWA_ID"]).toBe("k3f9");
    expect(env["HOME"]).toBe(homePath());
    expect(env["PATH"]).toBe(process.env["PATH"]!);
    expect(env["LAUNCH_SECRET"]).toBeUndefined();

    // The needs are in the spec the manifest was made from, not hidden.
    expect(manifests).toHaveLength(1);
    const record = manifests[0]!;
    expect(record.sandbox).toBe("srt");
    expect(record.spec.write.map(String)).toEqual([dir, homePath(".thing")]);
    expect(record.spec.net.map(String)).toEqual(["registry.npmjs.org", "api.example.com"]);
    expect(record.manifest).toEqual({ sandbox: "srt", cwd: dir, env: record.spec.env });
    expect(record.spec).toEqual(boxSpec(record.spec));

    // The record is made before the process is started.
    expect(order).toEqual(["manifest", "spawn"]);
    expect(spawns[0]?.sandbox).toBe("srt");
    expect(launched).toEqual([[process.execPath, ...printEnv]]);
  } finally {
    delete process.env["LAUNCH_SECRET"];
  }
});

test("a boxed process can be written to and ends with a code, like a child process", async () => {
  undo.push(useSandbox("nono", passthrough("nono")));
  const child = await spawnAgent({
    harness: "t",
    program: process.execPath,
    args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(3))"],
    cwd: dir,
    box: { sandbox: "nono", spec: { cwd: dir } },
  });
  const codes: Array<number | null> = [];
  child.on("exit", (code) => codes.push(code));
  child.stdin.write("hello\n");
  child.stdin.end();
  expect(await output(child)).toBe("HELLO\n");
  expect(codes).toEqual([3]);
  expect(child.exitCode).toBe(3);
});

test("a box that cannot run stops the launch before any process exists", async () => {
  undo.push(useSandbox("srt", unavailable("srt")));
  const launch = spawnAgent({
    harness: "t",
    program: process.execPath,
    args: printEnv,
    box: { sandbox: "srt", spec: { cwd: dir } },
  });
  await expect(launch).rejects.toBeInstanceOf(SandboxUnavailable);
  expect(spawns).toEqual([]);
  expect(manifests).toEqual([]);
});

// -- the harnesses -----------------------------------------------------------

/** A fake `pi --mode rpc` that names its session. */
const FAKE_PI = `#!/usr/bin/env bun
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: "s1" } }) + "\\n");
  }
});
`;

/** A fake `codex app-server` that names a thread. It reads nothing from the environment. */
const FAKE_CODEX = `#!/usr/bin/env bun
let buffer = "";
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.method === "initialize") send({ id: frame.id, result: {} });
    else if (frame.method === "thread/start") send({ id: frame.id, result: { thread: { id: "thread-1" } } });
  }
});
`;

async function fake(name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

const empty = promptFromText("");

test("pi's launch carries the tool allowlist; nothing allowed and only niwa's tools switch every tool off", async () => {
  expect(piToolFlags(["read", "grep"])).toEqual(["--tools", "read,grep"]);
  expect(piToolFlags([])).toEqual(["--no-tools"]);

  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: await fake("pi", FAKE_PI) });
  controls.push(pi);
  await pi.start({ prompt: empty, cwd: dir, tools: { allow: ["read", "grep"] } });
  await pi.start({ prompt: empty, cwd: dir, tools: "niwa-only" });
  await pi.start({ prompt: empty, cwd: dir, tools: "all" });
  await pi.start({ prompt: empty, cwd: dir });
  expect(spawns.map((event) => event.argv.slice(1))).toEqual([
    ["--mode", "rpc", "--tools", "read,grep"],
    ["--mode", "rpc", "--no-tools"],
    ["--mode", "rpc"],
    ["--mode", "rpc"],
  ]);
});

test("codex's launch switches off what an allow-list leaves out, and refuses a mode it cannot hold before it spawns", async () => {
  expect(codexToolFlags([])).toEqual(["-c", "features.shell_tool=false", "-c", 'web_search="disabled"']);
  expect(codexToolFlags(["shell"])).toEqual(["-c", 'web_search="disabled"']);
  expect(codexToolFlags(["shell", "web_search", "apply_patch"])).toEqual([]);

  const codex = codexControl({ harness: "codex-fake", binary: await fake("codex", FAKE_CODEX) });
  controls.push(codex);
  await codex.start({ prompt: empty, cwd: dir, tools: { allow: ["web_search", ...CODEX_FIXED_TOOLS] } });
  await codex.start({ prompt: empty, cwd: dir });
  // apply_patch comes with the model and no flag switches it off: neither mode can be held.
  await expect(codex.start({ prompt: empty, cwd: dir, tools: "niwa-only" })).rejects.toMatchObject({
    code: "Unsupported",
    message: expect.stringContaining("apply_patch"),
  });
  await expect(codex.start({ prompt: empty, cwd: dir, tools: { allow: ["web_search"] } })).rejects.toMatchObject({
    code: "Unsupported",
    message: expect.stringContaining("apply_patch, update_plan, view_image"),
  });
  expect(spawns.map((event) => event.argv.slice(1))).toEqual([
    ["app-server", "--stdio", "-c", "features.shell_tool=false"],
    ["app-server", "--stdio"],
  ]);
});

test("the Claude SDK's query gets the tool allowlist, and its process is born in the funnel", async () => {
  const fakeQuery = fakeSdkQuery();
  const seen: SdkOptions[] = [];
  const query: SdkQuery = (params) => {
    seen.push(params.options);
    return fakeQuery.query(params);
  };
  const control = new ClaudeSdkControl({ harness: harnessId("sdk-fake"), query });
  controls.push(control);
  await control.start({ prompt: promptFromText("one"), tools: { allow: ["Read"] }, env: { NIWA_ID: "k3f9" } });

  const options = seen[0];
  expect(options?.tools).toEqual(["Read"]);
  // The SDK would call this hook to spawn Claude Code: the process is the funnel's.
  const child = options?.spawnClaudeCodeProcess?.({
    command: process.execPath,
    args: printEnv,
    cwd: dir,
    env: { ...process.env, NIWA_ID: "k3f9" },
    signal: new AbortController().signal,
  });
  expect(child).toBeDefined();
  const chunks: string[] = [];
  child!.stdout.setEncoding("utf8");
  child!.stdout.on("data", (chunk: string) => chunks.push(chunk));
  await new Promise<void>((resolve) => child!.on("exit", () => resolve()));
  expect((JSON.parse(chunks.join("")) as Record<string, string>)["NIWA_ID"]).toBe("k3f9");
  expect(spawns).toHaveLength(1);
  expect(spawns[0]?.env).toEqual({ NIWA_ID: "k3f9" });

  // Only niwa's tools is an allowlist of none of Claude Code's own; all of them is the SDK's default.
  await control.start({ prompt: promptFromText("two"), tools: "niwa-only" });
  await control.start({ prompt: promptFromText("three"), tools: "all" });
  expect(seen[1]?.tools).toEqual([]);
  expect(seen[2]).not.toHaveProperty("tools");
});

test("a start whose box cannot run fails with SandboxUnavailable in every harness, and no process is born", async () => {
  undo.push(useSandbox("srt", unavailable("srt")));
  const box: BoxRequest = { sandbox: "srt", spec: { cwd: dir } };
  const binary = join(dir, "never-run");
  const sides: Array<[string, SessionControl]> = [
    ["pi", new PiControl({ mode: "full", harness: "pi-fake", binary })],
    ["codex", codexControl({ harness: "codex-fake", binary })],
    ["claude-code", claudeCodeControl({ harness: "claude-fake", command: [binary] })],
    ["mcode", mcodeControl({ mode: "full", harness: harnessId("mcode-fake"), binary })],
    ["zcode", zcodeControl({ harness: "zcode-fake", binary })],
    ["claude-sdk", new ClaudeSdkControl({ harness: harnessId("sdk-fake"), query: fakeSdkQuery().query })],
  ];
  for (const [name, side] of sides) {
    controls.push(side);
    const prompt = name === "claude-sdk" ? promptFromText("one") : empty;
    await expect(side.start({ prompt, cwd: dir, box })).rejects.toBeInstanceOf(SandboxUnavailable);
  }
  expect(spawns).toEqual([]);
  expect(manifests).toEqual([]);
});

test("a codex session starts inside a box: the harness's needs are in the manifest, which is recorded before the process", async () => {
  undo.push(useSandbox("nono", passthrough("nono")));
  const codex = codexControl({ harness: "codex-fake", binary: await fake("codex", FAKE_CODEX) });
  controls.push(codex);
  const started = await codex.start({
    prompt: empty,
    cwd: dir,
    env: { NIWA_ID: "k3f9" },
    box: { sandbox: "nono", spec: { cwd: dir, write: [dir], env: {} } },
  });
  expect(String(started.session.native)).toBe("thread-1");
  expect(order).toEqual(["manifest", "spawn"]);
  expect(manifests[0]!.spec.write.map(String)).toEqual([dir, homePath(".codex")]);
  expect(manifests[0]!.spec.net.map(String)).toEqual(["api.openai.com", "chatgpt.com"]);
  expect(Object.entries(manifests[0]!.spec.env)).toContainEqual(["NIWA_ID", "k3f9"]);
  expect(spawns[0]?.sandbox).toBe("nono");
});

test("a box whose manifest cannot be made, or recorded, stops the start with that error and no process is born", async () => {
  const codex = codexControl({ harness: "codex-fake", binary: await fake("codex", FAKE_CODEX) });
  controls.push(codex);
  const box: BoxRequest = { sandbox: "nono", spec: { cwd: dir } };

  const refusing: Sandbox = {
    ...passthrough("nono"),
    manifest() {
      throw new SandboxUnsupported("nono", "denyRead cannot be said");
    },
  };
  undo.push(useSandbox("nono", refusing));
  await expect(codex.start({ prompt: empty, cwd: dir, box })).rejects.toBeInstanceOf(SandboxUnsupported);

  undo.push(useSandbox("nono", passthrough("nono")));
  undo.push(
    onBoxManifest(() => {
      throw new Error("the journal is full");
    }),
  );
  await expect(codex.start({ prompt: empty, cwd: dir, box })).rejects.toThrow("the journal is full");
  expect(spawns).toEqual([]);
});

test("a running session refuses a new box or tool set instead of keeping the old one in silence", async () => {
  const codex = codexControl({ harness: "codex-fake", binary: await fake("codex", FAKE_CODEX) });
  controls.push(codex);
  const { session } = await codex.start({ prompt: empty, cwd: dir });
  await expect(codex.resume(session, { tools: { allow: [] } })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(codex.resume(session, { box: { sandbox: "srt", spec: { cwd: dir } } })).rejects.toMatchObject({ code: "Unsupported" });
});

test("no harness spawns a process of its own: the funnel is the only user of child_process for agents", async () => {
  const roots = ["acp", "harness", "harness-claude", "harness-codex", "harness-mcode", "harness-pi", "harness-zcode"].map((name) => `packages/${name}/src`);
  const found: string[] = [];
  for (const root of roots) {
    for (const entry of await readdir(join(import.meta.dir, "../../..", root), { recursive: true })) {
      if (!entry.endsWith(".ts")) continue;
      const text = await readFile(join(import.meta.dir, "../../..", root, entry), "utf8");
      if (/import \{[^}]*\bspawn\b[^}]*\} from "node:child_process"|Bun\.spawn\(/.test(text)) found.push(`${root}/${entry}`);
    }
  }
  // The funnel lives in the sandbox module, out of these roots; what is left is the probe that asks an installed CLI for its version and the insert's `niwa insert report` call: neither starts an agent.
  expect(found.sort()).toEqual(["packages/harness/src/discover.ts", "packages/harness/src/insert-report.ts"]);
});
