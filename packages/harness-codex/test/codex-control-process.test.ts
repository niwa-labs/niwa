/**
 * The process discipline of the Codex control side, against a fake `codex app-server`: the
 * requests of the server are answered, a dead child fails every pending call, a turn that did
 * not complete is not a success, and no process of the child's group outlives the control side.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { InputNotSent, InputPossiblySent, modelName, promptFromText, type LifeEvent, Unavailable, Unsupported } from "@niwa-labs/harness";
import type { SessionId } from "@niwa-labs/harness";
import { codexControl } from "../src/control.ts";
import type { CodexControlOptions } from "../src/control.ts";
import { eventually, tempDir } from "@niwa-labs/testing";

const THREAD = "11111111-2222-3333-4444-555555555555";

/** The frames the fake sends, built as the real server builds them; the fake script imports them by path. */
const FRAMES = fileURLToPath(new URL("./fixtures/codex-frames.ts", import.meta.url));

/**
 * A fake server. FAKE_MODE: `ok`, `approval`, `die` (exits on turn/start), `fail` (turn fails),
 * `hold` (every turn waits for a release), `novel` (says something the schemas do not know, and goes
 * on), `novel-request` (asks something the schemas do not know, and goes on once it is answered),
 * `drift` (the turn ends with a status the schemas do not know), `drift-message` (the agent's final
 * message carries a field the schemas do not know).
 *
 * The requests that come in are written to `requests.log`, the notifications that go out to
 * `events.log`, so a test can see what was asked and in which order it happened.
 */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { agentMessageCompleted, commandApprovalParams, serverRequest, turnCompleted, turnStarted } from ${JSON.stringify(FRAMES)};
const THREAD = "${THREAD}";
const dir = process.env.FAKE_DIR;
const mode = process.env.FAKE_MODE;
appendFileSync(dir + "/spawns.log", JSON.stringify({ argv: process.argv.slice(2), home: process.env.CODEX_HOME ?? null }) + "\\n");
const grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
writeFileSync(dir + "/grandchild.pid", String(grandchild.pid));
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const notify = (method, params) => {
  appendFileSync(dir + "/events.log", JSON.stringify({ method, params }) + "\\n");
  send({ method, params });
};
const emit = (frame) => notify(frame.method, frame.params);
const finish = (status, id) => {
  emit(agentMessageCompleted(THREAD, id, process.env.FAKE_TEXT ?? "ok"));
  emit(turnCompleted(THREAD, id, status, status === "failed" ? "boom" : undefined));
};
// The turns that wait for a release, and the turns that were released.
let pending = [];
let released = 0;
let turns = 0;
setInterval(() => {
  if (mode !== "hold") return;
  let wanted = 0;
  try {
    wanted = Number(readFileSync(dir + "/release", "utf8"));
  } catch {
    return;
  }
  if (wanted > released && pending.length > 0) {
    released += 1;
    finish("completed", pending.shift());
  }
}, 20);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.method !== undefined) {
      appendFileSync(dir + "/requests.log", JSON.stringify({ method: frame.method, params: frame.params }) + "\\n");
    }
    if (frame.method === "initialize") send({ id: frame.id, result: {} });
    else if (frame.method === "thread/start") send({ id: frame.id, result: { thread: { id: "${THREAD}" }, model: process.env.FAKE_MODEL } });
    else if (frame.method === "thread/resume") send({ id: frame.id, result: { thread: { id: frame.params.threadId }, model: process.env.FAKE_MODEL } });
    else if (frame.method === "turn/start") {
      if (mode === "die") process.exit(1);
      if (mode === "refuse-turn") {
        send({ id: frame.id, error: { code: -32600, message: "the turn was refused" } });
        continue;
      }
      turns += 1;
      const turnId = "t" + turns;
      send({ id: frame.id, result: { turn: { id: turnId } } });
      emit(turnStarted(THREAD, turnId));
      if (process.env.FAKE_REROUTE) notify("model/rerouted", { threadId: "${THREAD}", turnId, fromModel: process.env.FAKE_MODEL, toModel: process.env.FAKE_REROUTE, reason: "highRiskCyberActivity" });
      if (mode === "approval") send(serverRequest("srv1", "item/commandExecution/requestApproval", THREAD, turnId, commandApprovalParams({ command: "ls" })));
      else if (mode === "novel-request") send({ id: "srv2", method: "novel/ask", params: { why: "because" } });
      else if (mode === "hold") pending.push(turnId);
      else if (mode === "drift-message") {
        const message = agentMessageCompleted(THREAD, turnId, process.env.FAKE_TEXT ?? "ok");
        message.params.item.moderation = { from: "the future" };
        emit(message);
        emit(turnCompleted(THREAD, turnId, "completed"));
      } else if (mode === "drift") {
        emit(agentMessageCompleted(THREAD, turnId, "ok"));
        const ended = turnCompleted(THREAD, turnId, "completed");
        ended.params.turn.status = "paused";
        emit(ended);
      } else {
        if (mode === "novel") notify("novel/thing", { n: 1 });
        finish(mode === "fail" ? "failed" : "completed", turnId);
      }
    } else if (frame.method === "turn/steer") send({ id: frame.id, result: {} });
    else if (frame.id === "srv1" || frame.id === "srv2") {
      appendFileSync(dir + "/reply.json", JSON.stringify(frame));
      finish("completed", "t1");
    }
  }
});
`;

let dir: string;

beforeEach(async () => {
  dir = await tempDir("codex-fake");
  const binary = join(dir, "codex");
  await writeFile(binary, FAKE);
  await chmod(binary, 0o755);
  process.env.FAKE_DIR = dir;
});

afterEach(async () => {
  // Every control side a test made is disposed, so no fake server outlives its test.
  for (const made of controls.splice(0)) await made.dispose().catch(() => undefined);
  delete process.env.FAKE_DIR;
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_TEXT;
  delete process.env.FAKE_MODEL;
  delete process.env.FAKE_REROUTE;
  await rm(dir, { recursive: true, force: true });
});

/** The control sides made by the test that runs; they are disposed after it. */
const controls: Array<ReturnType<typeof codexControl>> = [];

function control(extra: Partial<CodexControlOptions> = {}) {
  const made = codexControl({ harness: "codex-fake", binary: join(dir, "codex"), turnTimeoutMs: 10_000, ...extra });
  controls.push(made);
  return made;
}

async function grandchildGone(): Promise<boolean> {
  const pid = Number(await readFile(join(dir, "grandchild.pid"), "utf8"));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

/** The requests the fake server was asked for, in the order they came. */
async function requests(): Promise<{ method: string; params: Record<string, unknown> }[]> {
  return (await lines("requests.log")).map(
    (line) => JSON.parse(line) as { method: string; params: Record<string, unknown> },
  );
}

/** The processes the fake server was started as, in the order they came: their arguments and the home they were given. */
async function spawns(): Promise<{ argv: string[]; home: string | null }[]> {
  return (await lines("spawns.log")).map((line) => JSON.parse(line) as { argv: string[]; home: string | null });
}

/** The notifications the fake server sent, in the order they went out. */
async function events(): Promise<{ method: string; params: Record<string, unknown> }[]> {
  return (await lines("events.log")).map(
    (line) => JSON.parse(line) as { method: string; params: Record<string, unknown> },
  );
}

/** The lines of a log of the fake server; a log that is not there yet has none. */
async function lines(name: string): Promise<string[]> {
  const text = await readFile(join(dir, name), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** The text of every turn that was started, in the order the turns came. */
async function startedTurns(): Promise<string[]> {
  const asked = await requests();
  return asked
    .filter((frame) => frame.method === "turn/start")
    .map((frame) => {
      const input = frame.params.input as { type: string; text: string }[];
      return input.map((item) => item.text).join("");
    });
}

/** Let the turn that waits be released, so the server completes it. */
async function release(count: number): Promise<void> {
  await writeFile(join(dir, "release"), String(count));
}

/** Wait until the condition holds, so a test does not depend on a fixed delay. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`the condition did not come: ${what}`);
}

test("a request of the server is answered, and the group dies with dispose", async () => {
  process.env.FAKE_MODE = "approval";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("go") });
  expect(String(id.native)).toBe(THREAD);
  // The request comes in the first turn, which runs on after the start.
  await until(async () => (await codex.state(id)) === "idle", "the first turn ended");
  expect(JSON.parse(await readFile(join(dir, "reply.json"), "utf8")).result.decision).toBe("decline");
  expect(await codex.state(id)).toBe("idle");

  await codex.dispose();
  expect(await codex.state(id)).toBe("unknown");
  expect(await grandchildGone()).toBe(true);
});

/** The signs of life the first stream of life sees, up to the first turn that ends. */
async function signsOfFirstTurn(side: { life(id: SessionId): AsyncIterable<LifeEvent> }, id: SessionId): Promise<LifeEvent[]> {
  const signs: LifeEvent[] = [];
  for await (const event of side.life(id)) {
    signs.push(event);
    if (event.kind === "turn-ended") break;
  }
  return signs;
}

test("a notification that is not in the snapshot is a typed sign of life that carries the message, and the turn goes on", async () => {
  process.env.FAKE_MODE = "novel";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("go") });
  const signs = await signsOfFirstTurn(codex, id);
  const unknown = signs.filter((sign) => sign.kind === "unknown-variant");
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toMatchObject({
    kind: "unknown-variant",
    protocol: "codex app-server",
    variant: "novel/thing",
    raw: { method: "novel/thing", params: { n: 1 } },
  });
  expect(signs.map((sign) => sign.kind).filter((kind) => kind !== "activity")).toEqual(["turn-started", "unknown-variant", "turn-ended"]);
  expect(await codex.state(id)).toBe("idle");
});

test("a request that is not in the snapshot is answered with an error, so the turn does not wait for it", async () => {
  process.env.FAKE_MODE = "novel-request";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("go") });
  const signs = await signsOfFirstTurn(codex, id);
  expect(signs.find((sign) => sign.kind === "unknown-variant")).toMatchObject({ variant: "novel/ask", raw: { id: "srv2", method: "novel/ask" } });
  const reply = JSON.parse(await readFile(join(dir, "reply.json"), "utf8"));
  expect(reply).toMatchObject({ id: "srv2", error: { code: -32601 } });
});

test("a turn that ends with a status that is not in the snapshot is not a success, and does not wait for its timeout", async () => {
  process.env.FAKE_MODE = "drift";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const failure = await codex.ask(id, { schema: z.string(), prompt: promptFromText("question") }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Unavailable);
  expect(String(failure)).toContain("the turn paused");
  expect(await codex.state(id)).toBe("idle");
});

test("the answer of a turn is still read when its message carries a field the snapshot does not know", async () => {
  process.env.FAKE_MODE = "drift-message";
  process.env.FAKE_TEXT = '{"v":7}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const signs: LifeEvent[] = [];
  void (async () => {
    for await (const event of codex.life(id)) signs.push(event);
  })();
  const answer = await codex.ask(id, { schema: z.object({ v: z.number() }), prompt: promptFromText("question") });
  expect(answer.value).toEqual({ v: 7 });
  await eventually(() => signs.some((sign) => sign.kind === "unknown-variant"), 10_000, "the unknown-variant sign");
  expect(signs.find((sign) => sign.kind === "unknown-variant")).toMatchObject({ variant: "item/completed" });
});

test("a child that dies with the first prompt unanswered fails it as possibly sent and leaves no orphan", async () => {
  process.env.FAKE_MODE = "die";
  const codex = control();
  const failure = await codex.start({ prompt: promptFromText("go") }).catch((error: unknown) => error);
  // turn/start was written and never answered: Codex may have begun the turn.
  expect(failure).toBeInstanceOf(InputPossiblySent);
  expect(String(failure)).toContain("exited");
  expect(await grandchildGone()).toBe(true);
  await codex.dispose();
});

test("a message Codex refuses, or one to a session it does not hold, was not sent", async () => {
  process.env.FAKE_MODE = "refuse-turn";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  await expect(codex.send(id, "go")).rejects.toBeInstanceOf(InputNotSent);
  await expect(codex.send({ ...id, native: "elsewhere" as never }, "go")).rejects.toBeInstanceOf(InputNotSent);
  await codex.dispose();
});

test("a first turn that fails is a failed turn of a session that was started, not a failed start", async () => {
  process.env.FAKE_MODE = "fail";
  const codex = control();
  const { session: id, first } = await codex.start({ prompt: promptFromText("go") });
  expect(String(id.native)).toBe(THREAD);
  expect(first).toMatchObject({ status: "started", turn: 1 });
  // The turn's end is a sign of life; the session stays, and takes the next message.
  const signs = await turnSigns(codex, id);
  expect(signs).toEqual(["turn-started:1", "turn-ended:1"]);
  expect(await codex.state(id)).toBe("idle");
  await codex.dispose();
});

test("the start returns before the first turn ends: a first turn that never ends does not block it", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  const { session: id, first } = await codex.start({ prompt: promptFromText("go") });
  expect(String(id.native)).toBe(THREAD);
  expect(first).toMatchObject({ status: "started", turn: 1 });
  expect(await codex.state(id)).toBe("running");
  // The session takes messages at once: they wait behind the first turn.
  expect(await codex.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  await codex.dispose();
});

test("a message to a busy session is queued, and the turns run in the order the messages came", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  // An empty prompt: the session is named without a turn of its own.
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  expect(await codex.state(id)).toBe("idle");

  // The first message starts a turn, and that turn waits for a release.
  const begun = await codex.send(id, "one");
  expect(begun.status).toBe("started");
  await until(async () => (await codex.state(id)) === "running", "the turn started");
  expect(await codex.state(id)).toBe("running");

  const second = await codex.send(id, "two");
  expect(second.status).toBe("queued");
  // The queued message waits for the turn after the running one.
  expect(second.turn).toBe(2);
  const third = await codex.send(id, "three");
  expect(third.status).toBe("queued");
  expect(third.turn).toBe(3);

  // Nothing was steered, and no turn was started for the queued messages.
  expect((await requests()).filter((frame) => frame.method === "turn/steer")).toEqual([]);
  expect(await startedTurns()).toEqual(["one"]);

  // The running turn ends: the first queued message becomes a turn of its own.
  await release(1);
  await until(async () => (await startedTurns()).length === 2, "the first queued turn started");
  expect(await startedTurns()).toEqual(["one", "two"]);

  // That turn ends: the second queued message follows it.
  await release(2);
  await until(async () => (await startedTurns()).length === 3, "the second queued turn started");
  expect(await startedTurns()).toEqual(["one", "two", "three"]);

  await release(3);
  await until(async () => (await codex.state(id)) === "idle", "the session became idle");
  expect(await codex.state(id)).toBe("idle");

  // The turns were reported one after the other, never two at once.
  expect((await events()).filter((event) => event.method === "turn/started")).toHaveLength(3);

  await codex.dispose();
});

test("the turn that runs inside start is reported to the first watcher", async () => {
  process.env.FAKE_MODE = "ok";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("go") });
  // The turn is over before anyone watches: both signs can only come from what the side kept.
  await until(async () => (await codex.state(id)) === "idle", "the first turn ended");
  expect(await turnSigns(codex, id)).toEqual(["turn-started:1", "turn-ended:1"]);
  await codex.dispose();
});

/** The turn signs the first stream of life sees, up to the first turn that ends. */
async function turnSigns(side: { life(id: SessionId): AsyncIterable<LifeEvent> }, id: SessionId): Promise<string[]> {
  const signs: string[] = [];
  for await (const event of side.life(id)) {
    if (event.kind !== "turn-started" && event.kind !== "turn-ended") continue;
    signs.push(`${event.kind}:${event.turn}`);
    if (event.kind === "turn-ended") break;
  }
  return signs;
}

test("an ask into a busy session waits for its turn, behind what is queued", async () => {
  process.env.FAKE_MODE = "hold";
  process.env.FAKE_TEXT = '{"v":1}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  await codex.send(id, "one");
  await until(async () => (await codex.state(id)) === "running", "the turn started");

  await codex.send(id, "two");
  const asked = codex.ask(id, { schema: z.object({ v: z.number() }), prompt: promptFromText("question") });
  expect(await startedTurns()).toEqual(["one"]);

  await release(1);
  await until(async () => (await startedTurns()).length === 2, "the queued message became a turn");
  await release(2);
  await until(async () => (await startedTurns()).length === 3, "the ask became a turn");
  expect(await startedTurns()).toEqual(["one", "two", "question"]);
  await release(3);
  expect((await asked).value).toEqual({ v: 1 });

  await codex.dispose();
});

test("a caller that asks for it gets its message into the running turn", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const begun = await codex.send(id, "one");
  expect(begun.status).toBe("started");
  await until(async () => (await codex.state(id)) === "running", "the turn started");

  const receipt = await codex.send(id, "into the turn", { into: "turn" });
  expect(receipt.status).toBe("delivered");
  expect(receipt.turn).toBe(1);

  const steered = (await requests()).filter((frame) => frame.method === "turn/steer");
  expect(steered).toHaveLength(1);
  expect((steered[0]?.params.input as { text: string }[])[0]?.text).toBe("into the turn");
  // The message was steered, not queued: no turn was started for it.
  expect(await startedTurns()).toEqual(["one"]);

  await codex.dispose();
});

/** The config of a thread request, as the fake server received it. */
async function threadConfig(method: string): Promise<Record<string, unknown> | undefined> {
  const asked = (await requests()).filter((frame) => frame.method === method);
  const last = asked[asked.length - 1];
  const config = last?.params.config;
  return config === undefined ? undefined : (config as Record<string, unknown>);
}

test("a message to an idle session starts a turn", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  expect(await codex.state(id)).toBe("idle");

  const receipt = await codex.send(id, "one");
  expect(receipt.status).toBe("started");
  expect(receipt.turn).toBe(1);
  await until(async () => (await startedTurns()).length === 1, "the turn started");
  expect(await startedTurns()).toEqual(["one"]);

  await codex.dispose();
});

test("a session is given its server and its switched-off tools in the config of the thread", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control({ mode: "full" });
  await codex.start({
    prompt: promptFromText(""),
    servers: [
      {
        name: "niwa",
        command: "/usr/bin/niwa",
        args: ["/tmp/home", "--stdio"],
        env: { NIWA_VISIBLE: "task.create" },
      },
    ],
    visible: { actions: ["task.create"], disabledTools: ["shell", "web_search"] },
  });

  // Codex takes a flat map of dotted keys, each with a JSON value.
  expect(await threadConfig("thread/start")).toEqual({
    "mcp_servers.niwa.command": "/usr/bin/niwa",
    "mcp_servers.niwa.args": ["/tmp/home", "--stdio"],
    "mcp_servers.niwa.env": { NIWA_VISIBLE: "task.create" },
    "features.shell_tool": false,
    web_search: "disabled",
  });

  await codex.dispose();
});

test("a resumed session is given its server and its switched-off tools too", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control({ mode: "full" });
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  await codex.stop(id);

  await codex.resume(id, {
    servers: [{ name: "niwa", command: "niwa", args: [], env: {} }],
    visible: { actions: [], disabledTools: ["web_search"] },
  });

  expect(await threadConfig("thread/resume")).toEqual({
    "mcp_servers.niwa.command": "niwa",
    "mcp_servers.niwa.args": [],
    web_search: "disabled",
  });

  await codex.dispose();
});

test("a working mode is the approval policy and the sandbox of the thread: ask reads, auto writes its workspace with the network open, full has the machine", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  const modes = [
    ["ask", { approvalPolicy: "on-request", sandbox: "read-only" }],
    ["auto", { approvalPolicy: "on-request", sandbox: "workspace-write" }],
    ["full", { approvalPolicy: "never", sandbox: "danger-full-access" }],
  ] as const;
  for (const [mode, params] of modes) {
    const started = await codex.start({ prompt: promptFromText(""), mode });
    expect(started.mode).toBe(mode);
    const asked = (await requests()).filter((frame) => frame.method === "thread/start").at(-1);
    expect(asked?.params).toMatchObject(params);
    // Only auto opens the network, in the config that Codex's sandbox reads.
    expect(asked?.params.config).toEqual(mode === "auto" ? { "sandbox_workspace_write.network_access": true } : undefined);
  }
  // None chosen: the default of every harness is auto.
  const unchosen = await codex.start({ prompt: promptFromText("") });
  expect(unchosen.mode).toBe("auto");
  expect((await requests()).filter((frame) => frame.method === "thread/start").at(-1)?.params).toMatchObject({ sandbox: "workspace-write" });

  await codex.dispose();
});

test("the control option is the mode of a start that names none, and a call's mode wins; a resumed session keeps the mode it was started in", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control({ mode: "ask" });
  const { session: id, mode } = await codex.start({ prompt: promptFromText("") });
  expect(mode).toBe("ask");
  expect((await requests()).filter((frame) => frame.method === "thread/start").at(-1)?.params).toMatchObject({ sandbox: "read-only" });
  await codex.stop(id);

  await codex.resume(id, { mode: "full" });
  expect((await requests()).filter((frame) => frame.method === "thread/resume").at(-1)?.params).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });

  await codex.dispose();
});

test("a tool Codex cannot switch off is refused by name", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();

  const failure = await codex
    .start({
      prompt: promptFromText(""),
      visible: { actions: [], disabledTools: ["apply_patch"] },
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Unsupported);
  expect(String(failure)).toContain("apply_patch");
  // Nothing was started: the refusal came before the thread was asked for.
  expect((await requests()).filter((frame) => frame.method === "thread/start")).toEqual([]);

  await codex.dispose();
});

test("an allow-list switches off both implementations of the agents Codex spawns", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  await codex.start({ prompt: promptFromText(""), tools: { allow: ["apply_patch"] } });

  const [spawned] = await spawns();
  expect(spawned?.argv).toContain("features.multi_agent=false");
  expect(spawned?.argv).toContain("features.multi_agent_v2=false");
  await codex.dispose();
});

test("a thread with nothing to set is given no config at all", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control({ mode: "full" });
  await codex.start({ prompt: promptFromText("") });

  const asked = (await requests()).filter((frame) => frame.method === "thread/start");
  expect(asked).toHaveLength(1);
  expect(asked[0]?.params.config).toBeUndefined();

  await codex.dispose();
});

test("a running session cannot take another server or tool set", async () => {
  process.env.FAKE_MODE = "hold";
  const codex = control();
  const { session: id } = await codex.start({
    prompt: promptFromText(""),
    servers: [{ name: "niwa", command: "niwa", args: [], env: {} }],
  });

  const failure = await codex
    .resume(id, { servers: [{ name: "other", command: "other-mcp", args: [], env: {} }] })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Unsupported);
  // The thread was not asked for again: the refusal came first.
  expect((await requests()).filter((frame) => frame.method === "thread/resume")).toEqual([]);

  await codex.dispose();
});

test("the schema of an ask given as JSON reaches Codex with its objects closed, as OpenAI's structured output takes it", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"answer":42,"inner":{"n":1}}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  // A schema given as JSON (as `session.ask` takes it) is a loose object: `additionalProperties: {}`.
  const schema = z.fromJSONSchema({
    type: "object",
    properties: {
      answer: { type: "integer" },
      inner: { type: "object", properties: { n: { type: "integer" } } },
      additionalProperties: { type: "object", properties: {} },
    },
    required: ["answer"],
  });
  const answer = await codex.ask(id, { schema, prompt: promptFromText("question") });
  expect((answer.value as { answer: number }).answer).toBe(42);

  const turn = (await requests()).filter((frame) => frame.method === "turn/start").at(-1);
  const sent = turn?.params["outputSchema"] as Record<string, unknown>;
  expect(sent["additionalProperties"]).toBe(false);
  const properties = sent["properties"] as Record<string, Record<string, unknown>>;
  // An optional property is required and may be null, as OpenAI's strict mode wants.
  expect(sent["required"]).toEqual(["answer", "inner", "additionalProperties"]);
  const inner = (properties["inner"]?.["anyOf"] as Array<Record<string, unknown>>)[0];
  expect(inner?.["additionalProperties"]).toBe(false);
  expect(properties["inner"]?.["anyOf"]).toContainEqual({ type: "null" });
  // A property that is called "additionalProperties" is a property, not the keyword.
  expect(plain(properties["additionalProperties"])?.["type"]).toBe("object");
  expect(JSON.stringify(sent)).not.toContain('"additionalProperties":{}');
});

test("closing the objects of an ask schema reaches every schema, including a property called properties", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"a":1}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const schema = z.fromJSONSchema({
    type: "object",
    properties: {
      // A property called "properties" holds a schema, and its own objects are closed.
      properties: { type: "object", properties: { n: { type: "integer" } } },
      list: { type: "array", items: { type: "object", properties: { n: { type: "integer" } } } },
      either: { anyOf: [{ type: "object", properties: { n: { type: "integer" } } }, { type: "null" }] },
    },
  });
  await codex.ask(id, { schema, prompt: promptFromText("question") });
  const turn = (await requests()).filter((frame) => frame.method === "turn/start").at(-1);
  const sent = turn?.params["outputSchema"] as Record<string, any>;
  expect(sent["additionalProperties"]).toBe(false);
  expect(plain(sent["properties"]["properties"])["additionalProperties"]).toBe(false);
  expect(plain(sent["properties"]["list"])["items"]["additionalProperties"]).toBe(false);
  expect(plain(sent["properties"]["either"])["anyOf"][0]["additionalProperties"]).toBe(false);
});

/** The schema of an optional property as the caller wrote it: strict mode wraps it as `anyOf [it, null]`. */
function plain(schema: any): any {
  return Array.isArray(schema?.anyOf) && schema.anyOf.length === 2 && schema.anyOf[1]?.type === "null"
    ? schema.anyOf[0]
    : schema;
}

test("an optional property is sent as required and nullable, and a null for it is not part of the answer", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"answer":42,"note":null}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const schema = z.object({ answer: z.number().int(), note: z.string().optional() });
  const answer = await codex.ask(id, { schema, prompt: promptFromText("question") });
  expect(answer.value).toEqual({ answer: 42 });
  const turn = (await requests()).filter((frame) => frame.method === "turn/start").at(-1);
  const sent = turn?.params["outputSchema"] as Record<string, any>;
  expect(sent["required"]).toEqual(["answer", "note"]);
  expect(sent["properties"]["note"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
});

test("nulls for optional properties are taken out under nullable objects, unions, arrays and refs; a nullable optional null stays", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = JSON.stringify({
    c: { n: null },
    d: [{ x: null }],
    e: { k: "a", p: null },
    r: { properties: null, required: null },
    h: null,
  });
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const schema = z.object({
    c: z.object({ n: z.string().optional() }).nullable(),
    d: z.array(z.object({ x: z.number().optional() })),
    e: z.union([z.object({ k: z.literal("a"), p: z.string().optional() }), z.object({ k: z.literal("b") })]),
    r: z.object({ properties: z.string().optional(), required: z.string().optional() }),
    h: z.string().nullable().optional(),
  });
  const answer = await codex.ask(id, { schema, prompt: promptFromText("question") });
  expect(answer.value).toEqual({ c: {}, d: [{}], e: { k: "a" }, r: {}, h: null });
});

test("a root that is not an object is asked wrapped as { value } and the answer unwrapped", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"value":[1,2,3]}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, { schema: z.array(z.number()), prompt: promptFromText("question") });
  expect(answer.value).toEqual([1, 2, 3]);
  const sent = (await requests()).filter((frame) => frame.method === "turn/start").at(-1)?.params["outputSchema"] as any;
  expect(sent).toMatchObject({ type: "object", required: ["value"], additionalProperties: false });
  expect(sent.properties.value.type).toBe("array");
});

test("formats strict mode does not know and propertyNames are not sent; the caller's schema still checks", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"site":"https://example.com","mail":"a@b.co"}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, { schema: z.object({ site: z.url(), mail: z.email() }), prompt: promptFromText("q") });
  expect(answer.value).toEqual({ site: "https://example.com", mail: "a@b.co" });
  const sent = (await requests()).filter((frame) => frame.method === "turn/start").at(-1)?.params["outputSchema"] as any;
  expect(sent.properties.site.format).toBeUndefined();
  expect(sent.properties.mail.format).toBe("email");
});

test("a schema strict mode cannot say (a free map) is asked in the text, and the JSON in the answer is read", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = 'Here it is:\n```json\n{"scores":{"a":1}}\n```';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, {
    schema: z.object({ scores: z.record(z.string(), z.number()) }),
    prompt: promptFromText("give scores"),
  });
  expect(answer.value).toEqual({ scores: { a: 1 } });
  const turn = (await requests()).filter((frame) => frame.method === "turn/start").at(-1);
  expect(turn?.params["outputSchema"]).toBeUndefined();
  const text = (turn?.params["input"] as Array<{ text: string }>).map((item) => item.text).join("");
  expect(text).toContain("Answer with JSON only");
  expect(text).toContain('"scores"');
});

async function lastTurn(): Promise<{ outputSchema: any; text: string }> {
  const turn = (await requests()).filter((frame) => frame.method === "turn/start").at(-1);
  const text = (turn?.params["input"] as Array<{ text: string }>).map((item) => item.text).join("");
  return { outputSchema: turn?.params["outputSchema"], text };
}

test("an object root that has a `value` key is not unwrapped", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"value":{"x":1}}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const schema = z.object({ value: z.object({ x: z.number() }) });
  const answer = await codex.ask(id, { schema, prompt: promptFromText("q") });
  expect(answer.value).toEqual({ value: { x: 1 } });
  expect((await lastTurn()).outputSchema.properties.value.properties.x.type).toBe("number");
});

test("a non-object root strict mode cannot say is asked in the text and read as a bare value", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = 'Sure, {not json} first. [["x",1]]';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, {
    schema: z.array(z.tuple([z.string(), z.number()])),
    prompt: promptFromText("q"),
  });
  expect(answer.value).toEqual([["x", 1]]);
  const turn = await lastTurn();
  expect(turn.outputSchema).toBeUndefined();
  expect(turn.text).toContain("Answer with JSON only");
});

test("braces in the words around a text answer do not hide the JSON", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = 'Use {name} as the key. Result: {"scores":{"a":1}} (see [1])';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, {
    schema: z.object({ scores: z.record(z.string(), z.number()) }),
    prompt: promptFromText("q"),
  });
  expect(answer.value).toEqual({ scores: { a: 1 } });
});

test("a record of anything is asked in the text, not sent as an object that holds nothing", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"meta":{"a":1,"b":"x"}}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const answer = await codex.ask(id, {
    schema: z.object({ meta: z.record(z.string(), z.any()) }),
    prompt: promptFromText("q"),
  });
  expect(answer.value).toEqual({ meta: { a: 1, b: "x" } });
  expect((await lastTurn()).outputSchema).toBeUndefined();
});

test("a non-object root with a ref to a place inside it is asked in the text", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '[{"kids":[]}]';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const node: z.ZodType = z.lazy(() => z.array(z.object({ kids: node })));
  expect((await codex.ask(id, { schema: node, prompt: promptFromText("q") })).value).toEqual([{ kids: [] }]);
  expect((await lastTurn()).outputSchema).toBeUndefined();
});

test("a non-object root with refs into $defs is wrapped, and the $defs stay at the wrapper's root", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"value":[{"x":{"a":"1"},"y":{"a":"2"}}]}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const shared = z.object({ a: z.string() }).meta({ id: "S" });
  const schema = z.array(z.object({ x: shared, y: shared }));
  expect((await codex.ask(id, { schema, prompt: promptFromText("q") })).value).toEqual([
    { x: { a: "1" }, y: { a: "2" } },
  ]);
  const sent = (await lastTurn()).outputSchema;
  expect(sent.$defs.S.type).toBe("object");
  expect(sent.properties.value.items.properties.x.$ref).toBe("#/$defs/S");
});

test("a discriminated union is sent as anyOf", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_TEXT = '{"value":{"k":"b","n":2}}';
  const codex = control();
  const { session: id } = await codex.start({ prompt: promptFromText("") });
  const schema = z.discriminatedUnion("k", [
    z.object({ k: z.literal("a") }),
    z.object({ k: z.literal("b"), n: z.number() }),
  ]);
  expect((await codex.ask(id, { schema, prompt: promptFromText("q") })).value).toEqual({ k: "b", n: 2 });
  const sent = (await lastTurn()).outputSchema;
  expect(sent.properties.value.anyOf).toHaveLength(2);
  expect(sent.properties.value.oneOf).toBeUndefined();
});

test("a model goes to the thread, and an effort goes with every turn of the session, the first and the later ones", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_MODEL = "gpt-6-real";
  const codex = control();
  const { session } = await codex.start({ prompt: promptFromText("one"), model: "gpt-6-luna", effort: "xhigh" });
  await until(async () => (await codex.state(session)) === "idle", "the first turn ends");
  await codex.send(session, "two");
  await until(async () => (await startedTurns()).length === 2, "the second turn starts");

  const asked = await requests();
  const thread = asked.find((frame) => frame.method === "thread/start");
  expect(thread?.params.model).toBe("gpt-6-luna");
  expect(thread?.params.effort).toBeUndefined();
  expect(asked.filter((frame) => frame.method === "turn/start").map((frame) => frame.params.effort)).toEqual(["xhigh", "xhigh"]);
  // The model the thread says it runs is a sign of life, kept for the first watcher, not the one that was asked for.
  expect(await firstModel(codex, session)).toBe("gpt-6-real");
});

test("a turn Codex moves to another model names that model as the one the session runs", async () => {
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_MODEL = "gpt-6-real";
  process.env.FAKE_REROUTE = "gpt-6-safe";
  const codex = control();
  const { session } = await codex.start({ prompt: promptFromText("one") });
  await until(async () => (await codex.state(session)) === "idle", "the first turn ends");
  const named: string[] = [];
  for await (const event of codex.life(session)) {
    if (event.kind === "model") named.push(event.model);
    if (event.kind === "turn-ended") break;
  }
  expect(named).toEqual(["gpt-6-real", "gpt-6-safe"]);
});

test("a resume pins the model the thread was named, and says again the one Codex answers", async () => {
  process.env.FAKE_MODE = "ok";
  const codex = control();
  const { session } = await codex.start({ prompt: promptFromText("") });
  await codex.dispose();
  process.env.FAKE_MODEL = "gpt-6-real";
  const again = control();
  await again.resume(session, { model: modelName("gpt-6-real") });
  expect((await requests()).filter((frame) => frame.method === "thread/resume").at(-1)?.params.model).toBe("gpt-6-real");
  expect(await firstModel(again, session)).toBe("gpt-6-real");
});

/** The first model the first stream of life names. */
async function firstModel(side: { life(id: SessionId): AsyncIterable<LifeEvent> }, id: SessionId): Promise<string | undefined> {
  for await (const event of side.life(id)) {
    if (event.kind === "model") return event.model;
  }
  return undefined;
}

test("the effort of the instance is the default of a session that names none, and a session that names none and has no default sends none", async () => {
  process.env.FAKE_MODE = "ok";
  const withDefault = codexControl({ harness: "codex-fake", binary: join(dir, "codex"), effort: "low", turnTimeoutMs: 10_000 });
  controls.push(withDefault);
  await withDefault.start({ prompt: promptFromText("one") });
  await until(async () => (await startedTurns()).length === 1, "the turn starts");
  expect((await requests()).find((frame) => frame.method === "turn/start")?.params.effort).toBe("low");

  const plain = control();
  await plain.start({ prompt: promptFromText("two") });
  await until(async () => (await startedTurns()).length === 2, "the second turn starts");
  expect((await requests()).filter((frame) => frame.method === "turn/start")[1]?.params).not.toHaveProperty("effort");
});

test("an effort Codex does not take is refused before the process is started", async () => {
  process.env.FAKE_MODE = "ok";
  const codex = control();
  const failure = await codex.start({ prompt: promptFromText("one"), effort: "max" }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Unsupported);
  expect(String(failure)).toContain("effort \"max\" is not one of low, medium, high, xhigh");
  expect(await requests()).toEqual([]);
});
