// The pi control side against a scripted `pi --mode rpc`: how it holds the processes it starts, what
// it writes into them, and how it reads what a prompt became.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InputNotSent, InputPossiblySent, Unavailable, Unsupported, promptFromText, sessionId } from "@niwa-labs/harness";
import type { HarnessId, LifeEvent, SessionId } from "@niwa-labs/harness";
import { PiControl, piToolFlags, piToolsModeFlags } from "../src/control.ts";
import { eventually, tempDir } from "@niwa-labs/testing";

/**
 * A scripted pi. It logs each spawn (`spawns.log`: pid, arguments, working directory and the
 * environment niwa gave it) and each prompt it reads (`prompts.log`). FAKE_PROMPT is what it does with
 * a prompt: `started` (the default) takes it and runs it to its end, `hold` takes it and never ends
 * the run, `handled` takes it as a command of an extension, `strange` answers with a disposition no
 * pi has, `busy` refuses a bare prompt as a working pi does and queues one that says how.
 * FAKE_FLOOD makes it write a line that never ends after it has named its session.
 */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const dir = process.env.FAKE_DIR;
appendFileSync(dir + "/spawns.log", JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  session: process.env.NIWA_SESSION ?? null,
  instance: process.env.NIWA_PI_INSTANCE ?? null,
}) + "\\n");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const mode = process.env.FAKE_PROMPT ?? "started";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (frame.type === "get_state") {
      send({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: process.env.FAKE_SESSION ?? "s1" } });
      if (process.env.FAKE_FLOOD) for (let i = 0; i < 17; i += 1) process.stdout.write("x".repeat(1024 * 1024));
    } else if (frame.type === "prompt") {
      appendFileSync(dir + "/prompts.log", JSON.stringify(frame) + "\\n");
      const answer = (disposition) => send({ type: "response", id: frame.id, command: "prompt", success: true, data: { disposition } });
      if (mode === "handled") answer("handled");
      else if (mode === "strange") answer("already processing");
      else if (mode === "busy") {
        if (frame.streamingBehavior === undefined) send({ type: "response", id: frame.id, command: "prompt", success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
        else answer("queued");
      } else if (mode === "hold") {
        answer(frame.streamingBehavior === undefined ? "started" : "queued");
        if (frame.streamingBehavior === undefined) send({ type: "agent_start" });
      } else {
        answer("started");
        send({ type: "agent_start" });
        send({ type: "agent_end", messages: [], willRetry: false });
      }
    }
  }
});
`;

let dir: string;
const controls: PiControl[] = [];

beforeEach(async () => {
  dir = await tempDir("pi-session");
  await writeFile(join(dir, "pi"), FAKE);
  await chmod(join(dir, "pi"), 0o755);
  process.env.FAKE_DIR = dir;
});

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.dispose()));
  for (const name of ["FAKE_DIR", "FAKE_PROMPT", "FAKE_SESSION", "FAKE_FLOOD"]) delete process.env[name];
  await rm(dir, { recursive: true, force: true });
});

const HARNESS = "pi-fake";

function side(options: Partial<ConstructorParameters<typeof PiControl>[0]> = {}): PiControl {
  const control = new PiControl({ mode: "full", harness: HARNESS, binary: join(dir, "pi"), ...options });
  controls.push(control);
  return control;
}

const idOf = (native: string): SessionId => sessionId(HARNESS as HarnessId, native);

interface Spawn {
  readonly pid: number;
  readonly args: string[];
  readonly cwd: string;
  readonly session: string | null;
  readonly instance: string | null;
}

async function logged<T>(name: string): Promise<T[]> {
  const text = await readFile(join(dir, name), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as T);
}

const spawns = (): Promise<Spawn[]> => logged<Spawn>("spawns.log");
const prompts = (): Promise<Array<{ message: string; streamingBehavior?: string }>> => logged("prompts.log");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function dies(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

/** The file pi keeps a session of the working directory `cwd` in. */
async function sessionFile(native: string, cwd: string): Promise<void> {
  const project = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  await mkdir(join(dir, "sessions", project), { recursive: true });
  await writeFile(join(dir, "sessions", project, `2026-01-01_${native}.jsonl`), "");
}

// -- the tools ----------------------------------------------------------------

test("an allow-list reaches pi as exactly the names given, with its MCP tools switched off", () => {
  expect(piToolFlags(HARNESS as HarnessId, "start", ["read", "grep"])).toEqual(["--tools", "read,grep", "--no-mcp"]);
  expect(piToolFlags(HARNESS as HarnessId, "start", [])).toEqual(["--no-tools"]);
  expect(piToolsModeFlags(HARNESS as HarnessId, "start", "all")).toEqual([]);
  expect(piToolsModeFlags(HARNESS as HarnessId, "start", undefined)).toEqual([]);
});

test("a name pi would read as a pattern, or niwa's tools alone, is refused before a process is started", async () => {
  const pi = side();
  const patterns = ["*", "re*", "+read", "-write", "read,bash", "read bash", "mcp__radius__x", "", " read"];
  for (const name of patterns) {
    const refusal = await pi.start({ prompt: promptFromText("go"), tools: { allow: [name] } }).catch((error: unknown) => error);
    expect(refusal, name).toBeInstanceOf(Unsupported);
    expect(String(refusal)).toContain("start");
  }
  const alone = await pi.start({ prompt: promptFromText("go"), tools: "niwa-only" }).catch((error: unknown) => error);
  expect(alone).toBeInstanceOf(Unsupported);
  // A cold resume is refused for the same reason before its file is looked for.
  const resumed = await pi.resume(idOf("s1"), { tools: "niwa-only" }).catch((error: unknown) => error);
  expect(resumed).toBeInstanceOf(Unsupported);
  expect(await spawns()).toEqual([]);
});

// -- what a prompt became ------------------------------------------------------

test("an answer that is no refusal is never read as one: the prompt is written once, and it may have been taken", async () => {
  process.env.FAKE_PROMPT = "strange";
  const pi = side({ callTimeoutMs: 2_000 });
  const { session } = await pi.start({ prompt: promptFromText("") });
  const failure = await pi.send(session, "go").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(InputPossiblySent);
  expect(await prompts()).toHaveLength(1);
});

test("a prompt pi refuses because it is working is queued the way the caller asked, once", async () => {
  process.env.FAKE_PROMPT = "busy";
  const pi = side({ callTimeoutMs: 2_000 });
  const { session } = await pi.start({ prompt: promptFromText("") });
  // The side has not seen a run: pi refuses the bare prompt, and the retry steers into the turn.
  const receipt = await pi.send(session, "now", { into: "turn" });
  expect(receipt).toMatchObject({ status: "delivered" });
  expect((await prompts()).map((prompt) => prompt.streamingBehavior)).toEqual([undefined, "steer"]);

  const queued = await pi.send(session, "later");
  expect(queued).toMatchObject({ status: "queued" });
  expect((await prompts()).map((prompt) => prompt.streamingBehavior)).toEqual([undefined, "steer", undefined, "followUp"]);
});

test("a message an extension handled starts no turn and is receipted as handled with no turn named", async () => {
  process.env.FAKE_PROMPT = "handled";
  const pi = side({ callTimeoutMs: 2_000 });
  const { session, first } = await pi.start({ prompt: promptFromText("/command") });
  expect(first).toMatchObject({ status: "handled" });
  expect(first?.turn).toBeUndefined();
  const receipt = await pi.send(session, "/command again");
  expect(receipt.status).toBe("handled");
  expect(receipt.turn).toBeUndefined();
  expect(await pi.state(session)).toBe("idle");
});

test("a resume whose prompt an extension handled returns at once and leaves the process running", async () => {
  process.env.FAKE_PROMPT = "handled";
  await sessionFile("s1", dir);
  const pi = side({ cwd: dir, home: dir, turnTimeoutMs: 1_500, callTimeoutMs: 2_000 });
  const began = Date.now();
  await pi.resume(idOf("s1"), { prompt: promptFromText("/command") });
  expect(Date.now() - began).toBeLessThan(1_000);
  expect(await pi.state(idOf("s1"))).toBe("idle");
  expect(alive((await spawns())[0]!.pid)).toBe(true);
});

// -- the processes --------------------------------------------------------------

test("a cold resume looks for the file where the caller says the session was started", async () => {
  const elsewhere = join(dir, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await sessionFile("s1", elsewhere);
  const pi = side({ cwd: dir, home: dir });
  await pi.resume(idOf("s1"), { cwd: elsewhere });
  const [spawn] = await spawns();
  expect(spawn?.args).toContain("--session");
  expect(await pi.state(idOf("s1"))).toBe("idle");
  // Without the directory it was started in, the file is not where the side looks.
  const lost = await side({ cwd: dir, home: dir }).resume(idOf("s1")).catch((error: unknown) => error);
  expect(lost).toBeInstanceOf(Unavailable);
});

test("two resumes of one session at once share one process", async () => {
  await sessionFile("s1", dir);
  const pi = side({ cwd: dir, home: dir });
  await Promise.all([pi.resume(idOf("s1")), pi.resume(idOf("s1")), pi.resume(idOf("s1"))]);
  expect(await spawns()).toHaveLength(1);
  expect(await pi.state(idOf("s1"))).toBe("idle");
});

test("a resume that finds pi on another session than the one asked for does not take the id of a live one", async () => {
  process.env.FAKE_SESSION = "s2";
  const pi = side({ cwd: dir, home: dir });
  const { session } = await pi.start({ prompt: promptFromText("") });
  expect(session.native).toBe("s2" as typeof session.native);
  await sessionFile("s1", dir);
  const refused = await pi.resume(idOf("s1")).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Unavailable);
  // The live session of that id is still the one that is held, and still answers.
  expect(await pi.state(session)).toBe("idle");
  await pi.send(session, "still here");
  expect(await prompts()).toHaveLength(1);
});

test("a dispose while a process is being started leaves no process behind", async () => {
  const pi = side();
  const starting = pi.start({ prompt: promptFromText("go") }).catch((error: unknown) => error);
  await pi.dispose();
  expect(await starting).toBeInstanceOf(Unavailable);
  // A process that began to run before it was stopped is gone; one that was stopped first never ran.
  await Bun.sleep(500);
  for (const spawn of await spawns()) expect(await dies(spawn.pid)).toBe(true);
});

test("a disposed side resumes nothing", async () => {
  await sessionFile("s1", dir);
  const pi = side({ cwd: dir, home: dir });
  await pi.dispose();
  const refused = await pi.resume(idOf("s1")).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Unavailable);
  expect(await spawns()).toEqual([]);
});

test("every process is told it is niwa's, and which installation it belongs to, when started and when resumed", async () => {
  await sessionFile("s1", dir);
  const pi = side({ cwd: dir, home: dir });
  const { session } = await pi.start({ prompt: promptFromText("") });
  await pi.stop(session);
  await pi.resume(idOf("s1"));
  const [started, resumed] = await spawns();
  expect(started).toMatchObject({ session: "1", instance: HARNESS });
  expect(resumed).toMatchObject({ session: "1", instance: HARNESS });
});

test("a line of the wire that never ends loses the session and ends its process", async () => {
  process.env.FAKE_FLOOD = "1";
  const pi = side({ stopGraceMs: 500 });
  const { session } = await pi.start({ prompt: promptFromText("") });
  const [spawn] = await spawns();
  await eventually(async () => (await pi.state(session)) === "unknown");
  expect(await dies(spawn!.pid)).toBe(true);
  // The session is lost, and a send says so before anything is written.
  await expect(pi.send(session, "go")).rejects.toBeInstanceOf(InputNotSent);
});

test("the life of a session that sent a line without end is over", async () => {
  process.env.FAKE_FLOOD = "1";
  const pi = side({ stopGraceMs: 500 });
  const { session } = await pi.start({ prompt: promptFromText("") });
  const events: LifeEvent[] = [];
  for await (const event of pi.life(session)) events.push(event);
  expect(events.filter((event) => event.kind === "turn-started")).toEqual([]);
});

test("closing one idle session stops its process and leaves the other session's alone", async () => {
  const pi = side();
  process.env.FAKE_SESSION = "s1";
  const first = await pi.start({ prompt: promptFromText("") });
  process.env.FAKE_SESSION = "s2";
  const second = await pi.start({ prompt: promptFromText("") });
  const [one, two] = await spawns();
  expect(one && two).toBeTruthy();
  // The contract's release, as the host calls it on a session that is ended.
  await pi.close(first.session);
  expect(await dies(one!.pid)).toBe(true);
  expect(alive(two!.pid)).toBe(true);
  expect(await pi.state(first.session)).toBe("unknown");
  expect(await pi.state(second.session)).toBe("idle");
});
