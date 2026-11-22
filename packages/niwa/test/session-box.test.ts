// The box a session runs in.
//
// What it proves:
//   1. a start that asks for nothing gets the host's default (the project, the toolchains) and the
//      profile of its own installation; the places of every other installation are closed to it
//   2. what a start asks beyond the default is held to the caller's `box.*` rules: refused naming the
//      rule it lacks, and recorded with the rule that covered it when it has one; `only` narrows freely
//   3. the manifest is recorded before the process: the request with where each item came from, the
//      paths with theirs, the rules taken, the policy, and the environment by its names only
//   4. a start that names no working directory is not given the host's directory to write
//   5. the host's sandbox chooses the adapter; a box the adapter cannot hold is refused with every reason

import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect, token } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import type { Harness, SessionControl, StartOptions } from "@niwa-labs/harness";
import { harnessId, harnessKind, machineId } from "@niwa-labs/harness";
import { claudeCodeKind } from "@niwa-labs/harness-claude";
import { codexKind } from "@niwa-labs/harness-codex";
import { piKind } from "@niwa-labs/harness-pi";
import { BoxRefused, boxSpec, sandbox, spawnAgent, useSandbox } from "@niwa-labs/sandbox";
import type { LaunchedBox, Sandbox } from "@niwa-labs/sandbox";
import { SessionBoxManifest, sessions } from "@niwa-labs/sessions";
import type { SessionsOptions } from "@niwa-labs/sessions";
import { tempDir, tempHome, unconfined } from "@niwa-labs/testing";

const START = actionName("session.start");

const undo: Array<() => void> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const restore of undo.splice(0)) restore();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function instance(id: string): Harness {
  return {
    id: harnessId(id),
    kind: harnessKind("fake-kind"),
    machine: machineId("machine-1"),
    home: "/tmp/fake-home",
    sides: {
      reading: { list: false, read: false, watch: false },
      control: { start: true, resume: true, send: true, interrupt: true, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } },
    },
  };
}

/** A control side that remembers how it was started, and starts its process through the funnel when told to. */
class Recording implements SessionControl {
  readonly starts: StartOptions[] = [];
  constructor(private readonly spawn = false) {}
  async start(options: StartOptions) {
    this.starts.push(options);
    if (this.spawn) {
      const child = await spawnAgent({
        harness: "rec",
        program: "/usr/bin/true",
        args: [],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...options.env, PROVIDER_API_KEY: KEY },
        ...(options.box === undefined ? {} : { box: options.box }),
      });
      await new Promise((done) => child.once("exit", done));
    }
    return { session: { harness: harnessId("rec"), native: `s${String(this.starts.length)}` as never } };
  }
  async resume(): Promise<void> {}
  async send() {
    return { status: "started" as const };
  }
  async interrupt(): Promise<void> {}
  async ask(): Promise<never> {
    throw new Error("not asked");
  }
  async *life() {}
  async state() {
    return "idle" as const;
  }
}

const KEY = "sk-provider-key-that-is-never-written";

/** A sandbox that confines nothing and reports a policy, as an adapter does. */
function passthrough(name: "srt" | "nono"): Sandbox {
  return {
    name,
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: name, cwd: spec.cwd, env: spec.env, policy: { write: spec.write, devices: [], read: { except: spec.closed }, net: spec.net } }),
    async launch(spec, argv): Promise<LaunchedBox> {
      const child = Bun.spawn([...argv], { cwd: spec.cwd, env: { ...spec.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill() };
    },
  };
}

async function served(harnesses: SessionsOptions["harnesses"], options: Omit<SessionsOptions, "harnesses"> = {}): Promise<Host & { homePath: string }> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses, ...options }));
  await host.serve();
  cleanups.push(async () => {
    await host.close();
    await home.cleanup();
  });
  return Object.assign(host, { homePath: home.path });
}

async function workdir(): Promise<string> {
  const dir = await realpath(await tempDir("session-box"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const strings = (paths: readonly string[] | undefined) => (paths ?? []).map(String);

test("a start that asks for nothing gets the project, the toolchains and its installation's profile, and every other installation's places are closed", async () => {
  const dir = await workdir();
  const homes = { codex: join(dir, "codex-home"), claude: join(dir, "claude-home"), pi: join(dir, "pi-home") };
  for (const home of Object.values(homes)) await mkdir(home);
  const control = new Recording();
  const host = await served([
    { instance: instance("codex-luna"), control, profile: codexKind.bind({ id: "codex-luna", home: homes.codex }).profile },
    { instance: instance("claude-haiku"), control: new Recording(), profile: claudeCodeKind.bind({ id: "claude-haiku", home: homes.claude }).profile },
    { instance: instance("pi"), control: new Recording(), profile: piKind.bind({ id: "pi", home: homes.pi }).profile },
  ]);
  undo.push(useSandbox("srt", passthrough("srt")));
  const work = join(dir, "work");
  await mkdir(work);
  await host.call(START, { harness: "codex-luna", prompt: "go", cwd: work });

  const spec = boxSpec(control.starts[0]?.box?.spec ?? { cwd: "/" });
  expect(strings(spec.write)).toEqual(expect.arrayContaining([work, homes.codex]));
  expect(strings(spec.net)).toEqual(["api.openai.com", "chatgpt.com"]);
  expect(strings(spec.closed)).toEqual(expect.arrayContaining([homes.claude, homes.pi, join(await realpath(homedir()), ".ssh")]));
  expect(strings(spec.closed)).not.toContain(homes.codex);
  const firstOnPath = (process.env["PATH"] ?? "").split(":").find((place) => place.startsWith("/usr/bin"));
  if (firstOnPath !== undefined) expect(strings(spec.read)).toContain(firstOnPath);
});

test("what a start asks beyond the default is held to the caller's box rules, and `only` narrows freely", async () => {
  const dir = await workdir();
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });
  undo.push(useSandbox("srt", passthrough("srt")));
  await host.call(START, { harness: "rec", prompt: "go", cwd: dir, visible: { actions: ["session.start", "box.read@/opt/*", "box.use@bun"] } });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());

  await parent.call(START, { harness: "rec", prompt: "go", cwd: dir, box: { allow: ["bun", { read: "/opt/niwa-data" }] } });
  expect(control.starts).toHaveLength(2);

  const refused = await parent.call(START, { harness: "rec", prompt: "go", cwd: dir, box: { allow: ["npm", { write: "/opt/niwa-out" }, { net: "crates.io" }] } }).then(
    () => undefined,
    (error: unknown) => String(error),
  );
  expect(refused).toContain("box.use@npm");
  expect(refused).toContain("box.write@/opt/niwa-out");
  expect(refused).toContain("box.net@crates.io");
  expect(control.starts).toHaveLength(2);

  // Narrower than the default needs no rule.
  await parent.call(START, { harness: "rec", prompt: "go", cwd: dir, box: { only: [{ read: "." }] } });
  const narrow = boxSpec(control.starts[2]?.box?.spec ?? { cwd: "/" });
  expect(strings(narrow.write)).not.toContain(dir);
  expect(strings(narrow.read)).toContain(dir);
});

test("an external MCP client starts Codex Luna in an external linked checkout with read-only Git metadata", async () => {
  const root = await workdir();
  const repo = join(root, "repo");
  const cwd = join(root, "linked");
  const privateHome = join(root, "another-harness");
  await mkdir(repo);
  await mkdir(privateHome);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  await writeFile(join(repo, "go.mod"), "module example.invalid/fixture\n\ngo 1.20\n");
  await writeFile(join(repo, "main.go"), "package main\n\nfunc main() {}\n");
  git("add", "go.mod", "main.go");
  git("update-ref", "HEAD", git("commit-tree", git("write-tree"), "-m", "external fixture"));
  git("worktree", "add", "-q", "--detach", cwd);
  const common = join(repo, ".git");
  const admin = join(common, "worktrees", "linked");
  const go = Bun.which("go");
  let output = "";
  class WorktreeControl extends Recording {
    override async start(options: StartOptions) {
      const { cwd, box, env } = options;
      const temp = env?.["TMPDIR"];
      if (!cwd || !box || !temp) throw new Error("the session must provide a cwd, box and TMPDIR");
      const child = await spawnAgent({
        harness: "codex-luna",
        program: "/bin/sh",
        args: ["-ec", [
          "git log -1 --format=%s",
          'if [ -n "$1" ]; then "$1" build -buildvcs=true -o "$TMPDIR/fixture" .; echo go-build-ok; fi',
        ].join("\n"), "fixture", go ?? ""],
        cwd,
        env: {
          ...env,
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
          GOCACHE: join(temp, "go-cache"),
          GOENV: "off", GOPROXY: "off", GOTELEMETRY: "off", GOTOOLCHAIN: "local", GOWORK: "off",
        },
        box,
      });
      let stderr = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      const result = await super.start(options);
      return { session: { ...result.session, harness: harnessId("codex-luna") } };
    }
  }
  const control = new WorktreeControl();
  const host = await served([
    { instance: instance("codex-luna"), control },
    { instance: instance("other"), control: new Recording(), profile: { write: [privateHome] } },
  ], { sandbox: sandbox({ adapter: unconfined() }) });
  const client = async (id: string, rules: string[]) => {
    const api = new Client({ name: id, version: "0.1.0" });
    cleanups.push(() => api.close());
    await api.connect(new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", host.homePath, "mcp"],
      env: { NIWA_ID: host.issueToken(principalOf("client", id), { grant: grant(["session.start", ...rules]) }) },
      cwd,
    }));
    return api;
  };
  const start = (api: Client, args: Record<string, unknown> = {}) => api.callTool({
    name: "session_start",
    arguments: { harness: "codex-luna", prompt: "Run git log and build the fixture", cwd, ...args },
  });
  const limited = await client("limited", ["box.read@" + admin]);
  const denied = await start(limited, { box: { allow: [{ read: common }] } });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).toContain("box.read@" + common);
  const partial = await start(limited, { box: { allow: [{ read: admin }] } });
  expect(partial.isError).toBe(true);
  expect(JSON.stringify(partial)).toContain("common Git directory " + common);
  const blocked = await start(limited, { cwd: privateHome });
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked)).toContain("Choose a cwd outside that home, or start the owning harness other");
  expect(control.starts).toHaveLength(0);

  const approved = await client("approved", ["box.read@" + common]);
  const result = await start(approved, { box: { only: ["toolchains", { write: cwd }, { read: common }] } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(output.trim().split("\n")).toEqual(["external fixture", ...(go ? ["go-build-ok"] : [])]);
  const records = await host.records.read({ types: [SessionBoxManifest.name] });
  expect(records).toHaveLength(1);
  const manifest = SessionBoxManifest.schema.parse(records[0]?.data);
  expect(manifest.paths).toContainEqual({ path: common, mode: "read", from: "call" });
  expect(manifest.paths.some((need) => need.from === "repository")).toBe(false);
  expect(manifest.policy.write.some((path) => path.startsWith(common))).toBe(false);
  expect(manifest.rules).toEqual(["box.read@" + common]);
}, 60_000);

test("the manifest is recorded before the process, with the request, the paths and the rules by origin, and the environment by name", async () => {
  const dir = await workdir();
  const control = new Recording(true);
  const host = await served([{ instance: instance("rec"), control, profile: { write: [join(dir, "own")] } }]);
  undo.push(useSandbox("srt", passthrough("srt")));
  await host.call(START, { harness: "rec", prompt: "go", cwd: dir, box: { allow: [{ read: "/opt/niwa-data" }, { write: join(dir, "out") }] } });

  const rows = await host.records.read({ types: [SessionBoxManifest.name] });
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(KEY);
  const data = SessionBoxManifest.schema.parse(rows[0]?.data);
  expect(data.harness).toBe("rec");
  expect(data.sandbox).toBe("srt");
  expect(data.cwd).toBe(dir);
  expect(data.request).toEqual({
    mode: "allow",
    items: [
      { item: "project", from: "host" },
      { item: "toolchains", from: "host" },
      { item: { read: "/opt/niwa-data" }, from: "call" },
      { item: { write: join(dir, "out") }, from: "call" },
    ],
  });
  expect(data.paths).toContainEqual({ path: dir, mode: "write", from: "project" });
  expect(data.paths).toContainEqual({ path: join(dir, "own"), mode: "write", from: "harness:rec" });
  expect(data.paths).toContainEqual({ path: "/opt/niwa-data", mode: "read", from: "call" });
  expect(data.paths.some((need) => need.from === "temp")).toBe(true);
  expect(data.paths.some((need) => need.from === "toolchains")).toBe(true);
  // The owner nothing limits: the rule the widening needed is the one it is let through by. A place in
  // the project needs none.
  expect(data.rules).toEqual(["box.read@/opt/niwa-data"]);
  expect(data.closed.some((one) => one.from === "niwa")).toBe(true);
  expect("except" in data.policy.read).toBe(true);
  expect(data.env).toEqual(expect.arrayContaining(["PROVIDER_API_KEY", "NIWA_ID", "TMPDIR", "HOME", "PATH"]));
});

test("a start that names no working directory is not given the host's directory to write", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }]);
  undo.push(useSandbox("srt", passthrough("srt")));
  await host.call(START, { harness: "rec", prompt: "go" });
  const spec = boxSpec(control.starts[0]?.box?.spec ?? { cwd: "/" });
  expect(strings(spec.write)).not.toContain(await realpath(process.cwd()));
});

test("the host's sandbox chooses the adapter, and a box it cannot hold is refused with every reason", async () => {
  const dir = await workdir();
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control, profile: { write: [join(dir, "own")] } }], { sandbox: sandbox({ adapter: passthrough("nono") }) });
  await host.call(START, { harness: "rec", prompt: "go", cwd: dir });
  expect((control.starts[0]?.box?.sandbox as Sandbox).name).toBe("nono");

  // An adapter that cannot hold the plan: its reasons and the plan's own come back together.
  const strict = new Recording();
  const refusing: Sandbox = {
    ...passthrough("nono"),
    manifest() {
      throw new BoxRefused([{ code: "adapter", message: "nono cannot keep /x closed inside /" }], "nono");
    },
  };
  const other = await served([{ instance: instance("rec"), control: strict }], { sandbox: sandbox({ adapter: refusing }) });
  const refused = await other.call(START, { harness: "rec", prompt: "go", cwd: dir, box: { allow: ["yarn" as "npm"] } }).then(
    () => undefined,
    (error: unknown) => String(error),
  );
  expect(refused).toContain("yarn is no profile");
  expect(refused).toContain("nono cannot keep /x closed inside /");
  expect(strict.starts).toHaveLength(0);
});
