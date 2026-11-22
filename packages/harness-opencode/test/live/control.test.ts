// The OpenCode control side and reading side, live.
//
// A real `opencode serve --stdio` v2 server is started per session and given tiny turns through a
// local OpenAI-compatible proxy: a start whose answer is asked back by schema, a send whose signs
// of life are watched to the end of its turn, an interrupt that cuts a working turn, a permission
// round-trip for a shell command in `auto` mode, and the reading side reading the closed session
// back from the server's own storage.
//
// The tests are skipped unless NIWA_LIVE=1 and the binary is known and reports a v2 version.
// NIWA_OPENCODE_BINARY selects an explicit v2 executable when the default on PATH is another
// version. NIWA_OPENCODE_MODEL selects the provider and model for these tests.
//
// The run is isolated from the owner's own OpenCode state: the installation home is a fresh temp
// directory ending in `opencode`, which the server's `$XDG_DATA_HOME` root becomes, and every
// session is born with OPENCODE_CONFIG_CONTENT naming the local provider. No MCP servers are
// given, so the control side never rewrites that variable with its own config document.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { optionOfFlavor } from "@niwa-labs/core";
import { harnessId, promptFromText } from "@niwa-labs/harness";
import type { LifeEvent, ReverseHandler, SessionId, SessionInfo, SessionRecord } from "@niwa-labs/harness";
import { live, tempDir } from "@niwa-labs/testing";

import { opencodeControl } from "../../src/control.ts";
import type { OpenCodeSessionControl } from "../../src/control.ts";
import { OpenCodeReading } from "../../src/reading.ts";

const BINARY = process.env["NIWA_OPENCODE_BINARY"] ?? Bun.which("opencode") ?? undefined;
const MODEL = process.env["NIWA_OPENCODE_MODEL"] ?? "bifrost/glm-5.3-flash";
const HARNESS = harnessId("opencode-live");

/** How long one call to the server waits for its answer. */
const CALL_TIMEOUT_MS = 60_000;
/** How long one turn may take before the proof gives up on it. */
const TURN_TIMEOUT_MS = 240_000;
/** How long the interrupt proof may take, so a hung interrupt fails fast. */
const INTERRUPT_DEADLINE_MS = 60_000;

/** The major of the version the binary reports, when it says one. */
function majorOf(binary: string): number | undefined {
  try {
    const run = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
    const major = Number.parseInt(/v?(\d+)/.exec(new TextDecoder().decode(run.stdout).trim())?.[1] ?? "", 10);
    return Number.isInteger(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

const MAJOR = BINARY === undefined ? undefined : majorOf(BINARY);
const RUNS = live && BINARY !== undefined && MAJOR === 2;

/** The provider every session is born with: the local proxy, as a config document. */
const PROVIDER_CONFIG = JSON.stringify({
  providers: {
    bifrost: {
      name: "Bifrost (local)",
      package: "@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:10081/v1", apiKey: "bifrost-stub" },
      models: { "glm-5.3-flash": { name: "GLM 5.3 Flash", limit: { context: 200000, output: 8192 } } },
    },
  },
});

/** The environment of every session: the local provider, and clean output. */
function sessionEnv(): Record<string, string> {
  return { OPENCODE_CONFIG_CONTENT: PROVIDER_CONFIG, NO_COLOR: "1" };
}

let root = "";
let home = "";
const controls: OpenCodeSessionControl[] = [];
/** The session the send proof closed, which the reading proof reads back. */
let readBack: SessionId | undefined;

beforeAll(async () => {
  if (!RUNS) return;
  root = await tempDir("opencode-live");
  home = join(root, "opencode");
});

afterAll(async () => {
  for (const control of controls.splice(0)) await control.dispose();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

/** A control side pinned to the temp home, the v2 binary and the local model. */
function control(): OpenCodeSessionControl {
  const made = opencodeControl({
    harness: HARNESS,
    ...(BINARY === undefined ? {} : { binary: BINARY }),
    home,
    model: MODEL,
    callTimeoutMs: CALL_TIMEOUT_MS,
    turnTimeoutMs: TURN_TIMEOUT_MS,
  });
  controls.push(made);
  return made;
}

/** A fresh working directory under the temp root. */
async function work(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Collect the signs of life of a session, without blocking the test on them. */
function watchLife(side: OpenCodeSessionControl, id: SessionId): { events: LifeEvent[]; stop: () => void } {
  const events: LifeEvent[] = [];
  const iterator = side.life(id)[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      events.push(next.value);
    }
  })();
  return { events, stop: () => void iterator.return?.() };
}

/** Wait until the condition holds; the failure names what was waited for. */
async function until(holds: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await holds()) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms`);
    await Bun.sleep(100);
  }
}

/** Whether a turn of the signs of life ended. */
function ended(events: readonly LifeEvent[], turn: number | undefined): boolean {
  return events.some((event) => event.kind === "turn-ended" && event.turn === turn);
}

test.skipIf(!RUNS)(
  "a real OpenCode session starts and answers by schema through the local proxy",
  async () => {
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText("Reply with the single word ok."),
        cwd: await work("ask"),
        mode: "full",
        env: sessionEnv(),
      });
      expect(started.first?.status).toBe("started");
      const answer = await side.ask(started.session, {
        schema: z.object({ ok: z.literal(true) }),
        prompt: promptFromText('Reply with exactly the JSON {"ok": true} and nothing else.'),
      });
      expect(answer.value).toEqual({ ok: true });
      expect(answer.session.native).toBe(started.session.native);
    } finally {
      await side.dispose();
    }
  },
  TURN_TIMEOUT_MS * 2,
);

test.skipIf(!RUNS)(
  "a message starts a turn whose signs of life are watched to its end, and the closed session is gone",
  async () => {
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText(""),
        cwd: await work("life"),
        mode: "full",
        env: sessionEnv(),
      });
      const watched = watchLife(side, started.session);
      const receipt = await side.send(started.session, "Say OK");
      expect(receipt.status).toBe("started");
      await until(() => ended(watched.events, receipt.turn), TURN_TIMEOUT_MS, "the turn did not end");
      expect(watched.events.some((event) => event.kind === "turn-started" && event.turn === receipt.turn)).toBe(true);
      // The model was pinned at the create, so no model sign is asked for: what a pinned session
      // shows is its steps.
      expect(watched.events.some((event) => event.kind === "activity")).toBe(true);
      const end = watched.events.find((event): event is Extract<LifeEvent, { kind: "turn-ended" }> => event.kind === "turn-ended" && event.turn === receipt.turn);
      expect(end?.outcome).toBe("completed");
      expect(await side.state(started.session)).toBe("idle");
      watched.stop();
      await side.close(started.session);
      // The child is gone: a closed session proves nothing about now.
      expect(await side.state(started.session)).toBe("unknown");
      readBack = started.session;
    } finally {
      await side.dispose();
    }
  },
  TURN_TIMEOUT_MS,
);

test.skipIf(!RUNS)(
  "an interrupt cuts a working turn and the session comes back to idle",
  async () => {
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText(""),
        cwd: await work("interrupt"),
        mode: "full",
        env: sessionEnv(),
      });
      const watched = watchLife(side, started.session);
      const receipt = await side.send(started.session, "Count from 1 to 100 slowly, one number per line.");
      expect(receipt.status).toBe("started");
      await until(() => watched.events.some((event) => event.kind === "activity"), INTERRUPT_DEADLINE_MS, "the turn showed no activity");
      await side.interrupt(started.session);
      await until(() => ended(watched.events, receipt.turn), INTERRUPT_DEADLINE_MS, "the interrupted turn did not end");
      await until(async () => (await side.state(started.session)) === "idle", INTERRUPT_DEADLINE_MS, "the session did not come back to idle");
      watched.stop();
    } finally {
      await side.dispose();
    }
  },
  TURN_TIMEOUT_MS,
);

test.skipIf(!RUNS)(
  "a session in auto mode asks about a shell command without a saved approval",
  async () => {
    const asked: string[] = [];
    const allowOnce: ReverseHandler = async (_session, request) => {
      asked.push(request.question.title);
      const allow = optionOfFlavor(request.question, "allow_once");
      return allow === undefined ? { cancelled: true } : { ids: [allow.id] };
    };
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText("Run the shell command `echo hello` in the current directory."),
        cwd: await work("permission"),
        mode: "auto",
        env: sessionEnv(),
        reverse: allowOnce,
      });
      const watched = watchLife(side, started.session);
      await until(() => ended(watched.events, started.first?.turn), TURN_TIMEOUT_MS, "the turn did not end");
      watched.stop();
      expect(asked).toContain("shell");
      expect(watched.events).toContainEqual(expect.objectContaining({ kind: "activity", tool: "shell", detail: "the tool shell succeeded" }));
      const end = watched.events.find((event): event is Extract<LifeEvent, { kind: "turn-ended" }> => event.kind === "turn-ended" && event.turn === started.first?.turn);
      expect(end?.outcome).toBe("completed");
    } finally {
      await side.dispose();
    }
  },
  TURN_TIMEOUT_MS * 2,
);

test.skipIf(!RUNS)(
  "the reading side lists and reads the closed session back from the server's own storage",
  async () => {
    if (readBack === undefined) throw new Error("the session of the send proof was never closed");
    const id: SessionId = readBack;
    const reading = new OpenCodeReading({
      harness: HARNESS,
      home,
    });
    const listed: SessionInfo[] = [];
    for await (const session of reading.list()) listed.push(session);
    expect(listed.some((session) => session.id.native === id.native)).toBe(true);
    const records: SessionRecord[] = [];
    for await (const record of reading.read(id)) records.push(record);
    expect(records.some((record) => record.kind === "user" && record.text.includes("Say OK"))).toBe(true);
    expect(records.some((record) => record.kind === "assistant" && record.text.includes("OK"))).toBe(true);
    expect(records.every((record) => !record.incomplete)).toBe(true);
  },
  120_000,
);

test.skipIf(!RUNS)(
  "a closed session is resumed in a new process and answers one more message",
  async () => {
    if (readBack === undefined) throw new Error("the session of the send proof was never closed");
    const id: SessionId = readBack;
    const side = control();
    try {
      // The resumed process is born with the provider config too: the session keeps its model
      // server-side, but the new child knows the provider only through its environment.
      await side.resume(id, { prompt: promptFromText("Say YES"), cwd: await work("resume"), env: sessionEnv() });
      // The signs before the first watcher are kept for it, so a turn that already ended is still seen.
      const watched = watchLife(side, id);
      await until(() => watched.events.some((event) => event.kind === "turn-ended"), TURN_TIMEOUT_MS, "the resumed turn did not end");
      watched.stop();
      const end = watched.events.find((event): event is Extract<LifeEvent, { kind: "turn-ended" }> => event.kind === "turn-ended");
      expect(end?.outcome).toBe("completed");
      expect(await side.state(id)).toBe("idle");
      await side.close(id);
    } finally {
      await side.dispose();
    }
  },
  TURN_TIMEOUT_MS,
);
