// A session's grant becomes its launch.
//
// What it proves:
//   1. the pure derivation: `tool:` rules are the allowance, `write:` and `net:` rules are the box,
//      `tool:*` and no `tool:` rule leave the harness its default
//   2. through `session.start` the control side is given exactly that, the launch rules never
//      reach the visible actions, and a request wider than the caller is still refused
//   3. a harness gets the flags of its grant: pi's argv, codex's switches, the Claude SDK's tools;
//      mcode refuses `tool:` by name before anything is spawned
//   4. a grant with `write:`/`net:` starts the process in a box whose manifest is a journal record,
//      written before the process starts, and equal to the spec the funnel made (apart from the token)
//   5. a box that is not available stops the start: nothing is spawned, no token is issued

import { afterEach, expect, test } from "bun:test";
import { chmod, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_TYPES, actionName, grant, seq } from "@niwa-labs/core";
import { connect, token } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import type {
  Harness,
  ResumeOptions,
  SessionControl,
  SessionId,
  SessionState,
  StartOptions,
} from "@niwa-labs/harness";
import { harnessId, harnessKind, machineId } from "@niwa-labs/harness";
import type { BoxRecord, LaunchedBox, Sandbox, SandboxName, SpawnEvent } from "@niwa-labs/sandbox";
import {
  SandboxUnavailable,
  SandboxUnsupported,
  boxSpec,
  homePath,
  nono,
  onBoxManifest,
  onSpawn,
  srt,
  useSandbox,
} from "@niwa-labs/sandbox";
import { SessionBoxManifest, SessionMarked, launchOf, sessions } from "@niwa-labs/sessions";
import type { SessionsOptions } from "@niwa-labs/sessions";
import { tempDir, tempHome, fakeSdkQuery } from "@niwa-labs/testing";

import { ClaudeSdkControl } from "@niwa-labs/harness-claude";
import { CODEX_FIXED_TOOLS, codexControl } from "@niwa-labs/harness-codex";
import { mcodeControl } from "@niwa-labs/harness-mcode";
import { PiControl } from "@niwa-labs/harness-pi";

const START = actionName("session.start");

/** A grant that names tools must name the ones Codex cannot switch off, or the start is refused. */
const CODEX_KEPT = CODEX_FIXED_TOOLS.map((tool) => `tool:${tool}`);

const spawns: SpawnEvent[] = [];
const undo: Array<() => void> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  spawns.length = 0;
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
      reading: { list: true, read: true, watch: false },
      control: { start: true, resume: true, send: true, interrupt: true, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] }, tools: { niwaOnly: true, allow: true } },
    },
  };
}

/** The control side that only remembers how it was started. */
class Recording implements SessionControl {
  readonly starts: StartOptions[] = [];
  readonly resumes: Array<ResumeOptions | undefined> = [];
  /** What `state` answers: "unknown" is a session whose process is gone, as after a restart. */
  running: SessionState = "idle";
  async start(options: StartOptions) {
    this.starts.push(options);
    return { session: { harness: harnessId("rec"), native: `s${String(this.starts.length)}` as never } };
  }
  async resume(_id: SessionId, options?: ResumeOptions): Promise<void> {
    this.resumes.push(options);
  }
  async send() {
    return { status: "started" as const };
  }
  async interrupt(): Promise<void> {}
  async ask(): Promise<never> {
    throw new Error("not asked");
  }
  async *life() {}
  async state() {
    return this.running;
  }
}

async function served(harnesses: SessionsOptions["harnesses"], options: Pick<SessionsOptions, "sandbox" | "niwaMcp"> = {}) {
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

/** The host of an earlier run, started again over the same home: what it remembers is the journal. */
async function restarted(home: string, harnesses: SessionsOptions["harnesses"]) {
  const host = createNiwa({ home });
  host.use(sessions({ harnesses }));
  await host.serve();
  cleanups.push(() => host.close());
  return Object.assign(host, { homePath: home });
}

async function workdir(): Promise<string> {
  const dir = await tempDir("grant-wiring");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A sandbox that confines nothing and says what the journal held when it was asked to launch. */
function passthrough(name: "srt" | "nono", host: () => Host, journalAtLaunch: string[][] = []): Sandbox {
  return {
    name,
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: name, cwd: spec.cwd, env: spec.env }),
    async launch(spec, argv): Promise<LaunchedBox> {
      const held = await host().records.read(seq(0), { types: [SessionBoxManifest.name] });
      journalAtLaunch.push(held.map((row) => String(row.type)));
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

async function fake(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

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

const FAKE_CODEX = `#!/usr/bin/env bun
let buffer = "";
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.method === "initialize") send({ id: frame.id, result: {} });
    else if (frame.method === "thread/start" || frame.method === "thread/resume") send({ id: frame.id, result: { thread: { id: "thread-1" } } });
  }
});
`;

// -- the derivation ----------------------------------------------------------

const plan = { home: "/home/.niwa", cwd: "/work", socket: "/home/.niwa/niwa.sock", sandbox: "srt" } as const;
/** What every box closes whatever its grant says: the owner's token and the host key. */
const KEYS = ["/home/.niwa/owner.token", "/home/.niwa/host.key"];

test("tool rules are the allowance; no tool rule and `tool:*` leave the harness its default", () => {
  expect(launchOf(grant(["tool:read", "tool:grep", "request.open"]), plan)).toEqual({ tools: { allow: ["read", "grep"] } });
  expect(launchOf(grant(["request.open"]), plan)).toEqual({});
  expect(launchOf(grant(["tool:*"]), plan)).toEqual({});
  // A rule that asks grants nothing at launch; the grant still speaks of tools, so none is allowed.
  expect(launchOf(grant([{ do: "tool:Bash", ask: true }]), plan)).toEqual({ tools: { allow: [] } });
});

test("write and net rules are the box; its cwd is the session's, and tools ride along", () => {
  const launch = launchOf(grant(["tool:read", "write:/work/out/*", "write:/tmp/scratch", "net:registry.npmjs.org"]), plan);
  expect(launch.tools).toEqual({ allow: ["read"] });
  expect(launch.box).toEqual({
    sandbox: "srt",
    spec: {
      cwd: "/work",
      write: ["/work/out", "/tmp/scratch"],
      net: ["registry.npmjs.org"],
      sockets: ["/home/.niwa/niwa.sock"],
      denyRead: KEYS,
    },
  });
  // A net rule alone makes a box too, with nothing writable.
  expect(launchOf(grant(["net:gitlab.example.com"]), { ...plan, cwd: "/w", sandbox: "nono" }).box).toEqual({
    sandbox: "nono",
    spec: { cwd: "/w", write: [], net: ["gitlab.example.com"], sockets: ["/home/.niwa/niwa.sock"], denyRead: KEYS },
  });
});

test("every box closes the owner's token and the host key, whatever the grant says, in srt and in nono", () => {
  const keys = (paths: readonly string[]) => paths.map(String);
  for (const sandbox of ["srt", "nono"] as const) {
    for (const rules of [["net:example.com"], ["write:/work/out/*"], ["write:*", "net:example.com"]]) {
      const box = launchOf(grant(rules), { ...plan, sandbox }).box;
      if (box === undefined) throw new Error("a box was expected");
      const spec = boxSpec(box.spec);
      expect(keys(spec.denyRead)).toEqual(KEYS);
      if (sandbox === "srt") {
        expect(keys(srt().manifest(spec).settings.filesystem.denyRead)).toEqual(KEYS);
      } else if (rules.includes("write:*")) {
        // nono reads by allow-list: a key under a place the box may write cannot be carved out, so the box is refused.
        expect(() => nono().manifest(spec)).toThrow(SandboxUnsupported);
      } else {
        expect(nono().manifest(spec).flags).not.toContain("/home/.niwa/owner.token");
      }
    }
  }
});

test("a mask a box cannot say is refused, not widened or dropped", () => {
  expect(() => launchOf(grant(["write:/a/b.*"]), plan)).toThrow("write:/a/b.*");
  expect(() => launchOf(grant(["net:example.*"]), plan)).toThrow("net:example.*");
  expect(() => launchOf(grant(["net:example.com@x"]), plan)).toThrow("has a target");
});

test("`net:*` is no list of hosts: it is refused as unsupported by the sandbox, whichever it is", () => {
  for (const sandbox of ["srt", "nono"] as const) {
    expect(() => launchOf(grant(["write:/work/*", "net:*"]), { ...plan, sandbox })).toThrow(SandboxUnsupported);
  }
  // A rule that asks grants nothing at launch, so it names no host.
  expect(launchOf(grant([{ do: "net:*", ask: true }]), plan).box?.spec.net).toEqual([]);
});

// -- through session.start ---------------------------------------------------

test("session.start gives the control side the tools and the box of the grant, and the launch rules are not visible actions", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));

  // No niwa action is visible: no niwa MCP server is needed, and no `submit-answer` is added.
  await host.call(START, { harness: "rec", prompt: "go", cwd: "/work", visible: { actions: ["tool:Read", "net:example.com"] } });
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: [] } });
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:*"] } });

  const [boxed, plain, all] = control.starts;
  expect(boxed?.tools).toEqual({ allow: ["Read"] });
  expect(boxed?.visible?.actions).toEqual([]);
  expect(boxed?.servers).toBeUndefined();
  expect(boxed?.box?.sandbox).toBe("srt");
  const home = await realpath(host.homePath);
  expect(boxed?.box?.spec).toEqual({
    cwd: "/work",
    write: [],
    net: ["example.com"],
    sockets: [`${home}/niwa.sock`],
    denyRead: [`${home}/owner.token`, `${home}/host.key`],
  });
  expect(plain?.tools).toBeUndefined();
  expect(plain?.box).toBeUndefined();
  expect(all?.tools).toBeUndefined();
  expect(all?.box).toBeUndefined();
});

test("the sandbox the host names is the one a box is made in", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { sandbox: "nono" });
  undo.push(useSandbox("nono", passthrough("nono", () => host)));
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["write:/tmp/x/*"] } });
  expect(control.starts[0]?.box?.sandbox).toBe("nono");
});

test("a session hands on only the tool, write and net rules it holds", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] } });
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(START, {
    harness: "rec",
    prompt: "go",
    visible: { actions: ["session.start", "net:example.com", "tool:Read", "tool:Grep"] },
  });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());

  await parent.call(START, { harness: "rec", prompt: "go", visible: { actions: ["net:example.com", "tool:Read"] } });
  expect(control.starts[1]?.box?.spec.net).toEqual(["example.com"]);
  expect(control.starts[1]?.tools).toEqual({ allow: ["Read"] });

  for (const wider of ["net:gitlab.com", "tool:Bash", "write:/tmp"]) {
    await expect(parent.call(START, { harness: "rec", prompt: "go", visible: { actions: [wider] } })).rejects.toThrow(wider);
  }
  expect(control.starts).toHaveLength(2);
});

test("a child of a limited caller is never wider: it takes the launch rules it did not ask for", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] } });
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(START, {
    harness: "rec",
    prompt: "go",
    visible: { actions: ["session.start", "tool:Read", "tool:Grep", "write:/tmp/x/*", "net:example.com"] },
  });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());

  // Asking for nothing is not asking to be unconfined: the child has the tools and the box of the caller.
  await parent.call(START, { harness: "rec", prompt: "go", cwd: "/work" });
  // Asking for one verb leaves the others the caller's: tools narrowed, the box not dropped.
  await parent.call(START, { harness: "rec", prompt: "go", cwd: "/work", visible: { actions: ["tool:Read"] } });

  const [, bare, narrowed] = control.starts;
  expect(bare?.tools).toEqual({ allow: ["Read", "Grep"] });
  expect(bare?.box?.spec.write).toEqual(["/tmp/x"]);
  expect(bare?.box?.spec.net).toEqual(["example.com"]);
  expect(narrowed?.tools).toEqual({ allow: ["Read"] });
  expect(narrowed?.box?.spec.write).toEqual(["/tmp/x"]);
  expect(narrowed?.box?.spec.net).toEqual(["example.com"]);

  // The owner is unlimited in what it hands down: its children stay unboxed unless they ask.
  await host.call(START, { harness: "rec", prompt: "go" });
  expect(control.starts[3]?.tools).toBeUndefined();
  expect(control.starts[3]?.box).toBeUndefined();
});

test("a limited caller with no launch rules hands down none: its child stays as the harness has it", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] } });
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["session.start"] } });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());
  await parent.call(START, { harness: "rec", prompt: "go" });
  expect(control.starts[1]?.tools).toBeUndefined();
  expect(control.starts[1]?.box).toBeUndefined();
});

// -- per harness -------------------------------------------------------------

test("pi and codex are launched with the flags of the grant", async () => {
  const dir = await workdir();
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: await fake(dir, "pi", FAKE_PI) });
  const codex = codexControl({ harness: "codex-fake", binary: await fake(dir, "codex", FAKE_CODEX) });
  cleanups.push(async () => {
    await pi.dispose();
    await codex.dispose();
  });
  undo.push(onSpawn((event) => spawns.push(event)));
  const host = await served([
    { instance: instance("pi-fake"), control: pi },
    { instance: instance("codex-fake"), control: codex },
  ]);

  await host.call(START, { harness: "pi-fake", prompt: "", cwd: dir, visible: { actions: ["tool:read", "tool:grep"] } });
  await host.call(START, { harness: "pi-fake", prompt: "", cwd: dir });
  await host.call(START, { harness: "codex-fake", prompt: "", cwd: dir, visible: { actions: ["tool:web_search", ...CODEX_KEPT] } });
  await host.call(START, { harness: "codex-fake", prompt: "", cwd: dir, visible: { actions: ["tool:*"] } });

  expect(spawns.map((event) => event.argv.slice(1))).toEqual([
    ["--mode", "rpc", "--tools", "read,grep"],
    ["--mode", "rpc"],
    ["app-server", "--stdio", "-c", "features.shell_tool=false"],
    ["app-server", "--stdio"],
  ]);
});

test("the Claude SDK is given the allowance of the grant as its tools", async () => {
  const fakeQuery = fakeSdkQuery();
  const seen: Array<readonly string[] | undefined> = [];
  const control = new ClaudeSdkControl({
    harness: harnessId("sdk-fake"),
    query: (params) => {
      const tools = params.options?.tools;
      seen.push(Array.isArray(tools) ? tools : undefined);
      return fakeQuery.query(params);
    },
  });
  cleanups.push(() => control.dispose());
  const host = await served([{ instance: instance("sdk-fake"), control }]);
  await host.call(START, { harness: "sdk-fake", prompt: "one", visible: { actions: ["tool:Read", "tool:Grep"] } });
  expect(seen).toEqual([["Read", "Grep"]]);
});

test("mcode takes no tool flag: a grant with tool rules refuses the start by name before anything is spawned", async () => {
  const dir = await workdir();
  const control = mcodeControl({ mode: "full", harness: harnessId("mcode-fake"), binary: join(dir, "never-run") });
  cleanups.push(() => control.dispose());
  undo.push(onSpawn((event) => spawns.push(event)));
  const host = await served([{ instance: instance("mcode-fake"), control }]);
  const issued = async () => (await host.records.read(seq(0), { types: [CORE_TYPES.accessIssued] })).length;
  const before = await issued();

  await expect(host.call(START, { harness: "mcode-fake", prompt: "go", cwd: dir, visible: { actions: ["tool:read"] } })).rejects.toThrow("tool flag");
  expect(spawns).toEqual([]);
  expect(await issued()).toBe(before + 1);
});

test("a codex grant whose tools leave out what Codex cannot switch off refuses the start before anything is spawned", async () => {
  const dir = await workdir();
  const codex = codexControl({ harness: "codex-fake", binary: join(dir, "never-run") });
  cleanups.push(() => codex.dispose());
  undo.push(onSpawn((event) => spawns.push(event)));
  const host = await served([{ instance: { ...instance("codex-fake"), sides: { control: { ...instance("codex-fake").sides.control!, tools: { niwaOnly: false, allow: true } } } }, control: codex }]);

  await expect(host.call(START, { harness: "codex-fake", prompt: "go", cwd: dir, visible: { actions: ["tool:web_search"] } })).rejects.toThrow(
    "Codex cannot switch apply_patch, update_plan, view_image off",
  );
  // Only niwa's tools is refused by the installation itself, before the side is asked.
  await expect(host.call(START, { harness: "codex-fake", prompt: "go", cwd: dir, tools: "niwa-only" })).rejects.toThrow("tools niwa-only");
  expect(spawns).toEqual([]);
});

// -- the box and its manifest ------------------------------------------------

test("a grant with write and net starts the process in a box whose manifest is recorded before the process", async () => {
  const dir = await workdir();
  const codex = codexControl({ harness: "codex-fake", binary: await fake(dir, "codex", FAKE_CODEX) });
  cleanups.push(() => codex.dispose());
  const manifests: BoxRecord[] = [];
  const journalAtLaunch: string[][] = [];
  undo.push(onSpawn((event) => spawns.push(event)), onBoxManifest((made) => void manifests.push(made)));
  const host = await served([{ instance: instance("codex-fake"), control: codex }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host, journalAtLaunch)));

  const { ref: session } = (await host.call(START, {
    harness: "codex-fake",
    prompt: "",
    cwd: dir,
    visible: { actions: [`write:${dir}/*`, "net:registry.npmjs.org"] },
  })) as { ref: string };

  // The process was started in the sandbox, and the journal already held the record at that moment.
  expect(spawns.map((event) => event.sandbox)).toEqual(["srt"]);
  expect(journalAtLaunch).toEqual([["session.box.manifest"]]);

  const rows = await host.records.read(seq(0), { types: [SessionBoxManifest.name, SessionMarked.name] });
  expect(rows.map((row) => String(row.type))).toEqual(["session.box.manifest", "session.marked"]);
  const data = SessionBoxManifest.schema.parse(rows[0]?.data);
  const marked = SessionMarked.schema.parse(rows[1]?.data);
  expect(String(marked.session)).toBe(session);
  expect(data.mark).toBe(marked.mark);
  expect(data.harness).toBe("codex-fake");
  expect(data.sandbox).toBe("srt");

  // It matches the spec the funnel made: the grant's places and hosts, then what codex needs inside.
  expect(data.spec.write.map(String)).toEqual([dir, homePath(".codex")]);
  expect(data.spec.net.map(String)).toEqual(["registry.npmjs.org", "api.openai.com", "chatgpt.com"]);
  expect(String(data.spec.cwd)).toBe(dir);
  expect(data.spec.sockets.map(String)).toEqual([`${await realpath(host.homePath)}/niwa.sock`]);
  const made = manifests[0]!;
  expect(data.spec).toEqual({ ...made.spec, env: Object.fromEntries(Object.entries(made.spec.env).filter(([name]) => name !== "NIWA_ID")) });
  expect(data.manifest.env).toEqual(data.spec.env);

  // The journal keeps no token: the session's own is in the process's environment, not in the record.
  const token = made.spec.env["NIWA_ID" as keyof typeof made.spec.env];
  expect(token).toBeDefined();
  expect(JSON.stringify(rows)).not.toContain(token as string);
});

test("a box that is not available stops the start: nothing is spawned, no token or mark is made", async () => {
  const control = new Recording();
  undo.push(onSpawn((event) => spawns.push(event)));
  const host = await served([{ instance: instance("rec"), control }]);
  undo.push(useSandbox("srt", unavailable("srt")));
  const issued = async () => (await host.records.read(seq(0), { types: [CORE_TYPES.accessIssued] })).length;
  const before = await issued();

  const error = await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["net:example.com"] } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(String(error)).toContain("sandbox srt is not available");
  expect(control.starts).toEqual([]);
  expect(spawns).toEqual([]);
  expect(await issued()).toBe(before);
  expect(await host.records.read(seq(0), { types: [SessionMarked.name, SessionBoxManifest.name] })).toHaveLength(0);

  // Tools alone need no box: the same host starts such a session.
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:Read"] } });
  expect(control.starts).toHaveLength(1);
});

// -- a resume after the process is gone ------------------------------

const RESUME = actionName("session.resume");
const MINE = actionName("access.mine");

/** A session born with `actions`, whose host is then stopped: the journal is all that is left of it. */
async function bornAndLeft(actions: string[], cwd: string | undefined) {
  const first = new Recording();
  const host = await served([{ instance: instance("rec"), control: first }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  const { session } = (await host.call(START, { harness: "rec", prompt: "go", cwd, visible: { actions } })) as { session: string };
  await host.close();
  return { first, session, home: host.homePath };
}

test("a boxed session resumes after a host restart with its tools, its box and its own token", async () => {
  const dir = await workdir();
  const { first, session, home } = await bornAndLeft(["tool:Read", "tool:Grep", `write:${dir}/*`, "net:example.com"], dir);

  const second = new Recording();
  second.running = "unknown";
  const host = await restarted(home, [{ instance: instance("rec"), control: second }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(RESUME, { session });

  const born = first.starts[0]!;
  const [resumed] = second.resumes;
  expect(resumed?.tools).toEqual({ allow: ["Read", "Grep"] });
  expect(resumed?.tools).toEqual(born.tools);
  expect({ ...resumed?.box, mark: undefined }).toEqual({ ...born.box, mark: undefined });
  expect(resumed?.visible).toEqual({ actions: [], disabledTools: [] });

  // NIWA_ID is the session's own token: not the one it was born with, not the owner's, and it holds the grant.
  const id = resumed?.env?.["NIWA_ID"];
  expect(id).toBeDefined();
  expect(id).not.toBe(born.env?.["NIWA_ID"]);
  const self = await connect({ home, token: token(id ?? "") });
  cleanups.push(() => self.close());
  const mine = (await self.call(MINE, {})) as { principal?: { kind: string }; unlimited: boolean; rules: unknown[] };
  expect(mine.principal?.kind).toBe("session");
  expect(mine.unlimited).toBe(false);
  expect(mine.rules).toEqual(expect.arrayContaining(["tool:Read", "tool:Grep", `write:${dir}/*`, "net:example.com"]));
});

test("an unboxed session resumes unboxed, with its own tools and its own token", async () => {
  const { first, session, home } = await bornAndLeft(["tool:Read"], undefined);
  expect(first.starts[0]?.box).toBeUndefined();

  const second = new Recording();
  second.running = "unknown";
  const host = await restarted(home, [{ instance: instance("rec"), control: second }]);
  await host.call(RESUME, { session });

  const [resumed] = second.resumes;
  expect(resumed?.tools).toEqual({ allow: ["Read"] });
  expect(resumed?.box).toBeUndefined();
  expect(resumed?.servers).toBeUndefined();
  const id = resumed?.env?.["NIWA_ID"];
  expect(id).toBeDefined();
  expect(id).not.toBe(first.starts[0]?.env?.["NIWA_ID"]);
  expect(await host.records.read(seq(0), { types: [SessionBoxManifest.name] })).toHaveLength(0);
});

test("a resume of a running session carries only its token, and the grant survives the next restart", async () => {
  const dir = await workdir();
  const { session, home } = await bornAndLeft(["tool:Read", `write:${dir}/*`], dir);

  const live = new Recording();
  const host = await restarted(home, [{ instance: instance("rec"), control: live }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(RESUME, { session });
  // The process keeps what it was born with: nothing is asked of it but the token and where its reverse requests go.
  expect(Object.keys(live.resumes[0] ?? {})).toEqual(["env", "reverse"]);
  expect(live.resumes[0]?.env?.["NIWA_ID"]).toBeDefined();
  await host.close();

  const dead = new Recording();
  dead.running = "unknown";
  const again = await restarted(home, [{ instance: instance("rec"), control: dead }]);
  undo.push(useSandbox("srt", passthrough("srt", () => again)));
  await again.call(RESUME, { session });
  expect(dead.resumes[0]?.tools).toEqual({ allow: ["Read"] });
  expect(dead.resumes[0]?.box?.spec.write).toEqual([dir]);
});

test("a resume that names its own visible actions is launched from them, not from the record", async () => {
  const { session, home } = await bornAndLeft(["tool:Read"], undefined);
  const second = new Recording();
  const host = await restarted(home, [{ instance: instance("rec"), control: second }]);
  await host.call(RESUME, { session, visible: { actions: ["tool:Grep"] } });
  expect(second.resumes[0]?.tools).toEqual({ allow: ["Grep"] });
});

test("codex resumed after a restart is born again with the tool flags, the box manifest and the NIWA_ID of its grant", async () => {
  const dir = await workdir();
  const binary = await fake(dir, "codex", FAKE_CODEX);
  const manifests: BoxRecord[] = [];
  undo.push(onSpawn((event) => spawns.push(event)), onBoxManifest((made) => void manifests.push(made)));
  const born = codexControl({ harness: "codex-fake", binary });
  cleanups.push(() => born.dispose());
  const host = await served([{ instance: instance("codex-fake"), control: born }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  const { session } = (await host.call(START, {
    harness: "codex-fake",
    prompt: "",
    cwd: dir,
    visible: { actions: ["tool:web_search", ...CODEX_KEPT, `write:${dir}/*`, "net:registry.npmjs.org"] },
  })) as { session: string };
  await host.close();

  const again = codexControl({ harness: "codex-fake", binary });
  cleanups.push(() => again.dispose());
  const restartedHost = await restarted(host.homePath, [{ instance: instance("codex-fake"), control: again }]);
  undo.push(useSandbox("srt", passthrough("srt", () => restartedHost)));
  await restartedHost.call(RESUME, { session });

  expect(spawns).toHaveLength(2);
  expect(spawns[1]?.argv.slice(1)).toEqual(spawns[0]?.argv.slice(1));
  expect(spawns[1]?.argv).toContain("features.shell_tool=false");
  expect(spawns.map((event) => event.sandbox)).toEqual(["srt", "srt"]);
  expect(spawns[0]?.env["NIWA_ID"]).toBeDefined();
  expect(spawns[1]?.env["NIWA_ID"]).toBeDefined();
  expect(spawns[1]?.env["NIWA_ID"]).not.toBe(spawns[0]?.env["NIWA_ID"]);

  // The spec the funnel made for the new process is the first one's: the token is the one thing that differs.
  expect(manifests).toHaveLength(2);
  const withoutToken = (made: BoxRecord | undefined) =>
    Object.fromEntries(Object.entries(made?.spec.env ?? {}).filter(([name]) => name !== "NIWA_ID"));
  expect({ ...manifests[1]?.spec, env: withoutToken(manifests[1]) }).toEqual({ ...manifests[0]?.spec, env: withoutToken(manifests[0]) });
  const rows = (await restartedHost.records.read(seq(0), { types: [SessionBoxManifest.name] })).map((row) => SessionBoxManifest.schema.parse(row.data));
  expect(rows).toHaveLength(2);
  expect({ ...rows[1], mark: "" }).toEqual({ ...rows[0], mark: "" });
  expect(rows[1]?.mark).not.toBe(rows[0]?.mark);
});
