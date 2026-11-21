// A session's grant becomes its launch.
//
// What it proves:
//   1. the pure derivation: `tool:` rules are the allowance, `tool:*` and no `tool:` rule leave the
//      harness its default
//   2. through `session.start` the control side is given the tools and a box, the launch rules never
//      reach the visible actions, and a request wider than the caller is still refused
//   3. a harness gets the flags of its grant: pi's argv, codex's switches, the Claude SDK's tools;
//      mcode refuses `tool:` by name before anything is spawned
//   4. a box that is not available stops the start: nothing is spawned, no token is issued
//   5. a session resumed after its process is gone is launched again with its tools and its box

import { afterEach, expect, test } from "bun:test";
import { chmod, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_TYPES, OptionIdSchema, actionName, grant, seq, TOKEN_ENV } from "@niwa-labs/core";
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
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { BoxRecord, LaunchedBox, Sandbox, SandboxName, SpawnEvent } from "@niwa-labs/sandbox";
import {
  SandboxUnavailable,
  BoxRefused,
  boxSpec,
  homePath,
  nono,
  onBoxManifest,
  onSpawn,
  spawnAgent,
  srt,
  useSandbox,
} from "@niwa-labs/sandbox";
import { SessionBoxManifest, SessionMarked, sessions, toolsOfGrant } from "@niwa-labs/sessions";
import type { SessionsOptions } from "@niwa-labs/sessions";
import { tempDir, tempHome, fakeSdkQuery, eventually, connectAsOwner, requests, stub, StubFinished } from "@niwa-labs/testing";

import { requestAnswer, requestOpen } from "@niwa-labs/requests/records";
import { boxRules } from "@niwa-labs/proc";
import { workflow, workflowCancel, workflowStart } from "@niwa-labs/workflow";
import { sessionStart, sessionEnd, sessionOpenQuestions } from "@niwa-labs/sessions/records";
import { ClaudeSdkControl } from "@niwa-labs/harness-claude";
import { CODEX_FIXED_TOOLS, codexControl, codexToolFlags } from "@niwa-labs/harness-codex";
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
      const held = await host().records.read({ types: [SessionBoxManifest.name] });
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
    if (frame.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: "s" + process.pid } }) + "\\n");
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

test("tool rules are the allowance; no tool rule and `tool:*` leave the harness its default", () => {
  expect(toolsOfGrant(grant(["tool:read", "tool:grep", "request.open"]))).toEqual({ allow: ["read", "grep"] });
  expect(toolsOfGrant(grant(["request.open"]))).toBeUndefined();
  expect(toolsOfGrant(grant(["tool:*"]))).toBeUndefined();
  // A rule that asks grants nothing at launch; the grant still speaks of tools, so none is allowed.
  expect(toolsOfGrant(grant([{ do: "tool:Bash", ask: true }]))).toEqual({ allow: [] });
  expect(() => toolsOfGrant(grant(["tool:Read@x"]))).toThrow("has a target");
});

// -- through session.start ---------------------------------------------------

test("session.start gives the control side the tools of the grant and a box, and the launch rules are not visible actions", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));

  // No niwa action is visible: no niwa MCP server is needed, and no `submit-answer` is added.
  await host.call(START, { harness: "rec", prompt: "go", cwd: "/work", visible: { actions: ["tool:Read"] }, box: { allow: [{ net: "example.com" }] } });
  await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:*"] } });

  const [boxed, all] = control.starts;
  expect(boxed?.tools).toEqual({ allow: ["Read"] });
  expect(boxed?.visible?.actions).toEqual([]);
  expect(boxed?.servers).toBeUndefined();
  const home = await realpath(host.homePath);
  const spec = boxSpec(boxed?.box?.spec ?? { cwd: "/" });
  const write = spec.write.map(String);
  expect(String(spec.cwd)).toBe("/work");
  expect(write).toContain("/work");
  expect(spec.net.map(String)).toEqual(["example.com"]);
  expect(spec.sockets.map(String)).toEqual([`${home}/niwa.sock`]);
  expect(spec.closed.map(String)).toEqual(expect.arrayContaining([`${home}/owner.token`, `${home}/host.key`, `${home}/journal.db`, `${home}/secrets`]));
  // Its temp directory is its own, and the process is told it.
  expect(write).toContain(boxed?.env?.["TMPDIR"] ?? "");
  expect(all?.tools).toBeUndefined();
  expect(all?.box).toBeDefined();
});

test("a session hands on only the tools and the box rules it holds", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] } });
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(START, {
    harness: "rec",
    prompt: "go",
    visible: { actions: ["session.start", "box.net@example.com", "tool:Read", "tool:Grep"] },
  });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());

  await parent.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:Read"] }, box: { allow: [{ net: "example.com" }] } });
  expect(control.starts[1]?.box?.spec.net?.map(String)).toEqual(["example.com"]);
  expect(control.starts[1]?.tools).toEqual({ allow: ["Read"] });

  await expect(parent.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:Bash"] } })).rejects.toThrow("tool:Bash");
  for (const [wider, rule] of [[{ net: "gitlab.com" }, "box.net@gitlab.com"], [{ write: "/tmp" }, "box.write@/private/tmp"]] as const) {
    await expect(parent.call(START, { harness: "rec", prompt: "go", box: { allow: [wider] } })).rejects.toThrow(rule);
  }
  expect(control.starts).toHaveLength(2);
});

test("a child of a limited caller is never wider: it takes the tools it did not ask for, and the box is the host's", async () => {
  const control = new Recording();
  const host = await served([{ instance: instance("rec"), control }], { niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] } });
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(START, {
    harness: "rec",
    prompt: "go",
    visible: { actions: ["session.start", "tool:Read", "tool:Grep"] },
    box: { allow: [{ net: "example.com" }] },
  });
  const parent = await connect({ home: host.homePath, token: token(control.starts[0]?.env?.["NIWA_ID"] ?? "") });
  cleanups.push(() => parent.close());

  // Asking for nothing is not asking to be unconfined: the child has the tools of the caller and the host's box.
  await parent.call(START, { harness: "rec", prompt: "go", cwd: "/work" });
  await parent.call(START, { harness: "rec", prompt: "go", cwd: "/work", visible: { actions: ["tool:Read"] } });

  const [, bare, narrowed] = control.starts;
  expect(bare?.tools).toEqual({ allow: ["Read", "Grep"] });
  expect(bare?.box?.spec.net?.map(String)).toEqual([]);
  expect(narrowed?.tools).toEqual({ allow: ["Read"] });
  expect(narrowed?.box?.spec.net?.map(String)).toEqual([]);

  // The owner is unlimited in what it hands down: its children keep the harness's tools, in the host's box.
  await host.call(START, { harness: "rec", prompt: "go" });
  expect(control.starts[3]?.tools).toBeUndefined();
  expect(control.starts[3]?.box).toBeDefined();
});

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
    ["--mode", "rpc", "--tools", "read,grep", "--no-mcp"],
    ["--mode", "rpc"],
    ["app-server", "--stdio", ...codexToolFlags(["web_search", ...CODEX_FIXED_TOOLS])],
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
  const issued = async () => (await host.records.read({ types: [CORE_TYPES.accessIssued] })).length;
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
    "Codex cannot switch apply_patch off",
  );
  // Only niwa's tools is refused by the installation itself, before the side is asked.
  await expect(host.call(START, { harness: "codex-fake", prompt: "go", cwd: dir, tools: "niwa-only" })).rejects.toThrow("tools niwa-only");
  expect(spawns).toEqual([]);
});

// -- the box and its manifest ------------------------------------------------


test("a box that is not available stops the start: nothing is spawned, no token or mark is made", async () => {
  const control = new Recording();
  undo.push(onSpawn((event) => spawns.push(event)));
  const host = await served([{ instance: instance("rec"), control }]);
  undo.push(useSandbox("srt", unavailable("srt")));
  const issued = async () => (await host.records.read({ types: [CORE_TYPES.accessIssued] })).length;
  const before = await issued();

  const error = await host.call(START, { harness: "rec", prompt: "go", visible: { actions: ["tool:Read"] } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(String(error)).toContain("sandbox srt is not available");
  expect(control.starts).toEqual([]);
  expect(spawns).toEqual([]);
  expect(await issued()).toBe(before);
  expect(await host.records.read({ types: [SessionMarked.name, SessionBoxManifest.name] })).toHaveLength(0);
});

// -- a resume after the process is gone ------------------------------

const RESUME = actionName("session.resume");
const MINE = actionName("access.mine");

/** A box with its own temp directory left out: each launch has a new one. */
const withoutTemp = (box: StartOptions["box"] | undefined, env: Readonly<Record<string, string>> | undefined) => {
  const spec = boxSpec(box?.spec ?? { cwd: "/" });
  return { ...spec, write: spec.write.map(String).filter((path) => path !== env?.["TMPDIR"]) };
};

/** A session born with `actions` and `box`, whose host is then stopped: the journal is all that is left of it. */
async function bornAndLeft(actions: string[], cwd: string | undefined, box?: { allow: Array<{ net: string } | { write: string }> }) {
  const first = new Recording();
  const host = await served([{ instance: instance("rec"), control: first }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  const { session } = (await host.call(START, { harness: "rec", prompt: "go", cwd, visible: { actions }, ...(box === undefined ? {} : { box }) })) as { session: string };
  await host.close();
  return { first, session, home: host.homePath };
}

test("a session resumes after a host restart with its tools, its box and its own token", async () => {
  const dir = await workdir();
  const { first, session, home } = await bornAndLeft(["tool:Read", "tool:Grep", "box.net@example.com"], dir, { allow: [{ net: "example.com" }] });

  const second = new Recording();
  second.running = "unknown";
  const host = await restarted(home, [{ instance: instance("rec"), control: second }]);
  undo.push(useSandbox("srt", passthrough("srt", () => host)));
  await host.call(RESUME, { session });

  const born = first.starts[0]!;
  const [resumed] = second.resumes;
  expect(resumed?.tools).toEqual({ allow: ["Read", "Grep"] });
  expect(resumed?.tools).toEqual(born.tools);
  // The same box, with the same request: only its temp directory is new.
  expect(withoutTemp(resumed?.box, resumed?.env)).toEqual(withoutTemp(born.box, born.env));
  expect(resumed?.box?.spec.net?.map(String)).toEqual(["example.com"]);
  expect(resumed?.env?.["TMPDIR"]).not.toBe(born.env?.["TMPDIR"]);
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
  expect(mine.rules).toEqual(expect.arrayContaining(["tool:Read", "tool:Grep", "call:box.net@example.com"]));
});

test("a resume of a running session carries only its token, and the grant survives the next restart", async () => {
  const dir = await workdir();
  const { session, home } = await bornAndLeft(["tool:Read"], dir, { allow: [{ net: "example.com" }] });

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
  expect(dead.resumes[0]?.box?.spec.net?.map(String)).toEqual(["example.com"]);
  expect(dead.resumes[0]?.box?.spec.write?.map(String)).toContain(await realpath(dir));
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
    visible: { actions: ["tool:web_search", ...CODEX_KEPT] },
    box: { allow: [{ net: "registry.npmjs.org" }] },
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

  // The spec the funnel made for the new process is the first one's: the token and the temp directory are what differ.
  expect(manifests).toHaveLength(2);
  const same = (made: BoxRecord | undefined) => {
    const temp = made?.spec.env["TMPDIR" as keyof typeof made.spec.env];
    const env = Object.fromEntries(Object.entries(made?.spec.env ?? {}).filter(([name]) => name !== "NIWA_ID" && name !== "TMPDIR"));
    return { ...made?.spec, env, write: made?.spec.write.map(String).filter((path) => path !== temp) };
  };
  expect(same(manifests[1])).toEqual(same(manifests[0]));
  const rows = (await restartedHost.records.read({ types: [SessionBoxManifest.name] })).map((row) => SessionBoxManifest.schema.parse(row.data));
  expect(rows).toHaveLength(2);
  const kept = (row: (typeof rows)[number] | undefined) => ({ ...row, mark: "", paths: row?.paths.filter((need) => need.from !== "temp") });
  expect(kept(rows[1])).toEqual(kept(rows[0]));
  expect(rows[1]?.request.items).toContainEqual({ item: { net: "registry.npmjs.org" }, from: "call" });
  expect(rows[1]?.mark).not.toBe(rows[0]?.mark);
});


test.each(["cancel", "finish"])("a run owns its authenticated session helpers through %s", async (termination) => {
  const home = await tempHome();
  const cwd = await realpath(await workdir());
  const file = join(home.path, "helpers.js");
  await writeFile(file, [
    'export default workflow({ uses: ["session.start@rec", "session.end", "niwa.records.read", "box.net@example.org"] }, async () => {',
    '  await call("session.start", { harness: "rec", prompt: "", cwd: ' + JSON.stringify(cwd) + ', tools: "niwa-only", box: { only: [] }, visible: { actions: ["session.start@rec", "session.end", {do:"box.net@example.org",ask:true}] } }, { label: "parent" });',
    '  await wait("stub.finished", { filter: { id: "stop" } });',
    '});',
  ].join("\n"));
  const stopped: string[] = [];
  class Running extends Recording {
    private readonly lives = new Map<string, () => void>();
    override async *life(id?: SessionId) {
      if (id !== undefined) await new Promise<void>((done) => this.lives.set(id.native, done));
    }
    async close(id: SessionId) {
      stopped.push(id.native);
      this.lives.get(id.native)?.();
    }
  }
  const harness = new Running();
  const host = createNiwa({ home: home.path });
  host.use(requests(), boxRules(), stub(home.path), sessions({
    harnesses: [{ instance: instance("rec"), control: harness }],
    niwaMcp: { command: "niwa", args: ["mcp"] },
  }), workflow({ triggers: [StubFinished] }));
  await host.serve();
  cleanups.push(async () => { await host.close(); await home.cleanup(); });
  const { run } = await host.call(workflowStart, { file });
  await eventually(async () => (await host.records.read({ types: [SessionMarked.name] })).length === 1, 15000);
  const connectSession = async (index: number) => {
    const value = harness.starts[index]?.env?.[TOKEN_ENV];
    if (value === undefined) throw new Error("the harness did not receive its token");
    const client = await connect({ home: home.path, token: token(value) });
    cleanups.push(() => client.close());
    return client;
  };
  const parent = await connectSession(0);
  const helper = { harness: "rec", prompt: "", operation: "nested-helper" };
  const child = await parent.call(sessionStart, helper);
  expect(await parent.call(sessionStart, helper)).toEqual(child);
  expect(harness.starts).toHaveLength(2);
  expect(harness.starts[1]).toMatchObject({ cwd, tools: "niwa-only" });
  const records = await host.records.read();
  const births = records.filter((r) => r.type === "session.started").map((r) => r.data);
  expect(births).toMatchObject([
    { run, session: "rec s1" },
    { run, session: child.ref, parentSession: "rec s1", boxAccess: { only: [] } },
  ]);
  const childClient = await connectSession(1);
  await expect(childClient.call(sessionEnd, { session: "rec s1", reason: "try to end parent" })).rejects.toThrow("outside");
  await expect(childClient.call(sessionStart, { ...helper, operation: "other-dir", cwd: home.path })).rejects.toThrow("working directory");
  await expect(childClient.call(sessionStart, { ...helper, operation: "other-harness", harness: "admin" })).rejects.toThrow();
  await expect(childClient.call(sessionStart, { ...helper, operation: "network", box: { allow: [{ net: "example.org" }] } })).rejects.toThrow();
  await expect(childClient.call(sessionOpenQuestions, { mark: "someone-else" })).rejects.toThrow("another session");
  const answer = harness.starts[1]?.reverse?.(sessionId(harnessId("rec"), "s2"), {
    raw: { method: "test/permission", params: {} }, signal: new AbortController().signal,
    question: { kind: "permission", title: "Permit a helper tool?", subject: { kind: "execute", tool: "Shell", target: "test" },
      options: [{ id: OptionIdSchema.parse("deny"), label: "Deny", flavor: "reject_once" }] },
  });
  let question: string | undefined;
  await eventually(async () => {
    const { requests } = await host.call(requestOpen, {});
    for (const entry of requests) {
      if (!("kind" in entry) && entry.question === "session.reverse") {
        expect(entry.to).toEqual({ kind: "owner" });
        question = entry.id;
      }
    }
    return question !== undefined;
  });
  if (question === undefined) throw new Error("the owner did not receive the question");
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  await owner.call(requestAnswer, { id: question, answer: { ids: ["deny"] } });
  expect(await answer).toEqual({ ids: [OptionIdSchema.parse("deny")] });
  if (termination === "cancel") await host.call(workflowCancel, { run });
  else await host.call(actionName("stub.finish"), { id: "stop" });
  await eventually(() => stopped.includes("s1") && stopped.includes("s2"));
  await expect(childClient.call(sessionStart, { ...helper, operation: "after-cancel" })).rejects.toThrow("closed");
  expect(harness.starts).toHaveLength(2);
  expect(stopped.sort()).toEqual(["s1", "s2"]);
}, 60000);
