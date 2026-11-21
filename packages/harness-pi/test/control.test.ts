// The pi control side against a fake `pi --mode rpc`: what it refuses, and what it cleans up.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { InputNotSent, InputPossiblySent, Unavailable, Unsupported, modelName, promptFromText, type LifeEvent } from "@niwa-labs/harness";
import { PiControl } from "../src/control.ts";
import { tempDir } from "@niwa-labs/testing";

/**
 * A fake pi that names its session and refuses every prompt; it records its pid. With FAKE_OK it
 * takes a prompt and runs it at once; with FAKE_HOLD it takes a prompt, begins the run and never
 * ends it, and queues a follow-up.
 */
const FAKE = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_DIR + "/pid", String(process.pid));
writeFileSync(process.env.FAKE_DIR + "/args", process.argv.slice(2).join(" "));
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.type === "get_state") send({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: process.env.FAKE_SESSION ?? "s1", ...(process.env.FAKE_MODEL_ID ? { model: { id: process.env.FAKE_MODEL_ID, provider: process.env.FAKE_MODEL_PROVIDER } } : {}) } });
    else if (frame.type === "prompt" && process.env.FAKE_HOLD) {
      send({ type: "response", id: frame.id, command: "prompt", success: true });
      if (frame.streamingBehavior === undefined) send({ type: "agent_start" });
    } else if (frame.type === "prompt" && process.env.FAKE_SILENT) {
      // Taken and never answered.
    } else if (frame.type === "prompt" && process.env.FAKE_OK) {
      send({ type: "response", id: frame.id, command: "prompt", success: true });
      send({ type: "agent_start" });
      send({ type: "agent_end", messages: [], willRetry: false });
    } else send({ type: "response", id: frame.id, command: frame.type, success: false, error: "no model" });
  }
});
`;

let dir: string;

beforeEach(async () => {
  dir = await tempDir("pi-fake");
  await writeFile(join(dir, "pi"), FAKE);
  await chmod(join(dir, "pi"), 0o755);
  process.env.FAKE_DIR = dir;
});

afterEach(async () => {
  delete process.env.FAKE_DIR;
  delete process.env.FAKE_OK;
  delete process.env.FAKE_HOLD;
  delete process.env.FAKE_SILENT;
  delete process.env.FAKE_SESSION;
  delete process.env.FAKE_MODEL_ID;
  delete process.env.FAKE_MODEL_PROVIDER;
  await rm(dir, { recursive: true, force: true });
});

test("pi has only the full mode: ask and auto are refused naming it, before a process is started; with none chosen it starts in full", async () => {
  const bare = new PiControl({ harness: "pi-fake", binary: join(dir, "pi") });
  for (const mode of ["ask", "auto"] as const) {
    const failure = await bare.start({ prompt: promptFromText("go"), ...(mode === undefined ? {} : { mode }) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Unsupported);
    expect(String(failure)).toContain(`is not one of full`);
  }
  expect(await readFile(join(dir, "pid"), "utf8").catch(() => "none")).toBe("none");
  await bare.dispose();

  process.env.FAKE_HOLD = "1";
  const pi = new PiControl({ harness: "pi-fake", binary: join(dir, "pi") });
  expect((await pi.start({ prompt: promptFromText("go") })).mode).toBe("full");
  await pi.dispose();
});

test("a start whose first turn fails leaves no child behind", async () => {
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  const failure = await pi.start({ prompt: promptFromText("go") }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Unavailable);
  const pid = Number(await readFile(join(dir, "pid"), "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(50);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
  await pi.dispose();
});

test("the start returns once pi took the prompt: a first run that never ends does not block it", async () => {
  process.env.FAKE_HOLD = "1";
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  try {
    const { session: id, first } = await pi.start({ prompt: promptFromText("go") });
    expect(id.native).toBe("s1" as typeof id.native);
    // The prompt became the first turn, and the receipt names it.
    expect(first).toMatchObject({ status: "started", turn: 1 });
    // The first stream of life is given the start of that run, which began before it existed.
    const iterator = pi.life(id)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "turn-started", turn: 1 });
    void iterator.return?.();
    expect(await pi.state(id)).toBe("running");
    // The session takes messages at once: they wait behind the first run.
    expect(await pi.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  } finally {
    await pi.dispose();
  }
});

test("the turn that runs inside start is reported to the first stream of life", async () => {
  process.env.FAKE_OK = "1";
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  const { session: id } = await pi.start({ prompt: promptFromText("go") });
  const iterator = pi.life(id)[Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = await iterator.next();
  expect(first.value).toMatchObject({ kind: "turn-started", turn: 1 });
  expect(second.value).toMatchObject({ kind: "turn-ended", turn: 1 });
  await iterator.return?.();
  await pi.dispose();
});

for (const [named, accepted] of [
  ["s1", true],
  ["s2", false],
] as const) {
  test(`a resume where pi opens ${accepted ? "the session" : "another session"} is ${accepted ? "taken" : "refused"}`, async () => {
    process.env.FAKE_OK = "1";
    process.env.FAKE_SESSION = named;
    // The file of the session, where pi keeps the sessions of the working directory.
    const project = `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    await mkdir(join(dir, "sessions", project), { recursive: true });
    await writeFile(join(dir, "sessions", project, "2026-01-01_s1.jsonl"), "");
    const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), cwd: dir, home: dir });
    const id = { harness: "pi-fake", native: "s1" } as never;
    const failure = await pi.resume(id).then(() => undefined, (error: unknown) => error);
    if (accepted) {
      expect(failure).toBeUndefined();
      expect(await pi.state(id)).toBe("idle");
    } else {
      expect(failure).toBeInstanceOf(Unavailable);
      expect(String(failure)).toMatch(/not the session "s1"/);
      expect(await pi.state(id)).toBe("unknown");
    }
    await pi.dispose();
  });
}

/** The file of the session s1, where pi keeps the sessions of the working directory. */
async function sessionFile(): Promise<void> {
  const project = `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  await mkdir(join(dir, "sessions", project), { recursive: true });
  await writeFile(join(dir, "sessions", project, "2026-01-01_s1.jsonl"), "");
}

test("a session whose process died is not held: resume opens it again instead of reporting it resumed", async () => {
  process.env.FAKE_OK = "1";
  await sessionFile();
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), cwd: dir, home: dir });
  const { session: id } = await pi.start({ prompt: promptFromText("go") });
  const firstPid = Number(await readFile(join(dir, "pid"), "utf8"));
  process.kill(firstPid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && (await pi.state(id)) !== "unknown"; attempt += 1) await Bun.sleep(50);
  expect(await pi.state(id)).toBe("unknown");

  await pi.resume(id);
  expect(await pi.state(id)).toBe("idle");
  expect(Number(await readFile(join(dir, "pid"), "utf8"))).not.toBe(firstPid);
  await pi.dispose();
});

test("the model pi says it runs is a sign of life, as `--model` takes it, and a resume starts pi on exactly that model", async () => {
  process.env.FAKE_OK = "1";
  process.env.FAKE_MODEL_ID = "claude-real";
  process.env.FAKE_MODEL_PROVIDER = "anthropic";
  await sessionFile();
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), cwd: dir, home: dir, model: "haiku" });
  const { session: id } = await pi.start({ prompt: promptFromText("go"), model: "sonnet" });
  expect(await readFile(join(dir, "args"), "utf8")).toContain("--model sonnet");
  // The alias went to pi; what pi says it runs comes back with the state it names its session in.
  const first = (await pi.life(id)[Symbol.asyncIterator]().next()).value;
  expect(first).toEqual({ kind: "model", model: modelName("anthropic/claude-real") });

  const firstPid = Number(await readFile(join(dir, "pid"), "utf8"));
  process.kill(firstPid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && (await pi.state(id)) !== "unknown"; attempt += 1) await Bun.sleep(50);
  await pi.resume(id, { model: modelName("anthropic/claude-real") });
  // The instance's own model is not what the resumed session runs on: the one pi named is.
  expect(await readFile(join(dir, "args"), "utf8")).toContain("--model anthropic/claude-real");
  expect(await readFile(join(dir, "args"), "utf8")).not.toContain("haiku");
  await pi.dispose();
});

test("a pi that names no model names none, and a model with no provider is its id", async () => {
  process.env.FAKE_OK = "1";
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  const { session: id } = await pi.start({ prompt: promptFromText("go") });
  const events: LifeEvent[] = [];
  for await (const event of pi.life(id)) {
    events.push(event);
    if (event.kind === "turn-ended") break;
  }
  expect(events.filter((event) => event.kind === "model")).toEqual([]);
  await pi.dispose();

  process.env.FAKE_MODEL_ID = "bare-model";
  const bare = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  const { session: other } = await bare.start({ prompt: promptFromText("go") });
  expect((await bare.life(other)[Symbol.asyncIterator]().next()).value).toEqual({ kind: "model", model: modelName("bare-model") });
  await bare.dispose();
});

test("a refused resume leaves nothing held under the other session it opened", async () => {
  process.env.FAKE_OK = "1";
  process.env.FAKE_SESSION = "s2";
  await sessionFile();
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), cwd: dir, home: dir });
  const refused = await pi.resume({ harness: "pi-fake", native: "s1" } as never).then(() => undefined, (error: unknown) => error);
  expect(refused).toBeInstanceOf(Unavailable);
  // s2 has no file here: a resume of it must say so, not take a dead process for a held session.
  const again = await pi.resume({ harness: "pi-fake", native: "s2" } as never).then(() => undefined, (error: unknown) => error);
  expect(again).toBeInstanceOf(Unavailable);
  expect(String(again)).toMatch(/has no file/);
  await pi.dispose();
});

test("a model is pi's --model and an effort is its --thinking, of that session; a level pi does not have is refused before a process is started", async () => {
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi") });
  try {
    await pi.start({ prompt: promptFromText(""), model: "openai/gpt-4o", effort: "high" });
    expect(await readFile(join(dir, "args"), "utf8")).toBe("--mode rpc --model openai/gpt-4o --thinking high");
    await rm(join(dir, "args"));

    const failure = await pi.start({ prompt: promptFromText(""), effort: "extreme" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Unsupported);
    expect(String(failure)).toContain('effort "extreme" is not one of off, minimal, low, medium, high, xhigh, max');
    expect(await readFile(join(dir, "args"), "utf8").catch(() => "none")).toBe("none");
  } finally {
    await pi.dispose();
  }
});

test("a message pi refuses was not sent; one it never answers may have been, and neither is sent again", async () => {
  const pi = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), callTimeoutMs: 200 });
  try {
    const { session } = await pi.start({ prompt: promptFromText("") });
    await expect(pi.send(session, "go")).rejects.toBeInstanceOf(InputNotSent);
    await expect(pi.send({ ...session, native: "elsewhere" as never }, "go")).rejects.toBeInstanceOf(InputNotSent);
    process.env.FAKE_SILENT = "1";
    const silent = new PiControl({ mode: "full", harness: "pi-fake", binary: join(dir, "pi"), callTimeoutMs: 200 });
    try {
      const quiet = await silent.start({ prompt: promptFromText("") });
      await expect(silent.send(quiet.session, "go")).rejects.toBeInstanceOf(InputPossiblySent);
    } finally {
      await silent.dispose();
    }
  } finally {
    await pi.dispose();
  }
});
