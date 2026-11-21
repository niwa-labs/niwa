/**
 * The ZCode control side against a stand-in for
 * `zcode app-server --stdio`: it speaks the wire as the real server does (NDJSON without the
 * `jsonrpc` field, requests of its own to the client, `session/event` notifications among other
 * noise) and writes what it was given into files, so a test can read what the control side asked.
 *
 * The signs of life are a forward-only stream, so a test subscribes before the action that starts
 * a turn. Every test disposes its control side, so no child outlives it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  controlConformance,
  harnessId,
  harnessKind,
  machineId,
  modelName,
  promptFromText,
  sessionId,
} from "@niwa-labs/harness";
import type { Harness, LifeEvent, SessionId } from "@niwa-labs/harness";
import { homePath, onBoxManifest, onSpawn, useSandbox } from "@niwa-labs/sandbox";
import type { BoxRecord, LaunchedBox, Sandbox } from "@niwa-labs/sandbox";
import { ZCODE_FAKE as FAKE, tempDir } from "@niwa-labs/testing";

import { ZCODE_LAUNCH, zcodeControl } from "../src/control.ts";
import { ANSWER_SCHEMAS } from "../src/protocol/generated/zcode-protocol.ts";
import type { ZcodeControlOptions, ZcodeSessionControl } from "../src/control.ts";
import { assistant, createDatabase, user, writeSession } from "../src/fixtures.ts";
import { dbPathOf } from "../src/paths.ts";

let dir = "";
let bin = "";
const controls: ZcodeSessionControl[] = [];
const spawned: string[][] = [];
let unsubscribe = (): void => {};

beforeEach(async () => {
  dir = await tempDir("zcode-control");
  bin = join(dir, "zcode");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  unsubscribe = onSpawn((event) => spawned.push([...event.argv]));
});

afterEach(async () => {
  unsubscribe();
  spawned.length = 0;
  for (const control of controls.splice(0)) await control.dispose();
  await rm(dir, { recursive: true, force: true });
});

function control(extra: Partial<ZcodeControlOptions> = {}): ZcodeSessionControl {
  const made = zcodeControl({ harness: "zcode-fake", binary: bin, stopGraceMs: 300, ...extra });
  controls.push(made);
  return made;
}

const logOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, name), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The params of every request the fake got under a method. */
const requestsOf = async (method: string): Promise<Array<Record<string, unknown>>> =>
  (await logOf("requests.log")).filter((frame) => frame["method"] === method).map((frame) => frame["params"] as Record<string, unknown>);

/** Watches the signs of life until `count` turns have ended. */
function turnsEnded(c: ZcodeSessionControl, id: SessionId, count = 1): Promise<LifeEvent[]> {
  const seen: LifeEvent[] = [];
  const stream = c.life(id)[Symbol.asyncIterator]();
  return (async () => {
    let ended = 0;
    while (ended < count) {
      const next = await stream.next();
      if (next.done === true) throw new Error("the session ended before the turn did");
      seen.push(next.value);
      if (next.value.kind === "turn-ended") ended += 1;
    }
    void stream.return?.();
    return seen;
  })();
}

const hello = promptFromText("hello");

test("a start spawns one process, pings it, names the session and begins its first turn", async () => {
  const c = control();
  const started = await c.start({ prompt: hello, cwd: dir, env: { NIWA_ID: "k3f9" } });
  expect(String(started.session.native)).toBe("sess_fake-1");
  expect(started.first).toMatchObject({ status: "started", turn: 1 });

  expect(spawned).toEqual([[bin, "app-server", "--stdio", "--cwd", dir]]);
  expect((await logOf("env.log"))[0]).toMatchObject({ id: "k3f9" });
  const methods = (await logOf("requests.log")).map((frame) => frame["method"]);
  expect(methods.slice(0, 4)).toEqual(["runtime/capabilities", "session/create", "session/subscribe", "session/send"]);
  // The model does not go to the create; no mode was chosen, so the session is an `auto` one: ZCode's `edit`.
  expect(started.mode).toBe("auto");
  expect((await requestsOf("session/create"))[0]).toEqual({ workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit" });
  expect((await requestsOf("session/subscribe"))[0]).toMatchObject({ deliveryKind: "desktop-continuous", includeSnapshot: false });
  // Nothing was chosen, so the send names no model.
  expect((await requestsOf("session/send"))[0]).toEqual({ sessionId: "sess_fake-1", content: "hello" });

  // The first turn began inside the start: its signs are kept for the first stream.
  // No model was asked for, so the model the session runs is the one the server names, and it is the first sign.
  const signs = await turnsEnded(c, started.session);
  expect(signs.map((event) => event.kind).filter((kind) => kind !== "activity" && kind !== "unknown-variant")).toEqual(["model", "turn-started", "turn-ended"]);
  expect(signs[0]).toEqual({ kind: "model", model: modelName("fake/default-model") });
  expect(await c.state(started.session)).toBe("idle");
});

test("every request of the server is answered, whenever it comes, and unknown ones with an empty answer", async () => {
  const c = control();
  const { session } = await c.start({ prompt: hello, cwd: dir });
  await turnsEnded(c, session);
  const answers = await logOf("answers.log");
  const answerTo = (id: string) => answers.find((frame) => frame["id"] === id)?.["result"];
  // Preferences are asked when the session materializes and again with the send.
  expect(answerTo("server-1")).toMatchObject({ memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true });
  expect(answerTo("server-2")).toMatchObject({ memoryEnabled: false });
  // The official MCP identity headers are asked for; niwa holds none and says so in the words of that answer.
  expect(answerTo("server-3")).toEqual({ ok: false, reason: "official_auth_unavailable" });
  // A request the snapshot does not know is answered with an empty answer, as the real server's `session/readReplyLanguage` takes it.
  expect(answerTo("server-4")).toEqual({});
});

test("every answer to a request of the server fits the schema of its method", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("needs permission"), cwd: dir });
  await turnsEnded(c, session);
  const asked = new Map((await logOf("asked.log")).map((frame) => [frame["id"], frame["method"]]));
  const answers = (await logOf("answers.log")).filter((frame) => asked.has(frame["id"]));
  expect(answers.length).toBeGreaterThanOrEqual(4);
  for (const frame of answers) {
    const method = String(asked.get(frame["id"]));
    if (!Object.hasOwn(ANSWER_SCHEMAS, method)) continue;
    const schema = ANSWER_SCHEMAS[method as keyof typeof ANSWER_SCHEMAS];
    expect(schema.safeParse(frame["result"]).success, `${method}: ${JSON.stringify(frame["result"])}`).toBe(true);
  }
});

test("a permission follows the policy: allowed by default and denied when denied; the mode is the working mode either way", async () => {
  const allowing = control();
  const first = await allowing.start({ prompt: promptFromText("needs permission"), cwd: dir });
  await turnsEnded(allowing, first.session);
  expect((await logOf("answers.log")).some((frame) => (frame["result"] as { decision?: string })?.decision === "allow")).toBe(true);

  await rm(join(dir, "answers.log"));
  await rm(join(dir, "requests.log"));
  const denying = control({ permissions: "deny" });
  const second = await denying.start({ prompt: promptFromText("needs permission"), cwd: dir });
  await turnsEnded(denying, second.session);
  expect((await logOf("answers.log")).some((frame) => (frame["result"] as { decision?: string })?.decision === "deny")).toBe(true);
  // The mode is always named: left out, the config of the user or the project would choose it.
  expect((await requestsOf("session/create"))[0]).toEqual({ workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit" });
});

test("a working mode is the mode of the created session: ask is guarded, auto is edit, full is yolo; the control option is the default", async () => {
  const modes = [
    ["ask", "guarded"],
    ["auto", "edit"],
    ["full", "yolo"],
  ] as const;
  for (const [mode, native] of modes) {
    await rm(join(dir, "requests.log"), { force: true });
    const started = await control().start({ prompt: promptFromText(""), cwd: dir, mode });
    expect(started.mode).toBe(mode);
    expect((await requestsOf("session/create"))[0]?.["mode"]).toBe(native);
  }
  await rm(join(dir, "requests.log"), { force: true });
  const configured = await control({ mode: "full" }).start({ prompt: promptFromText(""), cwd: dir });
  expect(configured.mode).toBe("full");
  expect((await requestsOf("session/create"))[0]?.["mode"]).toBe("yolo");
  // A mode the call names wins over the instance's.
  await rm(join(dir, "requests.log"), { force: true });
  expect((await control({ mode: "full" }).start({ prompt: promptFromText(""), cwd: dir, mode: "ask" })).mode).toBe("ask");
  expect((await requestsOf("session/create"))[0]?.["mode"]).toBe("guarded");
});

test("a model and an effort go with every send, never with the create", async () => {
  const c = control();
  const { session } = await c.start({
    prompt: promptFromText(""),
    cwd: dir,
    model: "builtin:zai-coding-plan/GLM-5.3-Flash",
    effort: "high",
  });
  expect((await requestsOf("session/create"))[0]).not.toHaveProperty("model");
  const selection = { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } };
  const ended = turnsEnded(c, session);
  await c.send(session, "one");
  // ZCode names no model back for a send that names one: the request is not taken for what runs.
  expect((await ended).filter((event) => event.kind === "model")).toEqual([]);
  expect((await requestsOf("session/send")).map((params) => params["modelSelection"])).toEqual([selection]);
});

test("a model id may hold slashes, and the control options are the defaults of a start", async () => {
  const c = control({ model: "2eafb73d/minimax/MiniMax-M3", effort: "max" });
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  const ended = turnsEnded(c, session);
  await c.send(session, "one");
  await ended;
  expect((await requestsOf("session/send"))[0]?.["modelSelection"]).toEqual({
    providerId: "2eafb73d",
    modelId: "minimax/MiniMax-M3",
    options: { reasoningLevel: "max" },
  });
});

test("an effort with no model chosen is applied to the model the server names", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir, effort: "low" });
  const ended = turnsEnded(c, session);
  await c.send(session, "one");
  await ended;
  expect((await requestsOf("session/send"))[0]?.["modelSelection"]).toEqual({
    providerId: "fake",
    modelId: "default-model",
    options: { reasoningLevel: "low" },
  });
});

test("what ZCode cannot do is refused by name before any process is born", async () => {
  const c = control();
  const refuse = async (options: Parameters<ZcodeSessionControl["start"]>[0], detail: string) => {
    const refusal = await c.start(options).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "Unsupported" });
    expect((refusal as Error).message).toContain(detail);
  };
  await refuse({ prompt: hello, effort: "xhigh" }, "is not one of low, high, max");
  await refuse({ prompt: hello, model: "no-provider" }, "providerId/modelId");
  await refuse({ prompt: hello, model: "provider/" }, "providerId/modelId");
  expect(spawned).toEqual([]);
  expect(ZCODE_LAUNCH).toEqual({ model: true, effort: ["low", "high", "max"], modes: ["ask", "auto", "full"] });
});

test("an allow-list gets niwa's own server tools appended; foreign server tools pass only when listed", async () => {
  const c = control();
  const niwa = { name: "niwa", command: "niwa", args: [], env: {}, tools: ["session_send", "submit_answer"] };
  const github = { name: "github", command: "gh-mcp", args: [], env: {} };
  const base = { workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit" };
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [niwa, github], tools: { allow: ["Read"] } });
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [niwa, github], tools: { allow: ["Read", "mcp__github__create_issue", "mcp__niwa__session_send"] } });
  // Without an allow-list nothing is filtered, so nothing is added.
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [niwa] });
  const created = await requestsOf("session/create");
  const wire = (server: { name: string; command: string }) => ({ name: server.name, command: server.command, args: [], env: [] });
  expect(created[0]).toEqual({ ...base, mcpServers: [wire(niwa), wire(github)], toolAllowlist: ["Read", "mcp__niwa__session_send", "mcp__niwa__submit_answer"] });
  expect(created[1]).toEqual({
    ...base,
    mcpServers: [wire(niwa), wire(github)],
    toolAllowlist: ["Read", "mcp__github__create_issue", "mcp__niwa__session_send", "mcp__niwa__submit_answer"],
  });
  expect(created[2]).toEqual({ ...base, mcpServers: [wire(niwa)] });
  expect(spawned.length).toBeGreaterThan(0);
});

test("a session of niwa's tools only allows none of ZCode's own tools, only those niwa's server lists", async () => {
  const c = control();
  const niwa = { name: "niwa", command: "niwa", args: [], env: {}, tools: ["session_send"] };
  const github = { name: "github", command: "gh-mcp", args: [], env: {} };
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [niwa, github], tools: "niwa-only" });
  await c.start({ prompt: promptFromText(""), cwd: dir, tools: "niwa-only" });
  await c.start({ prompt: promptFromText(""), cwd: dir, tools: "all" });
  const created = await requestsOf("session/create");
  expect(created[0]?.["toolAllowlist"]).toEqual(["mcp__niwa__session_send"]);
  expect(created[1]?.["toolAllowlist"]).toEqual([]);
  expect(created[2]).not.toHaveProperty("toolAllowlist");
});

test("the servers and the tool sets of a session go to session/create in ZCode's own shape", async () => {
  const c = control();
  const niwa = { name: "niwa", command: "niwa", args: ["--home", "/h", "mcp"], env: { NIWA_ID: "k3f9", EMPTY: "" } };
  // The deny-list and the servers together.
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [niwa], visible: { actions: ["a"], disabledTools: ["Bash", "Write"] } });
  expect((await requestsOf("session/create"))[0]).toEqual({
    workspace: { workspacePath: dir, workspaceKey: dir },
    mode: "edit",
    mcpServers: [
      { name: "niwa", command: "niwa", args: ["--home", "/h", "mcp"], env: [{ name: "NIWA_ID", value: "k3f9" }, { name: "EMPTY", value: "" }] },
    ],
    toolDenylist: ["Bash", "Write"],
  });
  // The allow-list alone, an empty one too: it allows nothing.
  await c.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["Read", "Grep"] } });
  await c.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: [] } });
  const created = await requestsOf("session/create");
  expect(created[1]).toEqual({ workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit", toolAllowlist: ["Read", "Grep"] });
  expect(created[2]).toEqual({ workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit", toolAllowlist: [] });
  // Visible actions that switch nothing off, and no servers, send nothing of the kind.
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [], visible: { actions: ["a"], disabledTools: [] } });
  expect((await requestsOf("session/create"))[3]).toEqual({ workspace: { workspacePath: dir, workspaceKey: dir }, mode: "edit" });
});

test("a message to a busy session waits for the turn after, and a steer goes into the running one", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: dir });
  const ended = turnsEnded(c, session, 2);
  const queued = await c.send(session, "second");
  expect(queued).toMatchObject({ status: "queued", turn: 2 });
  // The server has seen the first message only: the second waits on this side.
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow"]);
  const events = await ended;
  expect(events.filter((event) => event.kind === "turn-ended").map((event) => (event as { turn: number }).turn)).toEqual([1, 2]);
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow", "second"]);

  const running = await c.send(session, "third");
  expect(running).toMatchObject({ status: "started", turn: 3 });
  const steered = await c.send(session, "steer", { into: "turn" });
  expect(steered).toMatchObject({ status: "delivered", turn: 3 });
});

test("a steer goes through v4/command as a guided sendText, never as a session/send, which a running turn refuses", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: dir });
  const steered = await c.send(session, "steer", { into: "turn" });
  expect(steered).toMatchObject({ status: "delivered", turn: 1 });
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow"]);
  const [command] = await requestsOf("v4/command");
  expect(command).toMatchObject({
    sessionId: "sess_fake-1",
    type: "sendText",
    payload: { text: "steer", requestedDelivery: "guide" },
    workspace: { workspacePath: dir, workspaceKey: dir },
  });
  expect(typeof command?.["commandId"]).toBe("string");
  // Each steer is a command of its own.
  await c.send(session, "again", { into: "turn" });
  const ids = (await requestsOf("v4/command")).map((params) => params["commandId"]);
  expect(new Set(ids).size).toBe(2);
  // What the command did not take is a message that was not sent.
  await expect(c.send(session, "reject this", { into: "turn" })).rejects.toMatchObject({ code: "InputNotSent" });
});

test("a ZCode without v4/command refuses a steer by name and sends nothing", async () => {
  await writeFile(join(dir, "no-v4"), "");
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: dir });
  await expect(c.send(session, "steer", { into: "turn" })).rejects.toMatchObject({ code: "Unsupported" });
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow"]);
});

test("a resume of a held session with a prompt waits behind the running turn", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: dir });
  const ended = turnsEnded(c, session, 2);
  await c.resume(session, { prompt: promptFromText("after") });
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow"]);
  await ended;
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["slow", "after"]);
});

test("an ask returns the value that passed the schema, from the JSON in the answer or the answer itself", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  const word = await c.ask(session, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  expect(word.value).toEqual({ word: "ok" });
  expect((await requestsOf("session/send"))[0]?.["content"]).toContain("Answer with JSON only");

  const fenced = await c.ask(session, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the fenced word") });
  expect(fenced.value).toEqual({ word: "fenced" });
  const plain = await c.ask(session, { schema: z.string(), prompt: promptFromText("plain") });
  expect(plain.value).toBe("fake reply");
  // An answer the turn did not carry is read back from the transcript.
  const silent = await c.ask(session, { schema: z.string(), prompt: promptFromText("silent") });
  expect(silent.value).toBe("from the transcript");
  await expect(c.ask(session, { schema: z.object({ word: z.number() }), prompt: promptFromText("give the word") })).rejects.toThrow("did not pass the schema: word");
});

test("an ask to a busy session is answered after the turn that runs", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: dir });
  const answer = await c.ask(session, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  expect(answer.value).toEqual({ word: "ok" });
  expect((await requestsOf("session/send")).map((params) => String(params["content"]).slice(0, 4))).toEqual(["slow", "give"]);
});

test("an interrupt stops the turn through session/stop, ends it, and drops what waited behind it", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("hang"), cwd: dir });
  await c.send(session, "never sent");
  const ended = turnsEnded(c, session);
  await c.interrupt(session);
  await ended;
  expect(await requestsOf("session/stop")).toEqual([{ sessionId: "sess_fake-1" }]);
  expect(await c.state(session)).toBe("idle");
  expect((await requestsOf("session/send")).map((params) => params["content"])).toEqual(["hang"]);
  await expect(c.interrupt(session)).rejects.toMatchObject({ code: "Unavailable" });
});

test("a turn that fails is an error for its asker, and a turn that was cut is one too", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  await expect(c.ask(session, { schema: z.string(), prompt: promptFromText("fail") })).rejects.toThrow("the turn was failed: model exploded");
  expect(await c.state(session)).toBe("idle");

  const hanging = c.ask(session, { schema: z.string(), prompt: promptFromText("hang") });
  const settled = hanging.catch((error: unknown) => error);
  while ((await requestsOf("session/send")).length < 2) await Bun.sleep(10);
  await c.interrupt(session);
  expect(String(await settled)).toContain("the turn was cancelled");
});

test("a session whose process dies ends its stream and is unknown from then on", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of c.life(session)) events.push(event);
  })();
  await c.send(session, "die");
  await watching;
  expect(events.some((event) => event.kind === "activity" && event.detail?.includes("exited (3)"))).toBe(true);
  expect(await c.state(session)).toBe("unknown");
  // The process is gone: the message is never written, so sending it again is safe.
  await expect(c.send(session, "again")).rejects.toMatchObject({ code: "InputNotSent" });
});

test("a stray end of a turn when none runs is not a turn", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of c.life(session)) {
      events.push(event);
      if (event.kind === "activity" && event.detail?.includes("while none was running")) return;
    }
  })();
  await c.send(session, "stray");
  await watching;
  expect(events.filter((event) => event.kind === "turn-ended")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "turn-started")).toHaveLength(1);
});

/** Starts a session with no turn, watches it, sends a turn and gives its signs once it ended. */
async function signsOf(c: ZcodeSessionControl, content: string): Promise<LifeEvent[]> {
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of c.life(session)) {
      events.push(event);
      if (event.kind === "turn-ended") return;
    }
  })();
  await c.send(session, content);
  await watching;
  return events;
}

const detailsOf = (events: readonly LifeEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "activity" && event.detail !== undefined ? [event.detail] : []));

test("what the snapshot does not know is told in the log, with its raw message, and does not end or break the turn", async () => {
  await writeFile(join(dir, "script.json"), JSON.stringify([{ event: { type: "turn.hypothetical", payload: { x: 1 } } }]));
  const events = await signsOf(control(), "script");
  const details = detailsOf(events);
  // An event type that is new, and the request of the real server that the snapshot predates.
  expect(details.some((detail) => detail.startsWith('unknown zcode event type "turn.hypothetical" (not in the snapshot):') && detail.includes('"x":1'))).toBe(true);
  expect(details.some((detail) => detail.startsWith('unknown zcode method "session/readReplyLanguage" (not in the snapshot):'))).toBe(true);
  // The same two are the typed unknown the sessions plugin records: the protocol, the discriminator's value, the raw message.
  const unknown = events.flatMap((event) => (event.kind === "unknown-variant" ? [event] : []));
  expect(unknown.map((event) => [event.protocol, event.variant])).toEqual(
    expect.arrayContaining([
      ["zcode app-server", "session/event turn.hypothetical"],
      ["zcode app-server", "session/readReplyLanguage"],
    ]),
  );
  expect(unknown.find((event) => event.variant === "session/event turn.hypothetical")?.raw).toMatchObject({
    method: "session/event",
    params: { type: "turn.hypothetical", payload: { x: 1 } },
  });
  // The turn still ended by the event that ends it.
  expect(events.filter((event) => event.kind === "turn-ended")).toHaveLength(1);
});

test("the messages of the v4 side channel and the notifications that are not about a turn leave no sign in the log", async () => {
  const details = detailsOf(await signsOf(control(), "hello"));
  expect(details.filter((detail) => detail.includes("v4/") || detail.includes("state.updated"))).toEqual([]);
  expect(details).toContain("turn.started");
  expect(details).toContain("model.streaming");
});

test("a turn that ends with an error result is a failed turn that says which result it ended with", async () => {
  await writeFile(join(dir, "script.json"), JSON.stringify([{ event: { type: "turn.completed", payload: { resultType: "error_max_turns" } } }]));
  const details = detailsOf(await signsOf(control(), "script"));
  expect(details).toContain("the turn ended with error_max_turns");
});

test("a subscription falls back to the older spelling, and a start is refused when the server takes none", async () => {
  await writeFile(join(dir, "old-subscribe"), "");
  const c = control();
  await c.start({ prompt: promptFromText(""), cwd: dir });
  expect((await requestsOf("session/subscribe")).map((params) => params["deliveryKind"])).toEqual(["desktop-continuous", "desktop"]);

  await writeFile(join(dir, "no-subscribe"), "");
  await expect(control().start({ prompt: promptFromText(""), cwd: dir })).rejects.toMatchObject({ code: "Unavailable" });
});

test("a resume that is given the model of the session pins it in its sends, and one that is given none reports the model the server names", async () => {
  const id = sessionId(harnessId("zcode-fake"), "sess_old");
  const pinned = control();
  await pinned.resume(id, { model: modelName("fake/pinned") });
  const pinnedEnded = turnsEnded(pinned, id);
  await pinned.send(id, "go");
  // The model was recorded when it was named: the pin goes with the sends, and nothing names it again.
  expect((await pinnedEnded).filter((event) => event.kind === "model")).toEqual([]);
  expect((await requestsOf("session/send"))[0]?.["modelSelection"]).toEqual({ providerId: "fake", modelId: "pinned" });

  const unpinned = control();
  await unpinned.resume(id);
  const unpinnedEnded = turnsEnded(unpinned, id);
  await unpinned.send(id, "go");
  expect((await unpinnedEnded)[0]).toEqual({ kind: "model", model: modelName("fake/default-model") });
});

test("a session that was not started here is resumed in a process of its own, in the directory it ran in", async () => {
  const home = join(dir, "home");
  await mkdir(join(home, "cli", "db"), { recursive: true });
  const db = createDatabase(dbPathOf(home));
  writeSession(db, "sess_old", [user("m1", "hi"), assistant("m2", "hello")], { directory: dir });
  db.close();

  const c = control({ home });
  const id = sessionId(harnessId("zcode-fake"), "sess_old");
  const ended = new Promise<void>((resolve, reject) => {
    c.resume(id, { prompt: promptFromText("go on") }).then(resolve, reject);
  });
  await ended;
  expect(spawned[0]).toEqual([bin, "app-server", "--stdio", "--cwd", dir]);
  expect((await requestsOf("session/resume"))[0]).toEqual({ sessionId: "sess_old", workspace: { workspacePath: dir, workspaceKey: dir } });
  expect((await requestsOf("session/send")).map((params) => params["sessionId"])).toEqual(["sess_old"]);
  expect(await c.state(id)).toBe("idle");

  // A resume that launches a process again gives it the servers and tool sets too, for the runtime it rebuilds.
  const again = control({ home });
  await again.resume(id, {
    servers: [{ name: "niwa", command: "niwa", args: ["mcp"], env: { NIWA_ID: "t" } }],
    visible: { actions: [], disabledTools: ["Bash"] },
  });
  expect((await requestsOf("session/resume"))[1]).toEqual({
    sessionId: "sess_old",
    workspace: { workspacePath: dir, workspaceKey: dir },
    mcpServers: [{ name: "niwa", command: "niwa", args: ["mcp"], env: [{ name: "NIWA_ID", value: "t" }] }],
    toolDenylist: ["Bash"],
  });
  // The allow-list of a resume carries niwa's own server tools as well.
  await control({ home }).resume(id, { servers: [{ name: "niwa", command: "niwa", args: [], env: {}, tools: ["session_send"] }], tools: { allow: ["Read"] } });
  expect(((await requestsOf("session/resume"))[2] as Record<string, unknown>)["toolAllowlist"]).toEqual(["Read", "mcp__niwa__session_send"]);

  // Held now: a resume goes on in the same process, and cannot take another box.
  await c.resume(id);
  expect(spawned).toHaveLength(3);
  await expect(c.resume(id, { box: { sandbox: "srt", spec: { cwd: dir } } })).rejects.toMatchObject({ code: "Unsupported" });
  // Visible actions that switch nothing off take no tool set.
  await c.resume(id, { visible: { actions: ["a"], disabledTools: [] } });
});

test("a resume of a held session with the same surface changes nothing; with another, a new process takes the session on", async () => {
  const c = control();
  const server = { name: "niwa", command: "niwa", args: ["mcp"], env: { NIWA_ID: "t" } };
  const { session } = await c.start({ prompt: promptFromText(""), cwd: dir, servers: [server], visible: { actions: [], disabledTools: ["Bash"] } });
  const events: string[] = [];
  const watching = (async () => { for await (const event of c.life(session)) events.push(event.kind); })();
  expect(spawned).toHaveLength(1);
  // The same: accepted silently, no new process.
  await c.resume(session, { servers: [server], visible: { actions: [], disabledTools: ["Bash"] } });
  expect(spawned).toHaveLength(1);
  // Nothing asked: the process keeps what it has.
  await c.resume(session);
  expect(spawned).toHaveLength(1);
  // Another: the held process is ended and a new one resumes the session with the new surface.
  await c.resume(session, { servers: [server], tools: { allow: ["Read"] } });
  expect(spawned).toHaveLength(2);
  const resumed = await requestsOf("session/resume");
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({ sessionId: session.native, toolAllowlist: ["Read"] });
  expect(resumed[0]?.["toolDenylist"]).toBeUndefined();
  expect(await c.state(session)).toBe("idle");
  // Under a running turn the surface cannot change.
  await c.send(session, "slow");
  await expect(c.resume(session, { tools: { allow: [] } })).rejects.toMatchObject({ code: "Unavailable" });
  expect(spawned).toHaveLength(2);
});

test("the ZCode fields of a server go through to its mcpServers entry, and are absent by default", async () => {
  const c = control();
  const plain = { name: "a", command: "a", args: [], env: {} };
  const set = { name: "b", command: "b", args: [], env: {}, zcode: { alwaysLoad: true, timeoutMs: 5000, isolation: "session" as const, scope: "workspace" as const, cwd: "/w" } };
  await c.start({ prompt: promptFromText(""), cwd: dir, servers: [plain, set] });
  expect((await requestsOf("session/create"))[0]?.["mcpServers"]).toEqual([
    { name: "a", command: "a", args: [], env: [] },
    { name: "b", command: "b", args: [], env: [], alwaysLoad: true, timeoutMs: 5000, isolation: "session", scope: "workspace", cwd: "/w" },
  ]);
});

test("a cold resume is refused when ZCode restores another mode than niwa started the session in", async () => {
  const home = join(dir, "home");
  await mkdir(join(home, "cli", "db"), { recursive: true });
  const db = createDatabase(dbPathOf(home));
  const stamped = (id: string, mode: string) => {
    const message = assistant(id, "hello");
    return { ...message, data: { ...message.data, mode } };
  };
  writeSession(db, "sess_edit", [user("m1", "hi"), stamped("m2", "edit")], { directory: dir });
  writeSession(db, "sess_unstamped", [user("m3", "hi"), assistant("m4", "hello")], { directory: dir });
  writeSession(db, "sess_project", [user("m5", "hi"), assistant("m6", "hello")], { directory: dir, project: "proj" });
  db.query("insert into local_setting values ('project', 'proj', 'permission', 'mode', ?, 1, 1, 1)").run(JSON.stringify({ mode: "yolo" }));
  db.close();
  const c = control({ home });
  const edit = sessionId(harnessId("zcode-fake"), "sess_edit");
  // niwa's `ask` is ZCode's `guarded`; the session was stamped `edit`: refused, no process left running, not held.
  await expect(c.resume(edit, { mode: "ask", prompt: promptFromText("go") })).rejects.toThrow(/restores the session in the mode "edit".*"guarded"/);
  expect((await requestsOf("session/send")).length).toBe(0);
  expect(await c.state(edit)).toBe("unknown");
  // The same mode: resumed, and the turn runs. No mode is named to ZCode.
  await c.resume(edit, { mode: "auto", prompt: promptFromText("go") });
  expect((await requestsOf("session/send")).length).toBe(1);
  expect((await requestsOf("session/resume")).at(-1)?.["mode"]).toBeUndefined();
  // No assistant message: the project's permission mode, else ZCode's built-in `build`; either must be niwa's.
  const unstamped = sessionId(harnessId("zcode-fake"), "sess_unstamped");
  await expect(c.resume(unstamped, { mode: "full" })).rejects.toThrow(/restores the session in the mode "build".*"yolo"/);
  const withProject = sessionId(harnessId("zcode-fake"), "sess_project");
  await expect(c.resume(withProject, { mode: "auto" })).rejects.toThrow(/restores the session in the mode "yolo".*"edit"/);
  await c.resume(withProject, { mode: "full" });
  // A session the database does not know: the mode cannot be determined, and the resume fails.
  await expect(c.resume(sessionId(harnessId("zcode-fake"), "sess_nowhere"), { mode: "auto" })).rejects.toThrow(/cannot be read/);
});

test("a resume the server refuses leaves no process behind", async () => {
  await writeFile(join(dir, "resume-fail"), "");
  const c = control();
  await expect(c.resume(sessionId(harnessId("zcode-fake"), "sess_gone"))).rejects.toMatchObject({ code: "Unavailable" });
  const pid = (await logOf("env.log"))[0]?.["pid"] as number;
  await Bun.sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a session starts inside a box: the directory of ZCode is added to the manifest, which is recorded before the process", async () => {
  const records: BoxRecord[] = [];
  const nono: Sandbox = {
    name: "nono",
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: "nono", cwd: spec.cwd, env: spec.env }),
    async launch(spec, argv): Promise<LaunchedBox> {
      const child = Bun.spawn([...argv], { cwd: spec.cwd, env: { ...spec.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill() };
    },
  };
  const restore = useSandbox("nono", nono);
  const forget = onBoxManifest((record) => void records.push(record));
  try {
    const c = control();
    const started = await c.start({
      prompt: hello,
      cwd: dir,
      env: { NIWA_ID: "k3f9" },
      box: { sandbox: "nono", spec: { cwd: dir, write: [dir], env: {} } },
    });
    expect(String(started.session.native)).toBe("sess_fake-1");
    expect(records[0]?.spec.write.map(String)).toEqual([dir, homePath(".zcode")]);
    expect(Object.entries(records[0]?.spec.env ?? {})).toContainEqual(["NIWA_ID", "k3f9"]);
    expect((await logOf("env.log"))[0]).toMatchObject({ id: "k3f9" });
  } finally {
    forget();
    restore();
  }
});

test("dispose stops the process of every session", async () => {
  const c = control();
  await c.start({ prompt: promptFromText("hang"), cwd: dir });
  const pid = (await logOf("env.log"))[0]?.["pid"] as number;
  expect(() => process.kill(pid, 0)).not.toThrow();
  await c.dispose();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(c.start({ prompt: hello, cwd: dir })).rejects.toMatchObject({ code: "Unavailable" });
});

test("zcode passes the control conformance suite", async () => {
  const id = harnessId("zcode-fake");
  const instance: Harness = {
    id,
    kind: harnessKind("zcode"),
    machine: machineId("machine-1"),
    home: dir,
    sides: {
      control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: ZCODE_LAUNCH },
    },
  };
  const report = await controlConformance("zcode", { instance, control: control() })();
  expect(report.results.filter((result) => !result.passed).map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(15);
});
