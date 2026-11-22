/**
 * The OpenCode control side against a stand-in for `opencode serve --stdio`
 * (`fixtures/fake-opencode-server.ts`): the real typed client of `@opencode/client` speaks to the
 * fake, so what passes here is what the generated client builds. The fake writes what it was given
 * into the test's directory (`requests.log`, `replies.log`, `sessions.json`), and its address goes
 * to `url.log`, through which a test pushes events onto the stream (`POST /control/push`) as the
 * server would.
 *
 * The signs of life are a forward-only stream, so a test subscribes before the action that starts
 * a turn. Every test disposes its control side, so no child outlives it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { controlConformance, harnessId, harnessKind, machineId, modelName, promptFromText, sessionId } from "@niwa-labs/harness";
import type { Harness, LifeEvent, ReverseHandler, SessionId } from "@niwa-labs/harness";
import { onSpawn } from "@niwa-labs/sandbox";
import type { SpawnEvent } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

import { OPENCODE_LAUNCH, opencodeControl } from "../src/control.ts";
import type { OpenCodeControlOptions, OpenCodeSessionControl } from "../src/control.ts";

let dir = "";
let bin = "";
const controls: OpenCodeSessionControl[] = [];
const spawns: SpawnEvent[] = [];
let unsubscribe = (): void => {};

beforeEach(async () => {
  dir = await tempDir("opencode-control");
  bin = join(dir, "opencode.ts");
  await cp(fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url)), bin);
  await chmod(bin, 0o755);
  await mkdir(join(dir, "work"), { recursive: true });
  unsubscribe = onSpawn((event) => spawns.push(event));
});

afterEach(async () => {
  unsubscribe();
  spawns.length = 0;
  for (const control of controls.splice(0)) await control.dispose();
  await rm(dir, { recursive: true, force: true });
});

function control(extra: Partial<OpenCodeControlOptions> = {}): OpenCodeSessionControl {
  const made = opencodeControl({ harness: "opencode-fake", binary: bin, stopGraceMs: 300, ...extra });
  controls.push(made);
  return made;
}

/** Where the fake keeps what it was given: its own working directory, the session's. */
const logOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, "work", name), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The bodies of every request the fake got under a path. */
const bodiesOf = async (path: string): Promise<Array<Record<string, unknown>>> =>
  (await logOf("requests.log")).filter((frame) => frame["path"] === path).map((frame) => (frame["body"] ?? {}) as Record<string, unknown>);

/** The prompts the fake was given, in order. */
const promptsOf = async (): Promise<Array<{ text: string; delivery?: string }>> =>
  (await logOf("requests.log"))
    .filter((frame) => String(frame["path"]).endsWith("/prompt"))
    .map((frame) => (frame["body"] ?? {}) as { text: string; delivery?: string });

/** The last run of the fake: its address, through which a test pushes events. */
async function postToFake(path: string, body?: Record<string, unknown>): Promise<void> {
  const runs = await logOf("url.log");
  const last = runs.at(-1);
  if (last === undefined) throw new Error("the fake has not run");
  const url = String(last["url"]);
  const response = await fetch(`${url}/control/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (response.status !== 204) throw new Error(`${path} was refused: ${String(response.status)}`);
}

const push = (event: Record<string, unknown>): Promise<void> => postToFake("push", event);

/** Watches the signs of life until `count` turns have ended. */
function turnsEnded(c: OpenCodeSessionControl, id: SessionId, count = 1): Promise<LifeEvent[]> {
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
const cwd = (): string => join(dir, "work");

test("a start spawns one server, checks its version, names the session and begins its first turn", async () => {
  const c = control();
  const started = await c.start({ prompt: hello, cwd: cwd(), env: { NIWA_ID: "k3f9" } });
  expect(String(started.session.native)).toBe("ses_fake-1");
  expect(started.first).toMatchObject({ status: "started", turn: 1 });
  expect(started.mode).toBe("auto");

  expect(spawns.map((event) => event.argv)).toEqual([[bin, "serve", "--stdio"]]);
  expect(Object.entries(spawns[0]?.env ?? {})).toContainEqual(["NIWA_ID", "k3f9"]);
  expect(typeof spawns[0]?.env["OPENCODE_PASSWORD"]).toBe("string");
  const paths = (await logOf("requests.log")).map((frame) => `${String(frame["method"])} ${String(frame["path"])}`);
  expect(paths.slice(0, 4)).toEqual([
    "GET /api/info",
    "POST /api/session",
    "GET /api/event",
    "POST /api/session/ses_fake-1/prompt",
  ]);
  // The create names the directory and the mode's permissions; no model was chosen, so none goes.
  expect((await bodiesOf("/api/session"))[0]).toEqual({
    location: { directory: cwd() },
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ],
  });
  // The first turn began inside the start: its signs are kept for the first stream. No model was
  // asked for, so the model the session runs is reported, once.
  const signs = await turnsEnded(c, started.session);
  // The first step may be seen before or after the admission reported the turn's start; the end
  // of the turn is the last of the three.
  const kinds = signs.map((event) => event.kind).filter((kind) => kind !== "activity");
  expect([...kinds].sort()).toEqual(["model", "turn-ended", "turn-started"]);
  expect(kinds.at(-1)).toBe("turn-ended");
  expect(signs.find((event) => event.kind === "model")).toEqual({ kind: "model", model: modelName("fake/default-model") });
  expect(signs.find((event) => event.kind === "turn-ended")).toMatchObject({ turn: 1, outcome: "completed" });
  expect(await c.state(started.session)).toBe("idle");
});

test("a start tells the caller the session before its first prompt goes out", async () => {
  const named: string[] = [];
  let prompted: number | undefined;
  const { session } = await control().start({
    prompt: hello,
    cwd: cwd(),
    named: async (id) => {
      named.push(String(id.native));
      prompted = (await promptsOf()).length;
    },
  });
  expect(named).toEqual([String(session.native)]);
  expect(prompted).toBe(0);
});

test("the working mode is the permissions of the created session; the control option is the default", async () => {
  const created: Array<unknown> = [];
  const start = async (call: { mode?: "auto" | "full" }, instance: { mode?: "auto" | "full" } = {}): Promise<void> => {
    await control(instance).start({ prompt: promptFromText(""), cwd: cwd(), ...(call.mode === undefined ? {} : { mode: call.mode }) });
    created.push((await bodiesOf("/api/session")).at(-1)?.["permissions"]);
  };
  await start({ mode: "full" });
  // The control option is the default of a start.
  await start({}, { mode: "full" });
  // A mode the call names wins over the instance's.
  await start({ mode: "auto" }, { mode: "full" });
  expect(created).toEqual([
    [{ action: "*", resource: "*", effect: "allow" }],
    [{ action: "*", resource: "*", effect: "allow" }],
    [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ],
  ]);
});

test("ask mode is refused before launching or prompting an OpenCode session", async () => {
  const refused = { code: "Unsupported", message: expect.stringContaining("saved project approvals") };
  await expect(control().start({ prompt: hello, cwd: cwd(), mode: "ask" })).rejects.toMatchObject(refused);
  await expect(control({ mode: "ask" }).start({ prompt: hello, cwd: cwd() })).rejects.toMatchObject(refused);
  expect(spawns).toHaveLength(0);

  const side = control();
  const { session } = await side.start({ prompt: promptFromText(""), cwd: cwd() });
  await expect(side.resume(session, { mode: "ask", prompt: hello })).rejects.toMatchObject(refused);
  await side.dispose();
  await expect(control().resume(session, { cwd: cwd(), mode: "ask", prompt: hello })).rejects.toMatchObject(refused);
  expect(spawns).toHaveLength(1);
  expect(await promptsOf()).toEqual([]);
});

test("a start stops the child when the server cannot confirm the session permissions", async () => {
  let named = false;
  await expect(control().start({
    prompt: hello,
    cwd: cwd(),
    env: { FAKE_OMIT_CREATED_PERMISSIONS: "1" },
    named: () => {
      named = true;
    },
  })).rejects.toThrow(/did not confirm the session permissions for mode "auto"/);
  expect(named).toBe(false);
  expect(await promptsOf()).toEqual([]);
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a model goes to the create, split at its first slash; one that is not named is refused", async () => {
  const c = control();
  const signsOf = async (options: Parameters<OpenCodeSessionControl["start"]>[0]): Promise<string[]> => {
    const { session } = await c.start(options);
    const ended = turnsEnded(c, session);
    await c.send(session, "one");
    return (await ended).map((event) => event.kind);
  };
  // A model id may hold slashes of its own.
  expect(await signsOf({ prompt: promptFromText(""), cwd: cwd(), model: "provider/mini/max/Model-X" })).not.toContain("model");
  expect((await bodiesOf("/api/session")).at(-1)?.["model"]).toEqual({ providerID: "provider", id: "mini/max/Model-X" });
  // No model chosen: the one the session runs is reported, once.
  expect(await signsOf({ prompt: promptFromText(""), cwd: cwd() })).toContain("model");
  await expect(c.start({ prompt: hello, cwd: cwd(), model: "no-provider" })).rejects.toMatchObject({ code: "Unsupported" });
  expect(spawns.length).toBe(2);
  expect(OPENCODE_LAUNCH).toEqual({ model: true, effort: [], modes: ["auto", "full"] });
});

test("the MCP servers of a session go to the child as an OPENCODE_CONFIG_CONTENT document", async () => {
  await control().start({
    prompt: promptFromText(""),
    cwd: cwd(),
    servers: [{ name: "niwa", command: "niwa", args: ["--home", "/h", "mcp"], env: { NIWA_ID: "t" } }],
  });
  // No servers: no document.
  await control().start({ prompt: promptFromText(""), cwd: cwd() });
  const withServers = spawns[0]?.env["OPENCODE_CONFIG_CONTENT"];
  expect(typeof withServers).toBe("string");
  expect(JSON.parse(String(withServers))).toEqual({
    mcp: { servers: { niwa: { type: "local", command: ["niwa", "--home", "/h", "mcp"], environment: { NIWA_ID: "t" } } } },
  });
  expect(spawns[1]?.env["OPENCODE_CONFIG_CONTENT"]).toBeUndefined();
});

test("the installation home names the child's XDG data directory", async () => {
  const home = join(dir, "data", "opencode");
  await control({ home }).start({ prompt: promptFromText(""), cwd: cwd() });
  expect(spawns[0]?.env["XDG_DATA_HOME"]).toBe(join(dir, "data"));
});

test("a tool set this kind cannot hold is refused by name, before any process is born", async () => {
  const c = control();
  await expect(c.start({ prompt: hello, cwd: cwd(), tools: "niwa-only" })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(c.start({ prompt: hello, cwd: cwd(), tools: { allow: ["read"] } })).rejects.toMatchObject({ code: "Unsupported" });
  expect(spawns).toEqual([]);
});

test("a message to a busy session waits for the turn after, and goes when the running turn ends", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: cwd() });
  const ended = turnsEnded(c, session, 2);
  const queued = await c.send(session, "second");
  expect(queued).toMatchObject({ status: "queued", turn: 2 });
  // The server has seen the first message only: the second waits on this side.
  expect((await promptsOf()).map((body) => body.text)).toEqual(["slow"]);
  expect(await c.state(session)).toBe("running");
  // The running turn ends (pushed, as a turn that ends on its own would): the waiting one goes.
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  const events = await ended;
  expect(events.filter((event) => event.kind === "turn-ended").map((event) => (event as { turn: number }).turn)).toEqual([1, 2]);
  expect((await promptsOf()).map((body) => body.text)).toEqual(["slow", "second"]);
  expect(await c.state(session)).toBe("idle");
});

test("a steer goes into the running turn as a delivery the server steers by", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: cwd() });
  const steered = await c.send(session, "a steer", { into: "turn" });
  expect(steered).toMatchObject({ status: "delivered", turn: 1 });
  expect(await promptsOf()).toEqual([
    { text: "slow", delivery: "queue" },
    { text: "a steer", delivery: "steer" },
  ]);
  // A steer to a session that runs nothing is a turn of its own.
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  while ((await c.state(session)) !== "idle") await Bun.sleep(10);
  const started = await c.send(session, "a start", { into: "turn" });
  expect(started).toMatchObject({ status: "started", turn: 2 });
});

test("an interrupt ends the running turn, drops what waited behind it and refuses when none runs", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("hang"), cwd: cwd() });
  await c.send(session, "never sent");
  const ended = turnsEnded(c, session);
  await c.interrupt(session);
  const events = await ended;
  expect(events.find((event) => event.kind === "turn-ended")).toMatchObject({ turn: 1, outcome: "failed" });
  expect((await logOf("requests.log")).some((frame) => frame["path"] === `/api/session/${session.native}/interrupt`)).toBe(true);
  expect((await promptsOf()).map((body) => body.text)).toEqual(["hang"]);
  expect(await c.state(session)).toBe("idle");
  await expect(c.interrupt(session)).rejects.toMatchObject({ code: "Unavailable" });
});

test("an interrupt still awaiting a reply cannot overtake a newly queued turn", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("interrupt me"), cwd: cwd(), env: { FAKE_INTERRUPT_GATE: "1" } });
  const stream = c.life(session)[Symbol.asyncIterator]();
  const interrupted = c.interrupt(session);
  // An earlier assertion can tear down the fake before the test releases its reply gate.
  void interrupted.catch(() => {});
  const interruptPath = `/api/session/${session.native}/interrupt`;
  for (let i = 0; i < 100 && (await bodiesOf(interruptPath)).length === 0; i += 1) await Bun.sleep(10);
  expect((await bodiesOf(interruptPath)).length).toBe(1);
  expect(await c.send(session, "after interrupt")).toMatchObject({ status: "queued" });
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  for (;;) {
    const result = await stream.next();
    if (result.done) throw new Error("session ended before the running turn finished");
    if (result.value.kind === "turn-ended") break;
  }
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["interrupt me"]);
  await expect(c.send(session, "steer while cutting", { into: "turn" })).rejects.toMatchObject({ code: "InputNotSent" });
  await postToFake("release-interrupt");
  await interrupted;
  for (;;) {
    const result = await stream.next();
    if (result.done) throw new Error("session ended before the queued turn finished");
    if (result.value.kind !== "turn-ended") continue;
    expect(result.value).toMatchObject({ turn: 2, outcome: "completed" });
    break;
  }
  await stream.return?.();
});

test("a turn ends as completed when the execution succeeded, and as failed when it failed", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("hello"), cwd: cwd() });
  expect((await turnsEnded(c, session)).find((event) => event.kind === "turn-ended")).toMatchObject({ outcome: "completed" });
  const failed = await c.start({ prompt: promptFromText("fail"), cwd: cwd() });
  const signs = await turnsEnded(c, failed.session);
  expect(signs.find((event) => event.kind === "turn-ended")).toMatchObject({ outcome: "failed" });
  expect(signs.some((event) => event.kind === "activity" && event.detail?.includes("model exploded"))).toBe(true);
});

test("a permission goes to the reverse handler, whose answer is replied; niwa never says always", async () => {
  const questions: string[] = [];
  const answering = (flavor: "allow_once" | "reject_once"): ReverseHandler => async (_session, request) => {
    questions.push(request.question.title);
    if (!("options" in request.question)) return { cancelled: true };
    const option = request.question.options.find((candidate) => candidate.flavor === flavor);
    return { ids: option === undefined ? [] : [option.id] };
  };
  const allowing = control();
  const first = await allowing.start({ prompt: promptFromText("permission"), cwd: cwd(), reverse: answering("allow_once") });
  expect((await turnsEnded(allowing, first.session)).find((event) => event.kind === "turn-ended")).toMatchObject({ outcome: "completed" });
  expect((await logOf("replies.log"))).toEqual([{ sessionID: first.session.native, requestID: "per_1", decision: "once" }]);
  expect(questions).toEqual(["shell"]);

  const denying = control();
  const second = await denying.start({ prompt: promptFromText("permission"), cwd: cwd(), reverse: answering("reject_once") });
  expect((await turnsEnded(denying, second.session)).find((event) => event.kind === "turn-ended")).toMatchObject({ outcome: "failed" });
  expect((await logOf("replies.log")).at(-1)).toMatchObject({ decision: "reject" });
});

test("a permission nobody is asked about is denied unless the control opts in", async () => {
  const denying = control();
  const first = await denying.start({ prompt: promptFromText("permission"), cwd: cwd() });
  await turnsEnded(denying, first.session);
  expect((await logOf("replies.log"))).toEqual([{ sessionID: first.session.native, requestID: "per_1", decision: "reject" }]);

  const allowing = control({ permissions: "allow" });
  const second = await allowing.start({ prompt: promptFromText("permission"), cwd: cwd() });
  await turnsEnded(allowing, second.session);
  expect((await logOf("replies.log")).at(-1)).toMatchObject({ decision: "once" });
});

test("an OpenCode form travels through reverse and receives the native answer", async () => {
  const c = control();
  const { session } = await c.start({
    prompt: promptFromText("form"),
    cwd: cwd(),
    reverse: async (_, request) => {
      expect(request.raw.method).toBe("form.created");
      expect(request.question).toMatchObject({ kind: "form", title: "Choose a topic" });
      return { form: { topic: "scoping", confirm: true } };
    },
  });
  await turnsEnded(c, session);
  expect(await bodiesOf(`/api/session/${session.native}/form/frm_test/reply`)).toEqual([
    { answer: { topic: "scoping", confirm: true } },
  ]);
});

test("forms without a handler or representable fields are cancelled on the server", async () => {
  const c = control();
  const first = await c.start({ prompt: promptFromText("form"), cwd: cwd() });
  await turnsEnded(c, first.session);
  let called = false;
  const second = await c.start({
    prompt: promptFromText("external form"),
    cwd: cwd(),
    reverse: async () => {
      called = true;
      return { cancelled: true };
    },
  });
  await turnsEnded(c, second.session);
  const cancellations = (await logOf("requests.log")).filter((frame) => frame["method"] === "DELETE" && String(frame["path"]).endsWith("/form/frm_test"));
  expect(cancellations.map((frame) => frame["path"])).toEqual([
    `/api/session/${first.session.native}/form/frm_test`,
    `/api/session/${second.session.native}/form/frm_test`,
  ]);
  expect(called).toBe(false);
});

test("an ask returns the value that passed the schema, from the JSON the turn answered", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  const word = await c.ask(session, { schema: z.object({ word: z.string() }), prompt: promptFromText("json") });
  expect(word.value).toEqual({ word: "ok" });
  const fenced = await c.ask(session, { schema: z.object({ word: z.string() }), prompt: promptFromText("fenced") });
  expect(fenced.value).toEqual({ word: "fenced" });
  const plain = await c.ask(session, { schema: z.string(), prompt: promptFromText("hello") });
  expect(plain.value).toBe("fake reply");
  // An answer the turn's stream did not carry is read back from the session's messages.
  const silent = await c.ask(session, { schema: z.string(), prompt: promptFromText("silent") });
  expect(silent.value).toBe("from the transcript");
  await expect(c.ask(session, { schema: z.string(), prompt: promptFromText("empty") })).rejects.toThrow("the turn left no answer");
  await expect(c.ask(session, { schema: z.object({ word: z.number() }), prompt: promptFromText("json") })).rejects.toThrow("did not pass the schema");
  expect((await promptsOf())[0]?.text).toContain("Answer with JSON only");
});

test("queued asks use their own transcript even when the next turn has already started", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: cwd() });
  const ended = turnsEnded(c, session, 3);
  const asked = c.ask(session, { schema: z.string(), prompt: promptFromText("silent after queue") });
  expect(await c.send(session, "after")).toMatchObject({ status: "queued", turn: 3 });
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  expect((await asked).value).toBe("from the transcript");
  await ended;
  expect((await promptsOf()).map(({ text }) => text.split("\n")[0])).toEqual(["slow", "silent after queue", "after"]);
});

test("an event type this client does not know is a sign of the unknown, and the turn still ends", async () => {
  await writeFile(join(dir, "work", "script.json"), JSON.stringify([{ event: { type: "session.hypothetical", data: { x: 1 } } }]));
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of c.life(session)) {
      events.push(event);
      if (event.kind === "turn-ended") return;
    }
  })();
  await c.send(session, "script");
  await watching;
  const unknown = events.flatMap((event) => (event.kind === "unknown-variant" ? [event] : []));
  expect(unknown.map((event) => [String(event.protocol), String(event.variant)])).toEqual([["opencode server v2", "session.hypothetical"]]);
  expect(unknown[0]?.raw).toMatchObject({ type: "session.hypothetical", data: { x: 1 } });
  expect(events.some((event) => event.kind === "activity" && event.detail === "session.hypothetical")).toBe(true);
  expect(events.filter((event) => event.kind === "turn-ended")).toHaveLength(1);
});

test("a server of another major is refused by name, and its child is not left running", async () => {
  await expect(control().start({ prompt: hello, cwd: cwd(), env: { FAKE_VERSION: "1.9.0" } })).rejects.toThrow(/1\.9\.0.*opencode server v2/);
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  await Bun.sleep(150);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await bodiesOf("/api/session")).toEqual([]);
});

test("a server whose event stream stays silent fails the start within the call timeout", async () => {
  const c = control({ callTimeoutMs: 750 });
  await expect(c.start({ prompt: hello, cwd: cwd(), env: { FAKE_SILENT_STREAM: "1" } })).rejects.toThrow(
    /event stream said nothing within 750 ms/,
  );
  // The create precedes the subscription, so the server did make the session; the child of the
  // failed start is not left running.
  expect((await bodiesOf("/api/session")).length).toBe(1);
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  await Bun.sleep(150);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a server whose event stream closes without a first event cannot start", async () => {
  const c = control();
  await expect(c.start({ prompt: hello, cwd: cwd(), env: { FAKE_EMPTY_STREAM: "1" } })).rejects.toThrow(/event stream closed before its first delivery/);
  expect(await promptsOf()).toEqual([]);
});

test("a child that never announces its address fails the start, stops, and does not wedge dispose", async () => {
  const c = control({ callTimeoutMs: 750 });
  await expect(c.start({ prompt: hello, cwd: cwd(), env: { FAKE_SILENT_BOOT: "1" } })).rejects.toThrow(
    /did not announce its address within 750 ms/,
  );
  // The child of the failed launch is stopped, and the control side is not wedged by it.
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  await Bun.sleep(150);
  expect(() => process.kill(pid, 0)).toThrow();
  await c.dispose();
});

test("a tool asked to be switched off is refused by name, on a start and on a resume", async () => {
  const c = control();
  await expect(
    c.start({ prompt: hello, cwd: cwd(), visible: { actions: [], disabledTools: ["bash"] } }),
  ).rejects.toMatchObject({ code: "Unsupported" });
  expect(spawns).toEqual([]);
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  await expect(c.resume(session, { visible: { actions: [], disabledTools: ["read"] } })).rejects.toMatchObject({ code: "Unsupported" });
});

test("the caller's own config document is kept and the session's servers are merged into it", async () => {
  const caller = JSON.stringify({ providers: { bifrost: { name: "Bifrost" } } });
  await control().start({
    prompt: promptFromText(""),
    cwd: cwd(),
    env: { OPENCODE_CONFIG_CONTENT: caller },
    servers: [{ name: "niwa", command: "niwa", args: ["mcp"], env: {} }],
  });
  expect(JSON.parse(String(spawns[0]?.env["OPENCODE_CONFIG_CONTENT"]))).toEqual({
    providers: { bifrost: { name: "Bifrost" } },
    mcp: { servers: { niwa: { type: "local", command: ["niwa", "mcp"] } } },
  });
  // A document that is not a JSON object is refused loudly, not dropped in silence.
  await expect(
    control().start({ prompt: hello, cwd: cwd(), env: { OPENCODE_CONFIG_CONTENT: "not json" }, servers: [{ name: "x", command: "x", args: [], env: {} }] }),
  ).rejects.toMatchObject({ code: "Unsupported" });
});

test("a resume compares the mode and the model with what the session really works under", async () => {
  const first = control();
  const model = modelName("fake/pinned-model");
  const { session } = await first.start({ prompt: promptFromText(""), cwd: cwd(), mode: "full", model });
  await first.dispose();

  const c = control();
  // The mode the session was started in is accepted back.
  await c.resume(session, { cwd: cwd(), mode: "full", model });
  await c.resume(session);
  await c.dispose();
  // A mode the session was not started in is refused: the session was not resumed as if it had been.
  const again = control();
  await expect(again.resume(session, { cwd: cwd(), mode: "auto", prompt: hello })).rejects.toThrow(/permissions differ from mode "auto"/);
  await expect(again.resume(session, { cwd: cwd(), model: modelName("fake/other"), prompt: hello })).rejects.toThrow(/the session runs "fake\/pinned-model"/);
  expect(await promptsOf()).toEqual([]);
});

test("a held resume rejects other modes and models before admitting or queuing work", async () => {
  const c = control();
  const model = modelName("fake/pinned-model");
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: cwd(), mode: "auto", model });
  const ended = turnsEnded(c, session, 2);
  await expect(c.resume(session, { mode: "full", prompt: promptFromText("wrong mode") })).rejects.toThrow(/permissions differ from mode "full"/);
  await expect(c.resume(session, { model: modelName("fake/other"), prompt: promptFromText("wrong model") })).rejects.toThrow(/the session runs "fake\/pinned-model"/);
  await c.resume(session, { mode: "auto", model, prompt: promptFromText("matched") });
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  await ended;
  expect(spawns.length).toBe(1);
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["slow", "matched"]);
});

test("a resume cannot promise a requested model missing from the session record", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  await expect(c.resume(session, { model: modelName("fake/other"), prompt: hello })).rejects.toThrow(/did not confirm the requested model/);
  expect(await promptsOf()).toEqual([]);
});

test("a session whose process dies ends its stream, is unknown from then on, and sends nothing again", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of c.life(session)) events.push(event);
  })();
  await c.send(session, "die");
  await watching;
  // The stream drops before the exit is told: that drop is the sign of the death.
  expect(events.some((event) => event.kind === "activity" && /the event stream failed|the server process exited/.test(event.detail ?? ""))).toBe(true);
  expect(await c.state(session)).toBe("unknown");
  await expect(c.send(session, "again")).rejects.toMatchObject({ code: "InputNotSent" });
});

test("event stream loss stops the old server before resume and cancels pending reverse requests", async () => {
  const c = control();
  const pending = Promise.withResolvers<AbortSignal>();
  const { session } = await c.start({
    prompt: promptFromText("permission"),
    cwd: cwd(),
    reverse: async (_, { signal }) => {
      pending.resolve(signal);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { cancelled: true };
    },
  });
  const signal = await pending.promise;
  const drained = (async () => {
    for await (const event of c.life(session)) void event;
  })();
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  await postToFake("close-stream");
  await drained;
  expect(signal.aborted).toBe(true);
  expect(await c.state(session)).toBe("unknown");
  await expect(c.send(session, "after stream loss")).rejects.toMatchObject({ code: "InputNotSent" });
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["permission"]);
  await c.resume(session, { cwd: cwd() });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await c.state(session)).toBe("idle");
});

test("a malformed admission reply leaves the prompt possibly sent until its turn ends", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  const ended = turnsEnded(c, session, 2);
  await expect(c.send(session, "bad admission")).rejects.toMatchObject({ code: "InputPossiblySent" });
  expect(await c.state(session)).toBe("running");
  expect(await c.send(session, "after malformed reply")).toMatchObject({ status: "queued" });
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["bad admission"]);
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  await ended;
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["bad admission", "after malformed reply"]);
});

test("a turn with no terminal event expires without sending the queue to an unconfirmed idle server", async () => {
  const c = control({ turnTimeoutMs: 300 });
  const { session } = await c.start({ prompt: promptFromText("hang"), cwd: cwd() });
  expect(await c.send(session, "queued send")).toMatchObject({ status: "queued" });
  const queued = c.ask(session, { prompt: promptFromText("queued ask"), schema: z.string() });
  await expect(queued).rejects.toThrow(/turn 1 did not report its end/);
  expect(await c.state(session)).toBe("unknown");
  expect((await promptsOf()).map(({ text }) => text)).toEqual(["hang"]);
});

test("dispose and close stop the children; nothing a control side started outlives it", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("hang"), cwd: cwd() });
  const pid = (await logOf("url.log"))[0]?.["pid"] as number;
  expect(() => process.kill(pid, 0)).not.toThrow();
  await c.dispose();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(c.start({ prompt: hello, cwd: cwd() })).rejects.toMatchObject({ code: "Unavailable" });

  const other = control();
  const second = await other.start({ prompt: promptFromText("hang"), cwd: cwd() });
  const secondPid = (await logOf("url.log"))[1]?.["pid"] as number;
  await other.close(second.session);
  expect(() => process.kill(secondPid, 0)).toThrow();
  expect(await other.state(second.session)).toBe("unknown");
});

test("a session not held is resumed in a process of its own, and one the server never knew is refused", async () => {
  const first = control();
  const { session } = await first.start({ prompt: promptFromText(""), cwd: cwd() });
  await first.dispose();

  const c = control();
  await c.resume(session, { cwd: cwd() });
  expect(spawns.length).toBe(2);
  expect((await logOf("requests.log")).some((frame) => frame["path"] === `/api/session/${session.native}`)).toBe(true);
  expect(await c.state(session)).toBe("idle");
  const ended = turnsEnded(c, session);
  await c.send(session, "hello");
  expect((await ended).find((event) => event.kind === "turn-ended")).toMatchObject({ outcome: "completed" });

  const nowhere = sessionId(harnessId("opencode-fake"), "ses_nowhere");
  await expect(c.resume(nowhere, { cwd: cwd() })).rejects.toMatchObject({ code: "Unavailable" });
  const pid = (await logOf("url.log")).at(-1)?.["pid"] as number;
  await Bun.sleep(150);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a resume of a held session goes on in its child; other servers take a new one", async () => {
  const c = control();
  const server = { name: "niwa", command: "niwa", args: [], env: {} };
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd(), servers: [server] });
  expect(spawns.length).toBe(1);
  // The same servers, or none named: the session keeps its child.
  await c.resume(session, { servers: [server] });
  await c.resume(session);
  expect(spawns.length).toBe(1);
  // Other servers: a new child, born with them.
  await c.resume(session, { servers: [server, { name: "extra", command: "extra", args: [], env: {} }] });
  expect(spawns.length).toBe(2);
  const config = spawns[1]?.env["OPENCODE_CONFIG_CONTENT"];
  expect(typeof config).toBe("string");
  expect(Object.keys((JSON.parse(String(config)) as { mcp: { servers: Record<string, unknown> } }).mcp.servers)).toEqual(["niwa", "extra"]);
  // A held session cannot take a box it was not born with.
  await expect(c.resume(session, { box: { sandbox: "srt", spec: { cwd: cwd() } } })).rejects.toMatchObject({ code: "Unsupported" });
  expect(await c.state(session)).toBe("idle");
});

test("a resume with a prompt waits behind a running turn, and resuming is one at a time", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText("slow"), cwd: cwd() });
  const ended = turnsEnded(c, session, 2);
  await c.resume(session, { prompt: promptFromText("after") });
  expect((await promptsOf()).map((body) => body.text)).toEqual(["slow"]);
  // Two resumes that both find the session held are one turn at it, not two.
  await Promise.all([c.resume(session), c.resume(session)]);
  expect(spawns.length).toBe(1);
  await push({ type: "session.execution.succeeded", data: { sessionID: session.native } });
  await ended;
  expect((await promptsOf()).map((body) => body.text)).toEqual(["slow", "after"]);
});

test("a life iterator follows the replacement server and can unsubscribe after the move", async () => {
  const c = control();
  const { session } = await c.start({ prompt: promptFromText(""), cwd: cwd() });
  const stream = c.life(session)[Symbol.asyncIterator]();
  const first = stream.next();
  await c.send(session, "before replacement");
  let sign = await first;
  while (!sign.done && sign.value.kind !== "turn-ended") sign = await stream.next();
  expect(sign.value).toMatchObject({ kind: "turn-ended", outcome: "completed" });

  await c.resume(session, { servers: [{ name: "extra", command: "extra", args: [], env: {} }] });
  const next = stream.next();
  await c.send(session, "after replacement");
  sign = await next;
  while (!sign.done && sign.value.kind !== "turn-ended") sign = await stream.next();
  expect(sign.value).toMatchObject({ kind: "turn-ended", outcome: "completed" });
  expect(await stream.return?.()).toMatchObject({ done: true });

  const following = turnsEnded(c, session);
  await c.send(session, "after unsubscribe");
  expect((await following).at(-1)).toMatchObject({ kind: "turn-ended", outcome: "completed" });
  expect(spawns.length).toBe(2);
});

test("opencode passes the control conformance suite", async () => {
  const id = harnessId("opencode-fake");
  const instance: Harness = {
    id,
    kind: harnessKind("opencode"),
    machine: machineId("machine-1"),
    home: dir,
    sides: {
      control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: OPENCODE_LAUNCH },
    },
  };
  const own = control();
  // The suite starts sessions with no directory of their own: the fake keeps its state in the
  // session's directory, which every control here works in.
  const suite = { ...own, start: (options: Parameters<OpenCodeSessionControl["start"]>[0]) => own.start({ cwd: cwd(), ...options }) };
  const report = await controlConformance("opencode", { instance, control: suite })();
  expect(report.results.filter((result) => !result.passed).map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(15);
});
