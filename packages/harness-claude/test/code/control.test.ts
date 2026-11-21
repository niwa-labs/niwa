/**
 * The Claude Code control side.
 *
 * Claude Code speaks the Agent Client Protocol, so the offline tests drive a fake ACP adapter
 * that speaks the same JSON-RPC wire. The live test runs the real ACP adapter against Claude
 * Code and runs only with `NIWA_LIVE=1` and the adapter on PATH. Every test disposes its
 * control side, so no child outlives it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { InputNotSent, modelName, promptFromText, type LifeEvent, type SessionControl, type StartOptions } from "@niwa-labs/harness";
import { onSpawn } from "@niwa-labs/sandbox";
import type { SessionId } from "@niwa-labs/harness";
import {
  claudeCodeControl,
  type ClaudeCodeSessionControl,
} from "../../src/code/control.ts";

import { tempDir, live } from "@niwa-labs/testing";

let dir = "";
let control: ClaudeCodeSessionControl | undefined;

beforeEach(async () => {
  dir = await tempDir("claude-control");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  await rm(dir, { recursive: true, force: true });
});

/**
 * A fake ACP adapter for Claude Code: answers `initialize` and `session/new`, then runs each
 * prompt as a turn of `turnMs`, one after another; the first turn takes `firstMs`, or never ends
 * when `firstMs` is `"never"`. It asks for permission on the first turn when `toolRequest` is
 * set. It exits at turn `crashAt`. A `strict` agent refuses a prompt while another one is active
 * ("A prompt is already active"), as a real agent does, and a `cancelLagMs` agent answers a
 * cancelled prompt that long after the cancel.
 */
async function fakeAgent(options: {
  turnMs: number;
  firstMs?: number | "never";
  crashAt?: number;
  deadOnStart?: boolean;
  toolRequest?: boolean;
  word?: boolean;
  strict?: boolean;
  cancelLagMs?: number;
  refuseModel?: boolean;
  refuseMode?: boolean;
  /** The model the program names in its `system/init` message, which the adapter forwards with the first turn. */
  runs?: string;
}) {
  const path = join(dir, "fake-acp");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "spawns.log"))}, process.argv.slice(2).join(" ") + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (${options.deadOnStart === true}) { process.stderr.write("not signed in"); process.exit(3); }
let turn = 0;
let busy = false;
let cancelled = false;
const jobs = [];
async function drain() {
  if (busy) return;
  busy = true;
  while (jobs.length > 0) {
    const job = jobs.shift();
    turn += 1;
    if (${JSON.stringify(options.runs ?? null)} !== null && turn === 1) {
      out({ jsonrpc: "2.0", method: "_niwa/session_model", params: { sessionId: "fake-session", model: ${JSON.stringify(options.runs ?? null)} } });
    }
    if (${options.toolRequest === true} && turn === 1) {
      // The agent asks for permission; the client must answer with the same id.
      out({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: "fake-session", options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ], toolCall: { toolCallId: "tu-1", title: "Bash", rawInput: { command: "ls" } } } });
      await Bun.sleep(50);
    }
    if (turn === 1 && ${options.firstMs === "never"}) await new Promise(() => {});
    for (let waited = 0; waited < (turn === 1 ? ${typeof options.firstMs === "number" ? options.firstMs : 0} : ${options.turnMs}) && !cancelled; waited += 10) await Bun.sleep(10);
    if (cancelled) {
      cancelled = false;
      await Bun.sleep(${options.cancelLagMs ?? 0});
      out({ jsonrpc: "2.0", id: job.id, result: { stopReason: "cancelled" } });
      continue;
    }
    if (turn === ${options.crashAt ?? 0}) process.exit(1);
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${options.word === true} ? JSON.stringify({ word: "ok" }) : "ok" } } } });
    out({ jsonrpc: "2.0", id: job.id, result: { stopReason: "end_turn" } });
  }
  busy = false;
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.method === "initialize") {
      out({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    } else if (frame.method === "session/new") {
      appendFileSync(${JSON.stringify(join(dir, "sessions.log"))}, JSON.stringify(frame.params) + "\\n");
      out({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [] }, models: { currentModelId: "default", availableModels: [] }, configOptions: [] } });
    } else if (frame.method === "session/load") {
      appendFileSync(${JSON.stringify(join(dir, "sessions.log"))}, JSON.stringify(frame.params) + "\\n");
      out({ jsonrpc: "2.0", id: frame.id, result: { sessionId: frame.params.sessionId } });
    } else if (frame.method === "session/set_model" && ${options.refuseModel === true}) {
      out({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "Invalid params: unknown model" } });
    } else if (frame.method === "session/set_mode" && ${options.refuseMode === true}) {
      out({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Internal error", data: { details: "Invalid Mode" } } });
    } else if (frame.method === "session/set_model" || frame.method === "session/set_mode") {
      appendFileSync(${JSON.stringify(join(dir, "settings.log"))}, JSON.stringify(frame.params) + "\\n");
      out({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      if (${options.strict === true} && (busy || jobs.length > 0)) {
        out({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "Invalid params: A prompt is already active for this session." } });
        continue;
      }
      jobs.push(frame);
      void drain();
    } else if (frame.method === "session/cancel") {
      appendFileSync(${JSON.stringify(join(dir, "cancel.log"))}, JSON.stringify(frame.params) + "\\n");
      cancelled = busy;
    } else if (frame.method === undefined && frame.id !== undefined) {
      // A reply from the client to the agent.
      appendFileSync(${JSON.stringify(join(dir, "replies.log"))}, JSON.stringify(frame) + "\\n");
    }
  }
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

/**
 * Start a session and wait for its first turn to end.
 *
 * The start returns once the session is named; the first turn runs on after it. A test that
 * needs the session idle waits for that turn itself, as any caller does.
 */
async function startIdle(side: SessionControl, options: StartOptions, deadlineMs = 10_000): Promise<SessionId> {
  const { session } = await side.start(options);
  const deadline = Date.now() + deadlineMs;
  while ((await side.state(session)) !== "idle") {
    if (Date.now() > deadline) throw new Error("the first turn did not end");
    await Bun.sleep(10);
  }
  return session;
}

async function collect(
  source: AsyncIterable<LifeEvent>,
  until: (events: LifeEvent[]) => boolean,
): Promise<LifeEvent[]> {
  const events: LifeEvent[] = [];
  for await (const event of source) {
    events.push(event);
    if (until(events)) break;
  }
  return events;
}

const kinds = (events: LifeEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "turn-started" || event.kind === "turn-ended" ? [`${event.kind}:${event.turn}`] : []));

const repliesOf = async (): Promise<unknown[]> =>
  (await readFile(join(dir, "replies.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

/** The params of every `session/new` and `session/load` the fake agent was asked for. */
const sessionRequestsOf = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, "sessions.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("a child that dies before answering the handshake fails the start", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, deadOnStart: true })],
  });
  await expect(control.start({ prompt: promptFromText("hi") })).rejects.toThrow();
});

test("a start that cannot spawn the adapter names the command and the cause", async () => {
  for (const missing of [join(dir, "no-such-adapter"), "niwa-no-such-adapter"]) {
    control = claudeCodeControl({ harness: "fake", command: [missing] });
    await expect(control.start({ prompt: promptFromText("hi") })).rejects.toThrow(
      new RegExp(`cannot serve control.start.*${missing}.*(ENOENT|not found)`),
    );
    await control.dispose();
  }
});

test("a child that dies before the handshake is reported with its command and its stderr", async () => {
  const agent = await fakeAgent({ turnMs: 0, deadOnStart: true });
  control = claudeCodeControl({ harness: "fake", command: [agent] });
  await expect(control.start({ prompt: promptFromText("hi") })).rejects.toThrow(
    new RegExp(`${agent}.*not signed in`),
  );
});

test("the default adapter is niwa's own entry over its dependency, not a name looked up on the PATH", async () => {
  const spawned: string[][] = [];
  const stop = onSpawn((event) => spawned.push([...event.argv]));
  control = claudeCodeControl({ harness: "fake", callTimeoutMs: 300 });
  // The adapter runs the real `claude` of the PATH, and that program writes its sessions, backups and
  // settings under HOME: the owner's own HOME must stay untouched, so it runs in the test's directory.
  const home = process.env.HOME;
  process.env.HOME = join(dir, "claude-home");
  try {
    // The adapter is real and refuses to start without a login; only the command it was run by matters.
    await control.start({ prompt: promptFromText("hi") }).catch(() => undefined);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    stop();
  }
  expect(spawned[0]?.[0]).toBe(process.execPath);
  expect(spawned[0]?.[1]).toMatch(/src\/code\/acp\/adapter\.ts$/);
});

test("the adapter drives the claude on the PATH, unless the instance names another program", async () => {
  const spawned: Array<Readonly<Record<string, string>>> = [];
  const stop = onSpawn((event) => spawned.push(event.env));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/bin/sh\n");
  await chmod(join(bin, "claude"), 0o755);
  const path = process.env.PATH;
  try {
    const fake = await fakeAgent({ turnMs: 0 });
    process.env.PATH = `${bin}:${path ?? ""}`;
    control = claudeCodeControl({ harness: "fake", command: [fake] });
    await control.start({ prompt: promptFromText("one") });
    await control.dispose();
    control = claudeCodeControl({ harness: "fake", command: [fake], executable: "/opt/claude/claude" });
    await control.start({ prompt: promptFromText("one") });
  } finally {
    process.env.PATH = path;
    stop();
  }
  expect(spawned[0]?.CLAUDE_CODE_EXECUTABLE).toBe(join(bin, "claude"));
  expect(spawned[1]?.CLAUDE_CODE_EXECUTABLE).toBe("/opt/claude/claude");
});

test("with no claude on the PATH and no executable named, the start fails and says so; the bundled program is never run", async () => {
  const spawned: string[][] = [];
  const stop = onSpawn((event) => spawned.push([...event.argv]));
  const empty = join(dir, "empty");
  await mkdir(empty);
  const path = process.env.PATH;
  try {
    const fake = await fakeAgent({ turnMs: 0 });
    control = claudeCodeControl({ harness: "fake", command: [fake] });
    process.env.PATH = empty;
    await expect(control.start({ prompt: promptFromText("one") })).rejects.toThrow(/there is no `claude` on the PATH/);
  } finally {
    process.env.PATH = path;
    stop();
  }
  expect(spawned).toEqual([]);
});

test("an effort is the program's --effort flag of that session, and a level it does not have is refused before anything starts", async () => {
  const agent = await fakeAgent({ turnMs: 0 });
  control = claudeCodeControl({ harness: "fake", command: [agent], executable: "/opt/claude/claude" });
  await startIdle(control, { prompt: promptFromText("one"), effort: "high" });
  const sessions = (await readFile(join(dir, "sessions.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(sessions[0]).toMatchObject({ _meta: { claudeCode: { options: { extraArgs: { effort: "high" } } } } });

  await expect(control.start({ prompt: promptFromText("two"), effort: "extreme" })).rejects.toThrow(
    /effort "extreme" is not one of low, medium, high, xhigh, max/,
  );
  expect((await readFile(join(dir, "spawns.log"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("a model the session does not take fails the start, and nothing keeps running", async () => {
  const agent = await fakeAgent({ turnMs: 0, refuseModel: true });
  control = claudeCodeControl({ harness: "fake", command: [agent], executable: "/opt/claude/claude" });
  await expect(control.start({ prompt: promptFromText("one"), model: "nonsense" })).rejects.toThrow(
    /did not take the model "nonsense": .*unknown model/,
  );
});

test("a session is named by the agent, and the model and mode are set on it", async () => {
  const agent = await fakeAgent({ turnMs: 0 });
  control = claudeCodeControl({
    harness: "fake",
    command: [agent],
    model: "haiku",
    mode: "full",
  });
  const id = await startIdle(control, { prompt: promptFromText("one") });

  expect(String(id.native)).toBe("fake-session");
  expect(await control.state(id)).toBe("idle");

  const settings = (await readFile(join(dir, "settings.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(settings).toContainEqual({ sessionId: "fake-session", modelId: "haiku" });
  expect(settings).toContainEqual({ sessionId: "fake-session", modeId: "bypassPermissions" });
});

test("the model the adapter forwards from the program's init message is a sign of life, the name and not the alias", async () => {
  const agent = await fakeAgent({ turnMs: 0, runs: "claude-opus-real" });
  control = claudeCodeControl({ harness: "fake", command: [agent], model: "opus" });
  const { session } = await control.start({ prompt: promptFromText("one") });
  // The alias went to the session; what the program says it runs comes back with the first turn.
  expect((await readFile(join(dir, "settings.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown)).toContainEqual({
    sessionId: "fake-session",
    modelId: "opus",
  });
  const seen = await collect(control.life(session), (events) => events.some((event) => event.kind === "model"));
  expect(seen.find((event) => event.kind === "model")).toEqual({ kind: "model", model: modelName("claude-opus-real") });
});

test("a session reattached by a new process is put on the model that was named for it, and a refusal fails the resume", async () => {
  const agent = await fakeAgent({ turnMs: 0, runs: "claude-opus-real" });
  control = claudeCodeControl({ harness: "fake", command: [agent], model: "haiku" });
  const id = await startIdle(control, { prompt: promptFromText("one") });
  await control.dispose();

  control = claudeCodeControl({ harness: "fake", command: [agent], model: "haiku" });
  await control.resume(id, { model: modelName("claude-opus-real") });
  const settings = (await readFile(join(dir, "settings.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  // The instance's own model is not put on a resumed session: the one it ran is.
  expect(settings.flatMap((frame) => (frame["modelId"] === undefined ? [] : [frame["modelId"]]))).toEqual(["haiku", "claude-opus-real"]);
  await control.dispose();

  control = claudeCodeControl({ harness: "fake", command: [await fakeAgent({ turnMs: 0, refuseModel: true })] });
  await expect(control.resume(id, { model: modelName("gone") })).rejects.toThrow(/did not take the model "gone"/);
});

test("a session reattached by a new process is loaded with the directory it was started in, not the one of this process", async () => {
  const agent = await fakeAgent({ turnMs: 0 });
  control = claudeCodeControl({ harness: "fake", command: [agent] });
  const started = join(dir, "elsewhere");
  await mkdir(started, { recursive: true });
  const id = await startIdle(control, { prompt: promptFromText("one"), cwd: started });
  await control.dispose();

  control = claudeCodeControl({ harness: "fake", command: [agent] });
  await control.resume(id, { cwd: started });
  const requests = await sessionRequestsOf();
  expect(requests.map((request) => request["cwd"])).toEqual([started, started]);
  expect(process.cwd()).not.toBe(started);
});

const modesSet = async (): Promise<unknown[]> =>
  (await readFile(join(dir, "settings.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .flatMap((frame) => (frame["modeId"] === undefined ? [] : [frame["modeId"]]));

test("a working mode is the adapter's mode: ask is default, auto is acceptEdits (the adapter has no auto), full is bypassPermissions; auto when none is chosen", async () => {
  control = claudeCodeControl({ harness: "fake", command: [await fakeAgent({ turnMs: 0 })] });
  const modes = [
    ["ask", "default"],
    ["auto", "acceptEdits"],
    ["full", "bypassPermissions"],
  ] as const;
  for (const [mode, adapter] of modes) {
    const started = await control.start({ prompt: promptFromText(""), mode });
    expect(started.mode).toBe(mode);
    expect((await modesSet()).at(-1)).toBe(adapter);
  }
  const unchosen = await control.start({ prompt: promptFromText("") });
  expect(unchosen.mode).toBe("auto");
  expect((await modesSet()).at(-1)).toBe("acceptEdits");
});

test("the control option is the default mode, and a mode the call names wins", async () => {
  control = claudeCodeControl({ harness: "fake", command: [await fakeAgent({ turnMs: 0 })], mode: "ask" });
  expect((await control.start({ prompt: promptFromText("") })).mode).toBe("ask");
  expect((await modesSet()).at(-1)).toBe("default");
  expect((await control.start({ prompt: promptFromText(""), mode: "full" })).mode).toBe("full");
  expect((await modesSet()).at(-1)).toBe("bypassPermissions");
});

test("a mode the adapter does not take fails the start, and nothing keeps running", async () => {
  control = claudeCodeControl({ harness: "fake", command: [await fakeAgent({ turnMs: 0, refuseMode: true })] });
  await expect(control.start({ prompt: promptFromText(""), mode: "auto" })).rejects.toThrow(/did not take the mode "auto"/);
});

test("a session reattached by a new process is put in the mode it was started in", async () => {
  const agent = await fakeAgent({ turnMs: 0 });
  control = claudeCodeControl({ harness: "fake", command: [agent] });
  const id = await startIdle(control, { prompt: promptFromText("one"), mode: "ask" });
  await control.dispose();

  control = claudeCodeControl({ harness: "fake", command: [agent] });
  await control.resume(id, { mode: "ask" });
  expect((await modesSet()).at(-1)).toBe("default");
});

test("the MCP servers of a start are the mcpServers of the session the agent is asked for", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  await control.start({
    prompt: promptFromText("one"),
    servers: [
      {
        name: "niwa",
        command: "bun",
        args: ["bin/niwa.ts", "mcp"],
        env: { NIWA_VISIBLE: "session.send" },
      },
    ],
  });

  const requests = await sessionRequestsOf();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.["mcpServers"]).toEqual([
    {
      name: "niwa",
      command: "bun",
      args: ["bin/niwa.ts", "mcp"],
      env: [{ name: "NIWA_VISIBLE", value: "session.send" }],
    },
  ]);
});

test("tools switched off are passed to Claude Code as disallowedTools; a held session refuses another set", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  const id = await startIdle(control, {
    prompt: promptFromText("one"),
    visible: { actions: [], disabledTools: ["Bash", "WebFetch"] },
  });

  const requests = await sessionRequestsOf();
  expect(requests[0]?.["_meta"]).toEqual({ claudeCode: { options: { disallowedTools: ["Bash", "WebFetch"] } } });

  // The same set is no change; another set cannot be given to a running session.
  await control.resume(id, { visible: { actions: [], disabledTools: ["WebFetch", "Bash"] } });
  await expect(control.resume(id, { visible: { actions: [], disabledTools: [] } })).rejects.toMatchObject({
    code: "Unsupported",
  });
});

test("a resume that reattaches a session passes the tools off in the session/load _meta; a held one resumed with no visible is not refused", async () => {
  const agent = await fakeAgent({ turnMs: 0 });
  control = claudeCodeControl({ harness: "fake", command: [agent] });
  const id = await startIdle(control, {
    prompt: promptFromText("one"),
    visible: { actions: [], disabledTools: ["Bash"] },
  });
  // No visible: the held session is resumed as it is.
  await control.resume(id, { prompt: promptFromText("two") });
  await control.dispose();

  control = claudeCodeControl({ harness: "fake", command: [agent] });
  await control.resume(id, { visible: { actions: [], disabledTools: ["Bash"] } });
  const requests = await sessionRequestsOf();
  expect(requests.at(-1)?.["sessionId"]).toBe(id.native);
  expect(requests.at(-1)?.["_meta"]).toEqual({ claudeCode: { options: { disallowedTools: ["Bash"] } } });
});

test("a tool allowance is passed to Claude Code as the built-in tools switched off; a held session refuses another", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  const id = await startIdle(control, { prompt: promptFromText("one"), tools: { allow: ["Read", "Grep"] } });

  const requests = await sessionRequestsOf();
  const off = (requests[0]?.["_meta"] as { claudeCode: { options: { disallowedTools: string[] } } }).claudeCode.options.disallowedTools;
  expect(off).toContain("Bash");
  expect(off).toContain("WebFetch");
  expect(off).not.toContain("Read");
  expect(off).not.toContain("Grep");
  // The allow-list itself reaches Claude Code through niwa's adapter entry.
  expect((requests[0]?.["_meta"] as { niwa?: unknown }).niwa).toEqual({ tools: ["Read", "Grep"] });
  expect((requests[0]?.["_meta"] as { disableBuiltInTools?: unknown }).disableBuiltInTools).toBeUndefined();
  await expect(control.resume(id, { tools: { allow: ["Read"] } })).rejects.toMatchObject({ code: "Unsupported" });
});

test("a session of niwa's tools only is given none of Claude Code's tools, nor the adapter's own", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  await startIdle(control, { prompt: promptFromText("one"), tools: "niwa-only" });
  await startIdle(control, { prompt: promptFromText("two"), tools: "all" });

  const requests = await sessionRequestsOf();
  const meta = requests[0]?.["_meta"] as { niwa?: unknown; disableBuiltInTools?: unknown; claudeCode: { options: { disallowedTools: string[] } } };
  expect(meta.niwa).toEqual({ tools: [] });
  expect(meta.disableBuiltInTools).toBe(true);
  expect(meta.claudeCode.options.disallowedTools).toContain("Bash");
  expect(meta.claudeCode.options.disallowedTools).toContain("Read");
  // Claude Code's own tools, as the harness has them.
  expect(requests[1]?.["_meta"]).toBeUndefined();
});

test("a session with no tool switched off is asked for with no _meta", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  await control.start({ prompt: promptFromText("one") });
  expect((await sessionRequestsOf())[0]?.["_meta"]).toBeUndefined();
});

test("a session with no MCP servers is asked for with no servers", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  await control.start({ prompt: promptFromText("one") });

  const requests = await sessionRequestsOf();
  expect(requests[0]?.["mcpServers"]).toEqual([]);
});

test("a message into the running turn is refused where the protocol cannot deliver it", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 150 })],
  });
  const id = await startIdle(control, { prompt: promptFromText("one") });
  const idle = await control.send(id, "two", { into: "turn" });
  expect(idle.status).toBe("started");
  await expect(control.send(id, "three", { into: "turn" })).rejects.toMatchObject({
    code: "Unsupported",
  });
});

test("a message to a busy session is queued and becomes the next turn", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 150 })],
  });
  const id = await startIdle(control, { prompt: promptFromText("one") });
  expect(await control.state(id)).toBe("idle");

  // The first stream of life is also given the signs of the first turn, which ran before it.
  const life = collect(control.life(id), (events) => kinds(events).includes("turn-ended:3"));
  const second = await control.send(id, "two");
  const third = await control.send(id, "three");

  expect(second.status).toBe("started");
  expect(second.turn).toBe(2);
  // The protocol forbids two prompts at once, so the third waits behind the second.
  expect(third.status).toBe("queued");
  expect(await control.state(id)).toBe("running");
  expect(kinds(await life)).toEqual([
    "turn-started:1",
    "turn-ended:1",
    "turn-started:2",
    "turn-ended:2",
    "turn-started:3",
    "turn-ended:3",
  ]);
  expect(await control.state(id)).toBe("idle");
});

test("by default a permission request is allowed with the option the agent offered", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, toolRequest: true })],
  });
  await startIdle(control, { prompt: promptFromText("hi") });

  const replies = await repliesOf();
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({
    id: "perm-1",
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  });
});

test("deny routes permission requests to niwa and refuses them", async () => {
  control = claudeCodeControl({
    harness: "fake",
    permissions: "deny",
    command: [await fakeAgent({ turnMs: 0, toolRequest: true })],
  });
  await startIdle(control, { prompt: promptFromText("hi") });

  const replies = await repliesOf();
  expect(replies[0]).toMatchObject({
    result: { outcome: { outcome: "selected", optionId: "reject" } },
  });
});

test("a permission function sees the request, and a function that throws refuses", async () => {
  const seen: unknown[] = [];
  control = claudeCodeControl({
    harness: "fake",
    permissions: (request) => {
      seen.push(request);
      return { behavior: "allow" };
    },
    command: [await fakeAgent({ turnMs: 0, toolRequest: true })],
  });
  await startIdle(control, { prompt: promptFromText("hi") });

  expect(seen).toEqual([{ tool: "Bash", input: { command: "ls" }, toolUseId: "tu-1" }]);
  expect(await repliesOf()).toMatchObject([
    { result: { outcome: { outcome: "selected", optionId: "allow" } } },
  ]);
  await control.dispose();

  await rm(join(dir, "replies.log"));
  control = claudeCodeControl({
    harness: "fake",
    permissions: () => Promise.reject(new Error("boom")),
    command: [await fakeAgent({ turnMs: 0, toolRequest: true })],
  });
  await startIdle(control, { prompt: promptFromText("hi") });
  expect(await repliesOf()).toMatchObject([
    { result: { outcome: { outcome: "selected", optionId: "reject" } } },
  ]);
});

test("a question with a schema comes back as a value that passed the schema", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });

  // The fake agent answers "ok", which is not the asked-for shape: the schema is the gate.
  await expect(
    control.ask(id, {
      schema: z.object({ word: z.string() }),
      prompt: promptFromText("Give the word ok."),
    }),
  ).rejects.toThrow();
});

test("an interrupt ends the turn, clears the queue and leaves the session usable", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 2_000 })],
  });
  const id = await startIdle(control, { prompt: promptFromText("one") });

  await control.send(id, "two");
  const queued = await control.send(id, "three");
  expect(queued.status).toBe("queued");
  expect(await control.state(id)).toBe("running");

  // The call returns only after the agent ended the turn.
  await control.interrupt(id);
  expect(await control.state(id)).toBe("idle");
  expect((await readFile(join(dir, "cancel.log"), "utf8")).trim()).toContain("fake-session");

  // The queued message did not fire, and the session still takes a turn.
  const again = await control.send(id, "four");
  expect(again.status).toBe("started");
  await expect(control.interrupt(id)).resolves.toBeUndefined();
});

test("a child that dies mid-turn releases the turn, the watchers and the state", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, crashAt: 2 })],
  });
  const id = await startIdle(control, { prompt: promptFromText("one") });
  const life = collect(control.life(id), () => false);

  await control.send(id, "two");
  // The iterator ends when the session does; it does not hang. The first stream is also given
  // the signs of the first turn.
  const events = await life;
  expect(kinds(events)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2", "turn-ended:2"]);
  expect(await control.state(id)).toBe("unknown");
  await expect(control.send(id, "three")).rejects.toThrow();
});

test("a child that dies before the answer fails the question instead of hanging", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, crashAt: 2 })],
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  await expect(
    control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("word?") }),
  ).rejects.toThrow();
});

test("a question on a busy session waits behind the running turn, never a second prompt at once", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 300, firstMs: 300, word: true })],
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  const life = collect(control.life(id), (events) => kinds(events).includes("turn-ended:3"));
  const sent = await control.send(id, "two");
  expect(sent).toMatchObject({ status: "queued", turn: 2 });
  const answer = await control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("word?") });
  expect(answer.value.word).toBe("ok");
  // One turn after the other: the question is the third turn, after the start and the send.
  expect(kinds(await life)).toEqual([
    "turn-started:1",
    "turn-ended:1",
    "turn-started:2",
    "turn-ended:2",
    "turn-started:3",
    "turn-ended:3",
  ]);
});

test("a resume with a prompt of a held session whose turn runs waits behind that turn, never a second prompt at once", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 100, firstMs: 300, strict: true })],
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  expect(await control.state(id)).toBe("running");
  await control.resume(id, { prompt: promptFromText("two") });
  expect(await control.state(id)).toBe("idle");
});

test("the start returns before the first turn ends: a first turn that never ends does not block it", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, firstMs: "never" })],
  });
  const { session: id, first } = await control.start({ prompt: promptFromText("one") });
  expect(String(id.native)).toBe("fake-session");
  // The prompt became the first turn, delivered like a send; it is still running.
  expect(first).toMatchObject({ status: "started", turn: 1 });
  expect(await control.state(id)).toBe("running");
  // The first stream of life is given the start of that turn, which began before it existed.
  const iterator = control.life(id)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ kind: "turn-started", turn: 1 });
  void iterator.return?.();
  // The session takes messages at once: they wait behind the first turn.
  expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
});

test("a turn over its time is cancelled, and the next prompt goes out only after the agent answered the cancelled one", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, firstMs: 60_000, strict: true, cancelLagMs: 300 })],
    turnTimeoutMs: 200,
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      events.push(event);
      if (event.kind === "turn-ended" && event.turn === 2) return;
    }
  })();
  expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  await watching;
  const details = events.flatMap((event) => (event.kind === "activity" && event.detail !== undefined ? [event.detail] : []));
  // The first turn was cancelled for its time and failed; the message behind it was not sent as a
  // second prompt at once, so the agent took it and answered it.
  expect(details).toContain("the turn did not end in time: it was cancelled");
  expect(details).toContain("the turn failed: the call session/prompt timed out");
  expect(details.some((detail) => detail.includes("already active"))).toBe(false);
  expect(kinds(events).filter((kind) => kind.startsWith("turn-"))).toEqual([
    "turn-started:1",
    "turn-ended:1",
    "turn-started:2",
    "turn-ended:2",
  ]);
  expect(await control.state(id)).toBe("idle");
});

test("a turn longer than the call timeout is not failed by it: the turn has its own, long, timeout", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0, firstMs: 2_500 })],
    callTimeoutMs: 1_500,
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  const events: LifeEvent[] = [];
  for await (const event of control.life(id)) {
    events.push(event);
    if (event.kind === "turn-ended") break;
  }
  const details = events.flatMap((event) => (event.kind === "activity" && event.detail !== undefined ? [event.detail] : []));
  expect(details.filter((detail) => /timed out|did not end|failed/.test(detail))).toEqual([]);
  expect(kinds(events).filter((kind) => kind.startsWith("turn-"))).toEqual(["turn-started:1", "turn-ended:1"]);
});

test("the turn signs kept for the first watcher are bounded: a watcher that comes late sees the latest 64 and the turn end does not hang", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  const { session: id } = await control.start({ prompt: promptFromText("one") });
  // 49 more turns run with nobody watching: 100 turn signs, more than the buffer keeps.
  for (let turn = 2; turn <= 50; turn += 1) await control.send(id, `message ${String(turn)}`);
  for (let waited = 0; waited < 5_000 && (await control.state(id)) !== "idle"; waited += 25) await Bun.sleep(25);
  expect(await control.state(id)).toBe("idle");

  const iterator = control.life(id)[Symbol.asyncIterator]();
  const first: LifeEvent[] = [];
  for (;;) {
    const next = await Promise.race([iterator.next(), Bun.sleep(300).then(() => undefined)]);
    if (next === undefined || next.done === true) break;
    first.push(next.value);
  }
  void iterator.return?.();
  // The oldest signs were dropped, the latest 64 were given, and the end of the last turn is there.
  expect(first).toHaveLength(64);
  expect(kinds(first).at(-1)).toBe("turn-ended:50");
  expect(kinds(first)).not.toContain("turn-started:1");

  // Nothing is kept for the second stream.
  const second = control.life(id)[Symbol.asyncIterator]();
  expect(await Promise.race([second.next(), Bun.sleep(200).then(() => "nothing")])).toBe("nothing");
  void second.return?.();
});

test("a start without a prompt begins no turn and gives no receipt", async () => {
  control = claudeCodeControl({
    harness: "fake",
    command: [await fakeAgent({ turnMs: 0 })],
  });
  const started = await control.start({ prompt: promptFromText("") });
  expect(started.first).toBeUndefined();
  expect(await control.state(started.session)).toBe("idle");
});

/**
 * The ACP adapter that drives Claude Code.
 *
 * It is a dependency of this package, so its binary is in the package's own `node_modules`.
 * It is also accepted from PATH, for a machine that has it installed.
 */
function acpAdapter(): string | undefined {
  const local = join(import.meta.dir, "..", "..", "node_modules", ".bin", "claude-code-acp");
  if (Bun.file(local).size > 0) return local;
  return Bun.which("claude-code-acp") ?? undefined;
}

const runReal = live && acpAdapter() !== undefined;

test.skipIf(!runReal)(
  "the real ACP adapter starts, takes a message and answers by schema",
  async () => {
    const marker = `niwa-proof-${crypto.randomUUID()}`;
    control = claudeCodeControl({
      harness: "claude-proof",
      command: [acpAdapter() as string],
      model: "haiku",
      turnTimeoutMs: 120_000,
    });

    const id = await startIdle(
      control,
      {
        prompt: {
          sections: [
            { id: "marker", tier: "constant", text: `Answer in one word. ${marker}` },
            { id: "ask", tier: "volatile", text: "Say ok." },
          ],
        },
        cwd: dir,
      },
      120_000,
    );

    // The native id is the session the ACP adapter named.
    expect(id.native.length).toBeGreaterThan(0);
    expect(await control.state(id)).toBe("idle");

    const life = collect(control.life(id), (events) => kinds(events).includes("turn-ended:2"));
    const receipt = await control.send(id, "Say two.");
    expect(receipt.status).toBe("started");
    // The first stream of life is also given the signs of the first turn.
    expect(kinds(await life)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2", "turn-ended:2"]);

    await control.dispose();
    const left = Bun.spawnSync(["pgrep", "-f", marker]);
    expect(left.stdout.toString().trim()).toBe("");
  },
  240_000,
);

test.skipIf(!runReal)(
  "the real Claude Code does not have a tool niwa switched off, and has it when nothing is switched off",
  async () => {
    const hasBash = async (disabledTools: string[]): Promise<boolean> => {
      const side = claudeCodeControl({
        harness: "claude-tools",
        command: [acpAdapter() as string],
        model: "haiku",
        turnTimeoutMs: 120_000,
      });
      try {
        const id = await startIdle(
          side,
          { prompt: promptFromText("Reply only ready."), cwd: dir, visible: { actions: [], disabledTools } },
          120_000,
        );
        const answer = await side.ask(id, {
          schema: z.object({ bash: z.boolean() }),
          prompt: promptFromText(
            'Look at the list of tools you were given. Is a tool named exactly "Bash" in it? Do not call any tool.',
          ),
        });
        return answer.value.bash;
      } finally {
        await side.dispose();
      }
    };
    expect(await hasBash(["Bash"])).toBe(false);
    expect(await hasBash([])).toBe(true);
  },
  400_000,
);


test.skipIf(!runReal || Bun.which("claude") === null)(
  "the real adapter runs the local claude: its transcript carries the version of `claude --version`, the model asked for, and the effort is accepted",
  async () => {
    const local = (await new Response(Bun.spawn(["claude", "--version"], { stdout: "pipe" }).stdout).text()).trim().split(" ")[0];
    control = claudeCodeControl({ harness: "claude-local", command: [acpAdapter() as string], turnTimeoutMs: 120_000 });
    const id = await startIdle(control, { prompt: promptFromText("Reply only ok."), cwd: dir, model: "haiku", effort: "low" }, 120_000);

    const home = join(process.env.HOME ?? "", ".claude", "projects");
    const files = [...new Bun.Glob(`*/${id.native}.jsonl`).scanSync({ cwd: home })];
    expect(files).toHaveLength(1);
    const records = (await readFile(join(home, files[0] as string), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { version?: string; message?: { model?: string } });
    expect(new Set(records.flatMap((record) => (record.version === undefined ? [] : [record.version])))).toEqual(new Set([local as string]));
    expect(records.some((record) => record.message?.model?.includes("haiku") === true)).toBe(true);
  },
  240_000,
);

test("a message to a session that is not held, or whose process went, was not sent", async () => {
  control = claudeCodeControl({ harness: "fake", command: [await fakeAgent({ turnMs: 0 })] });
  const id = await startIdle(control, { prompt: promptFromText("one") });
  await expect(control.send({ ...id, native: "elsewhere" as never }, "two")).rejects.toBeInstanceOf(InputNotSent);
  await control.dispose();
  await expect(control.send(id, "two")).rejects.toBeInstanceOf(InputNotSent);
});
