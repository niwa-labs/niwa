/**
 * The identity of a session.
 *
 * "Start a session. Until the harness names it there is only a step in progress. After that its
 * identity is the harness id plus the harness's id, and it resumes by that id."
 *
 * The check drives the real control sides of the mcode and claude-code kinds against fake ACP
 * processes. The fake does not answer `session/new` until the test opens a gate, so the state
 * before the name is a state that can be seen:
 *
 *   1. while the harness has not named the session, the journal holds the step in progress and
 *      no "session.started": there is no identity yet;
 *   2. after the name, "session.started" carries the harness id and the id the harness gave;
 *   3. the session is resumed by that id: the harness is asked to load exactly that id.
 */

import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, machineId, sessionId } from "@niwa-labs/harness";
import type { ControlCapabilities, Harness, HarnessKind, SessionControl } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";
import { z } from "zod";

import { claudeCode, claudeCodeSides } from "@niwa-labs/harness-claude";
import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import { tempDir } from "@niwa-labs/testing";

/** The id the fake harness gives to the session it names. */
const NATIVE = "native-7";

/** What a test has to release when it is over. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A fake ACP agent. It answers the handshake at once, but names a new session only after the
 * file `@GATE@` exists. `@SESSION_NEW_RESULT@` is what the kind's own agent says in that answer.
 */
const FAKE_ACP = `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const log = "@LOG@";
const gate = "@GATE@";
const stop = "@STOP@";
const out = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
setInterval(() => { if (existsSync(stop)) { appendFileSync(log, "stopped\\n"); process.exit(0); } }, 25);
let waiting = null;
setInterval(() => {
  if (waiting !== null && existsSync(gate)) {
    out({ id: waiting, result: @SESSION_NEW_RESULT@ });
    waiting = null;
  }
}, 25);
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    appendFileSync(log, JSON.stringify(frame) + "\\n");
    if (frame.method === "initialize") {
      out({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    } else if (frame.method === "session/new") {
      waiting = frame.id;
    } else if (frame.method === "session/load") {
      out({ id: frame.id, result: @SESSION_LOAD_RESULT@ });
    } else if (frame.method === "session/set_config_option" || frame.method === "session/set_model" || frame.method === "session/set_mode") {
      out({ id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      out({ method: "session/update", params: { sessionId: "${NATIVE}", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      out({ id: frame.id, result: { stopReason: "end_turn" } });
    }
  }
}
`;

const MCODE_OPTIONS =
  '{ sessionId: "' + NATIVE + '", configOptions: [{ id: "model", options: [{ value: "m:x:y:u", name: "y" }] }] }';
const CLAUDE_NEW = `{ sessionId: "${NATIVE}", modes: { currentModeId: "default", availableModes: [] }, models: { currentModelId: "default", availableModels: [] }, configOptions: [] }`;

interface Fake {
  readonly dir: string;
  readonly path: string;
  readonly log: string;
  readonly gate: string;
  readonly stop: string;
}

async function fakeAgent(newResult: string, loadResult: string): Promise<Fake> {
  const dir = await tempDir("h4");
  const fake: Fake = {
    dir,
    path: join(dir, "fake-harness"),
    log: join(dir, "frames.log"),
    gate: join(dir, "gate"),
    stop: join(dir, "stop"),
  };
  const script = FAKE_ACP.replaceAll("@LOG@", fake.log)
    .replaceAll("@GATE@", fake.gate)
    .replaceAll("@STOP@", fake.stop)
    .replace("@SESSION_NEW_RESULT@", newResult)
    .replace("@SESSION_LOAD_RESULT@", loadResult);
  await writeFile(fake.path, script);
  await chmod(fake.path, 0o755);
  return fake;
}

async function framesOf(log: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out: ${what}`);
}

function installation(kind: HarnessKind, control: ControlCapabilities, id: ReturnType<typeof harnessId>, home: string): Harness {
  return {
    id,
    kind,
    machine: machineId("machine-1"),
    home,
    sides: { reading: { list: true, read: true, watch: false }, control },
  };
}

/** The record that starts the session, and the one the starter writes when it has the name. */
const Begin = record("h4.begin", z.object({ harness: z.string() }));
const Began = record("h4.began", z.object({ session: z.string() }));

/** A starter: its handler starts a session as a step, so there is a step in progress. */
const starter = plugin("h4-starter", (api) => {
  api.declare(Begin, Began);
  api.on(Begin, async (data, step) => {
    const started = await step<unknown, { session: string }>(actionName("session.start"), {
      harness: data.harness,
      prompt: "hello",
    });
    await step.emit(Began, { session: started.session });
  });
});

interface Case {
  readonly name: string;
  readonly newResult: string;
  readonly loadResult: string;
  readonly build: (fake: Fake, id: ReturnType<typeof harnessId>) => { kind: HarnessKind; control: SessionControl | undefined; capabilities: ControlCapabilities };
}

const CASES: Case[] = [
  {
    name: "mcode",
    newResult: MCODE_OPTIONS,
    loadResult: MCODE_OPTIONS,
    build: (fake, id) => {
      const kind = mcode({ harness: id, home: fake.dir, control: { mode: "full", binary: fake.path, permissions: "deny" } });
      return { kind: kind.kind, control: kind.control, capabilities: mcodeSides.control as ControlCapabilities };
    },
  },
  {
    name: "claude-code",
    newResult: CLAUDE_NEW,
    loadResult: `{ sessionId: "${NATIVE}" }`,
    build: (fake, id) => {
      const kind = claudeCode({ harness: id, home: fake.dir, control: { command: [fake.path], permissions: "deny" } });
      return { kind: kind.kind, control: kind.control, capabilities: claudeCodeSides.control as ControlCapabilities };
    },
  },
];

for (const scenario of CASES) {
  test(`${scenario.name}: no identity until the harness names the session, then harness id plus its id, and resume by it`, async () => {
    const fake = await fakeAgent(scenario.newResult, scenario.loadResult);
    const id = harnessId(`${scenario.name}-h4`);
    const built = scenario.build(fake, id);
    const control = built.control;
    if (control === undefined) throw new Error("the kind has no control side");

    const niwa: Host = createNiwa({ home: join(fake.dir, "home") });
    niwa.use(starter);
    niwa.use(sessions({ harnesses: [{ instance: installation(built.kind, built.capabilities, id, fake.dir), control }] }));
    await niwa.serve();
    const records: StoredRecord[] = [];
    void (async () => {
      for await (const record of niwa.records.since(seq(0))) records.push(record);
    })().catch(() => {});
    cleanups.push(async () => {
      await writeFile(fake.stop, "");
      await eventually(async () => (await readFile(fake.log, "utf8").catch(() => "stopped")).includes("stopped"), "fake stop").catch(() => {});
      await niwa.close();
      if ("dispose" in control && typeof control.dispose === "function") await control.dispose();
      await rm(fake.dir, { recursive: true, force: true });
    });

    // 1. The start is in progress: the harness got `session/new` and has not answered.
    await niwa.emit(Begin, { harness: id });
    await eventually(
      async () => (await framesOf(fake.log)).some((frame) => frame.method === "session/new"),
      "the harness asked to name a session",
    );
    await Bun.sleep(300);
    // The journal holds the intent of the step and nothing that names a session.
    const intents = records.filter((record) => record.type === "niwa.step.intent");
    expect(intents.map((record) => (record.data as { action: string }).action)).toEqual(["session.start"]);
    expect(records.some((record) => record.type === "session.started")).toBe(false);
    expect(records.some((record) => record.type === "h4.began")).toBe(false);
    expect(JSON.stringify(records.map((record) => record.data))).not.toContain(NATIVE);

    // 2. The harness names the session: only now is there a session, with its identity.
    await writeFile(fake.gate, "");
    await eventually(() => records.some((record) => record.type === "session.started"), "session.started");
    const named = records.find((record) => record.type === "session.started");
    expect(named?.data).toMatchObject({ session: `${id} ${NATIVE}` });

    // 3. After a restart nothing of the session lives in the control side. It is resumed by the
    // identity the journal holds, and the harness is asked to load exactly the id it gave.
    const restarted = scenario.build(fake, id).control;
    if (restarted === undefined) throw new Error("the kind has no control side");
    cleanups.push(async () => {
      if ("dispose" in restarted && typeof restarted.dispose === "function") await restarted.dispose();
    });
    const [harness, native] = String((named?.data as { session: string }).session).split(" ");
    expect(harness).toBe(id);
    await restarted.resume(sessionId(harnessId(harness ?? ""), native ?? ""));
    const load = (await framesOf(fake.log)).find((frame) => frame.method === "session/load");
    expect((load?.params as Record<string, unknown> | undefined)?.["sessionId"]).toBe(NATIVE);
  }, 20_000);
}
