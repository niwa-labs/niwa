/**
 * The kinds of the harnesses.
 *
 * A kind is code, and the sides it serves are part of that code: a kind with a control side can
 * start, steer and stop sessions, and an installation that claims the side finds it there. This
 * check is about that wiring, so it runs no CLI and no model and says the same on every machine.
 *
 * The fakes at the bottom speak the wire of each harness. They are there for two things: to prove
 * that what an installation declares is what the control side implements, and to prove that the
 * options of a kind reach the harness. A model named in the options is the model the harness is
 * asked for, and a permission policy named in the options is the policy that is applied.
 */

import { expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { eventually, tempDir, fakeSdkQuery } from "@niwa-labs/testing";

import {
  Unsupported,
  controlConformance,
  harnessId,
  insertConformance,
  machineId,
  promptFromText,
  readingConformance,
  admitInstance,
  requireAbility,
} from "@niwa-labs/harness";
import type {
  ControlCapabilities,
  Harness,
  HarnessId,
  HarnessKind,
  HarnessKindDefinition,
  InsertCapabilities,
  InsertEvent,
  ReadingCapabilities,
  SessionControl,
  SessionId,
  SideCapabilities,
} from "@niwa-labs/harness";

import {
  CLAUDE_CODE_HARNESS as CLAUDE_CODE_NAME,
  claudeCode,
  claudeCodeKind,
  claudeCodeSides,
  writeClaudeCodeFixtures,
  ClaudeSdkControl,
  claudeSdkKind,
  claudeSdkSides,
} from "@niwa-labs/harness-claude";
import {
  mcode,
  mcodeSides,
  ncode,
  ncodeSides,
} from "@niwa-labs/harness-mcode";
import { CODEX_HARNESS, codex, codexSides, writeCodexFixtures } from "@niwa-labs/harness-codex";
import { zcode, zcodeSides } from "@niwa-labs/harness-zcode";
import { PI_EXTENSION_FILE, PiControl, pi, piSides } from "@niwa-labs/harness-pi";

/** The id the claude-code fixtures are written for. */
const CLAUDE_CODE_HARNESS = harnessId(CLAUDE_CODE_NAME);

/** The installation the kinds serve. */
const HARNESS = harnessId("kinds-test");

/** The machine the installation is on. */
const MACHINE = machineId("machine-1");

/** What the installation of a kind declares of its control side: what the kind offers by default. */
function controlOf(sides: SideCapabilities): ControlCapabilities {
  if (sides.control === undefined) throw new Error("the sides have no control side");
  return sides.control;
}

/**
 * A kind serves the sides its code has, and its installation may claim exactly those.
 *
 * The reading side implements the abilities the installation declares of it, and no other: a
 * side that implements more than it declares is a side that was never declared.
 *
 * The insert side is told apart by the way it works: one is put into the harness and reports
 * what it saw, the other pulls its events out of the harness. A kind that names no insert has
 * none.
 */
function checkSides(
  kind: HarnessKindDefinition,
  control: ControlCapabilities,
  insert?: "install" | "events",
): void {
  expect(kind.reading).toBeDefined();
  expect(kind.control).toBeDefined();
  if (insert === undefined) {
    expect(kind.insert).toBeUndefined();
  } else {
    const side = kind.insert;
    if (side === undefined) throw new Error("the kind has no insert side");
    expect(typeof side[insert]).toBe("function");
  }

  const instance = installation(kind.kind, control, HARNESS, "/tmp/niwa-kinds", insert !== undefined);
  // The sides the installation claims are within what the kind declares and has code for.
  expect(() => admitInstance(instance, kind)).not.toThrow();

  const reading = kind.reading;
  if (reading === undefined) return;
  for (const ability of ["list", "read", "watch"] as const satisfies readonly (keyof ReadingCapabilities)[]) {
    const declared = instance.sides.reading?.[ability] === true;
    expect(typeof reading[ability] === "function").toBe(declared);
  }
}

/** The installation of a kind, with the sides it claims. */
function installation(
  kind: HarnessKind,
  control: ControlCapabilities,
  id: HarnessId = HARNESS,
  home = "/tmp/niwa-kinds",
  withInsert = false,
): Harness {
  return {
    id,
    kind,
    machine: MACHINE,
    home,
    sides: {
      reading: { list: true, read: true, watch: false },
      control,
      ...(withInsert
        ? {
            insert: {
              nested: false,
              compaction: true,
              manualOpen: true,
              permission: false,
              end: false,
            },
          }
        : {}),
    },
  };
}

/**
 * The installation of a kind that serves the insert side and no control side.
 *
 * The pi kind has no control side, so its installation claims none: the abilities of the insert
 * side are the ones it declares.
 */
function insertInstallation(kind: HarnessKind, home = "/tmp/niwa-kinds-pi"): Harness {
  const insert: InsertCapabilities = {
    nested: false,
    compaction: true,
    manualOpen: true,
    permission: false,
    end: false,
  };
  return {
    id: HARNESS,
    kind,
    machine: MACHINE,
    home,
    sides: {
      reading: { list: true, read: true, watch: false },
      insert,
    },
  };
}

test("the claude-code kind serves the reading side, the control side and the insert side", () => {
  const kind = claudeCode();
  expect(String(kind.kind)).toBe("claude-code");
  checkSides(kind, controlOf(claudeCodeSides), "install");
});

test("the codex kind serves the reading side and the control side", () => {
  const kind = codex();
  expect(String(kind.kind)).toBe("codex");
  checkSides(kind, controlOf(codexSides));
});

test("the pi kind serves the reading side, the control side and the insert side", () => {
  const kind = pi({ harness: HARNESS, sessionsRoot: "/tmp/niwa-kinds-pi" });
  expect(String(kind.kind)).toBe("pi");
  expect(kind.reading).toBeDefined();
  expect(kind.control).toBeDefined();
  checkSides(kind, controlOf(piSides), "install");

  // The insert is put into pi, and pi reports for itself: there is no stream to read.
  const insert = kind.insert;
  if (insert === undefined) throw new Error("the kind has no insert side");
  expect(insert.events).toBeUndefined();
  expect(insert.answerPermission).toBeUndefined();
});

test("installing the pi insert writes the extension into the agent directory of the installation, told where the host is", async () => {
  const dir = await tempDir("kinds-pi-install");
  try {
    const kind = pi({ harness: HARNESS, sessionsRoot: join(dir, "sessions") });
    await kind.insert?.install?.({ home: "/tmp/niwa-host-home", cli: "/opt/niwa/bin/niwa.ts" });
    const file = await Bun.file(join(dir, "extensions", PI_EXTENSION_FILE)).text();
    expect(file).toContain('process.env.NIWA_HOME ??= "/tmp/niwa-host-home";');
    expect(file).toContain('process.env.NIWA_CLI ??= "/opt/niwa/bin/niwa.ts";');
    expect(file).toContain(`process.env.NIWA_PI_INSTANCE ??= "${String(HARNESS)}";`);
    expect(file).toContain("/harness-pi/src/insert/extension.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the pi control side declares what pi's RPC mode really supports", () => {
  const control = controlOf(piSides);
  // pi answers a prompt, aborts a run, and is opened again by its own file.
  expect(control.start).toBe(true);
  expect(control.resume).toBe(true);
  expect(control.send).toBe(true);
  expect(control.interrupt).toBe(true);
  // pi asks its questions through its own extension protocol, so a question cannot be put to a
  // pi session from the control side. Its events carry pi's messages, not a structured result.
  expect(control.ask).toBe(false);
  expect(control.structuredOutput).toBe(false);
});

test("the claude-code insert installs the plugin into the plugins directory of its home", async () => {
  const home = await tempDir("kinds-cc");
  try {
    const kind = claudeCodeKind({ harness: HARNESS, home });
    await kind.insert?.install?.({ home: "/tmp/niwa-host-home" });
    const hooks = await Bun.file(join(home, "plugins", "niwa-insert", "hooks", "hooks.json")).text();
    expect(hooks).toContain("NIWA_HOME='/tmp/niwa-host-home'");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the mcode kind serves the reading side and the control side", () => {
  const kind = mcode();
  expect(String(kind.kind)).toBe("mcode");
  checkSides(kind, controlOf(mcodeSides));
});

test("the ncode kind serves the reading side and the control side, as its own kind", () => {
  const kind = ncode();
  expect(String(kind.kind)).toBe("ncode");
  expect(String(kind.kind)).not.toBe(String(mcode().kind));
  checkSides(kind, controlOf(ncodeSides));
  expect(ncodeSides).toEqual(mcodeSides);
  expect(ncodeSides).not.toBe(mcodeSides);
});

test("the zcode kind serves the reading side and the control side", () => {
  const kind = zcode();
  expect(String(kind.kind)).toBe("zcode");
  checkSides(kind, controlOf(zcodeSides));
});

test("every kind whose control side validates the answer declares structured output", () => {
  for (const sides of [codexSides, claudeSdkSides, claudeCodeSides, mcodeSides, ncodeSides, zcodeSides]) {
    expect(controlOf(sides).ask).toBe(true);
    expect(controlOf(sides).structuredOutput).toBe(true);
  }
});

test("an ability the installation does not declare is refused by name", () => {
  const kind = claudeCode();
  const instance = installation(kind.kind, {
    start: true,
    resume: false,
    send: false,
    interrupt: false,
    ask: false,
    structuredOutput: false, launch: { model: false, effort: [], modes: [] },
  });

  for (const ability of ["resume", "send", "interrupt", "ask"] as const) {
    let refusal: unknown;
    try {
      requireAbility(instance, "control", ability);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Unsupported);
  }
});

test("the reading side of the claude-code kind passes the conformance suite", async () => {
  const report = await readingConformance(
    "claude-code",
    (home) => {
      const kind = claudeCode({ harness: CLAUDE_CODE_HARNESS, home });
      const reading = kind.reading;
      if (reading === undefined) throw new Error("the kind has no reading side");
      return {
        instance: installation(kind.kind, controlOf(claudeCodeSides), CLAUDE_CODE_HARNESS, home),
        reading,
      };
    },
    writeClaudeCodeFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.passed).toBe(true);
});

test("the reading side of the codex kind passes the conformance suite", async () => {
  const report = await readingConformance(
    "codex",
    (home) => {
      const kind = codex({ harness: CODEX_HARNESS, home });
      const reading = kind.reading;
      if (reading === undefined) throw new Error("the kind has no reading side");
      return {
        instance: installation(kind.kind, controlOf(codexSides), CODEX_HARNESS, home),
        reading,
      };
    },
    writeCodexFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.passed).toBe(true);
});

test("the control side of the claude-code kind implements what is declared", async () => {
  const fake = await fakeAgent(FAKE_CLAUDE_ACP);
  const kind = claudeCode({
    harness: HARNESS,
    home: fake.dir,
    control: { command: [fake.path], model: "haiku", permissions: "deny" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    await checkControl(control);

    const frames = await framesOf(fake.log);
    // The model of the options is the model the harness was asked for.
    expect(frames.find((frame) => frame.method === "session/set_model")?.params).toMatchObject({
      modelId: "haiku",
    });
    // The permission policy of the options is the policy that answered the request.
    expect(
      frames.find((frame) => frame.id === "perm-1" && frame.method === undefined)?.result,
    ).toMatchObject({ outcome: { optionId: "reject" } });
  } finally {
    await stopFake(fake, control);
  }
});

test("the control side of the codex kind implements what is declared", async () => {
  const fake = await fakeAgent(FAKE_CODEX);
  const kind = codex({
    harness: HARNESS,
    home: fake.dir,
    control: { binary: fake.path, model: "gpt-test" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    await checkControl(control);

    const frames = await framesOf(fake.log);
    // The model of the options is the model the harness was asked for.
    expect(frames.find((frame) => frame.method === "thread/start")?.params).toMatchObject({
      model: "gpt-test",
    });
  } finally {
    await stopFake(fake, control);
  }
});

test("the control side of the claude-code kind passes the conformance suite", async () => {
  const fake = await fakeAgent(FAKE_CLAUDE_ACP);
  const kind = claudeCode({
    harness: HARNESS,
    home: fake.dir,
    control: { command: [fake.path], model: "haiku", permissions: "deny" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const report = await controlConformance("claude-code", {
      instance: installation(kind.kind, controlOf(claudeCodeSides), HARNESS, fake.dir),
      control,
      declared: kind.capabilities,
      dispatched: async () => (await framesOf(fake.log)).length,
    })();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.passed).toBe(true);
  } finally {
    await stopFake(fake, control);
  }
});

test("the control side of the codex kind passes the conformance suite", async () => {
  const fake = await fakeAgent(FAKE_CODEX);
  const kind = codex({
    harness: HARNESS,
    home: fake.dir,
    control: { binary: fake.path, model: "gpt-test" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const report = await controlConformance("codex", {
      instance: installation(kind.kind, controlOf(codexSides), HARNESS, fake.dir),
      control,
      declared: kind.capabilities,
      dispatched: async () => (await framesOf(fake.log)).length,
    })();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.passed).toBe(true);
  } finally {
    await stopFake(fake, control);
  }
});

test("the control side of the pi kind passes the conformance suite", async () => {
  const fake = await fakeAgent(FAKE_PI);
  const kind = pi({
    harness: HARNESS,
    sessionsRoot: fake.dir,
    control: { mode: "full", binary: fake.path, model: "test/model" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const report = await controlConformance("pi", {
      instance: installation(kind.kind, controlOf(piSides), HARNESS, fake.dir),
      control,
      declared: kind.capabilities,
      dispatched: async () => (await framesOf(fake.log)).length,
    })();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.passed).toBe(true);
  } finally {
    await stopFake(fake, control);
  }
});

test("the control side of the pi kind speaks pi's own dialect", async () => {
  const fake = await fakeAgent(FAKE_PI);
  const kind = pi({
    harness: HARNESS,
    sessionsRoot: fake.dir,
    control: { mode: "full", binary: fake.path, model: "test/model" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const { session: id } = await control.start({ prompt: promptFromText("hello") });
    expect(id.native).toBe("0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as typeof id.native);

    const frames = await framesOf(fake.log);
    // The first request is the one that names the session: pi has no greeting.
    expect(frames[0]?.type).toBe("get_state");
    // The turn is delivered the way pi takes it.
    expect(frames.find((frame) => frame.type === "prompt")?.message).toBe("hello");

    // A question of pi's own is answered at once, so the run is not left waiting.
    const answered = await frameOf(fake.log, (frame) => frame.answered === "dialog-1");
    expect(answered?.cancelled).toBe(true);
  } finally {
    await stopFake(fake, control);
  }
});

test("a pi session started with no mode chosen runs in the one mode pi has", async () => {
  const fake = await fakeAgent(FAKE_PI);
  // Neither the instance nor the call names a mode.
  const kind = pi({
    harness: HARNESS,
    sessionsRoot: fake.dir,
    control: { binary: fake.path, model: "test/model" },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const { session: id } = await control.start({ prompt: promptFromText("hello") });
    expect(id.native).toBe("0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as typeof id.native);
  } finally {
    await stopFake(fake, control);
  }
});

test("the pi control side queues a busy send through prompt, and refuses to resume a turn-less session", async () => {
  const fake = await fakeAgent(FAKE_PI);
  const kind = pi({
    harness: HARNESS,
    sessionsRoot: fake.dir,
    control: { mode: "full", binary: fake.path, model: "test/model", home: fake.dir },
  });
  const control = kind.control;
  if (control === undefined) throw new Error("the kind has no control side");

  try {
    const { session: id } = await control.start({ prompt: promptFromText("") });
    const held = await control.send(id, "hold this");
    expect(held.status).toBe("started");
    // Wait until the side has seen the run begin: the fake's `agent_start` reaches it as an event.
    await eventually(async () => (await control.state(id)) === "running", 15_000);
    const queued = await control.send(id, "later");
    expect(queued.status).toBe("queued");
    const steered = await control.send(id, "now", { into: "turn" });
    expect(steered.status).toBe("delivered");

    // The fake logs a frame before it answers it, so both are there once the sends have returned;
    // waiting for them keeps a slow machine from reading the log too early.
    await frameOf(fake.log, (frame) => frame.message === "later");
    await frameOf(fake.log, (frame) => frame.message === "now");
    const frames = await framesOf(fake.log);
    // pi decides atomically whether it is working: no bare follow_up or steer goes out.
    expect(frames.some((frame) => frame.type === "follow_up" || frame.type === "steer")).toBe(false);
    expect(frames.find((frame) => frame.message === "later")?.streamingBehavior).toBe("followUp");
    expect(frames.find((frame) => frame.message === "now")?.streamingBehavior).toBe("steer");

    // pi wrote no file for this session (it has not run a turn it could save): resume is a typed
    // refusal, not a hang and not a process on a file that is not there.
    await (control as PiControl).stop(id);
    await expect(control.resume(id)).rejects.toThrow(/no file/);
  } finally {
    await stopFake(fake, control);
  }
});

for (const [name, make, sides] of [
  ["mcode", mcode, mcodeSides],
  ["ncode", ncode, ncodeSides],
] as const) {
  test(`the control side of the ${name} kind implements what is declared`, async () => {
    const fake = await fakeAgent(FAKE_MCODE, { "@METHODS@": JSON.stringify(name === "ncode" ? ["mcode/session/turn_status", "session/history"] : ["mcode/session/steer"]) });
    const kind = make({
      harness: HARNESS,
      home: fake.dir,
      control: {
        mode: "full",
        binary: fake.path,
        model: "minimax/MiniMax-M3.1-Flash",
        permissions: "deny",
      },
    });
    const control = kind.control;
    if (control === undefined) throw new Error("the kind has no control side");

    try {
      await checkControl(control);

      const frames = await framesOf(fake.log);
      // The model of the options is the model the harness was asked for.
      expect(
        frames.find(
          (frame) =>
            frame.method === "session/set_config_option" &&
            (frame.params as Record<string, unknown> | undefined)?.["configId"] === "model",
        )?.params,
      ).toMatchObject({ value: "m:minimax:MiniMax-M3.1-Flash:u" });
      // The permission policy of the options is the policy that answered the request.
      expect(
        frames.find((frame) => frame.id === "perm-1" && frame.method === undefined)?.result,
      ).toMatchObject({ outcome: { outcome: "selected", optionId: "reject" } });
    } finally {
      await stopFake(fake, control);
    }
  });

  test(`the control side of the ${name} kind passes the conformance suite`, async () => {
    const fake = await fakeAgent(FAKE_MCODE, { "@METHODS@": JSON.stringify(name === "ncode" ? ["mcode/session/turn_status", "session/history"] : ["mcode/session/steer"]) });
    const kind = make({
      harness: HARNESS,
      home: fake.dir,
      control: {
        mode: "full",
        binary: fake.path,
        model: "minimax/MiniMax-M3.1-Flash",
        permissions: "deny",
      },
    });
    const control = kind.control;
    if (control === undefined) throw new Error("the kind has no control side");

    try {
      const report = await controlConformance(name, {
        instance: installation(kind.kind, controlOf(sides), HARNESS, fake.dir),
        control,
        declared: kind.capabilities,
        dispatched: async () => (await framesOf(fake.log)).length,
      })();
      const failed = report.results.filter((result) => !result.passed);
      expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
      expect(report.passed).toBe(true);
    } finally {
      await stopFake(fake, control);
    }
  });
}

test("the control side of the claude-sdk kind passes the conformance suite", async () => {
  const fake = fakeSdkQuery();
  const control = new ClaudeSdkControl({
    harness: HARNESS,
    permissions: "deny",
    turnTimeoutMs: 5_000,
    startTimeoutMs: 5_000,
    query: fake.query,
  });

  try {
    const report = await controlConformance("claude-sdk", {
      instance: installation(claudeSdkKind().kind, controlOf(claudeSdkSides), HARNESS),
      control,
    })();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.passed).toBe(true);
    // The suite evaluated the turn checks, not only the start.
    expect(report.results.map((result) => result.name)).toContain("life: the turn ended is reported");
    // The suite drove the fake: the start and each of the two questions (the plain one and the
    // one behind a running turn) opened a query; the resume and the sends went into the one the
    // start opened.
    expect(fake.served()).toBe(3);
  } finally {
    await control.dispose();
  }
  // Every query the side opened is stopped, so no process or stream outlives the test.
  await Bun.sleep(50);
  expect(fake.open()).toBe(0);
});

test("the insert side of the pi kind passes the conformance suite", async () => {
  // The pi insert is put into pi: it is installed, and it has no stream to read, so the suite
  // takes the install branch.
  const kind = pi({ harness: HARNESS, sessionsRoot: "/tmp/niwa-kinds-pi" });
  const insert = kind.insert;
  if (insert === undefined) throw new Error("the kind has no insert side");
  const report = await insertConformance("pi", { instance: insertInstallation(kind.kind), insert })();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.passed).toBe(true);
});

test("the insert side of the claude-code kind passes the conformance suite", async () => {
  // The claude-code insert is put into the harness: it is installed, and it has no stream to
  // read, so the suite takes the install branch.
  const home = await tempDir("kinds-cc");
  try {
    const kind = claudeCodeKind({ harness: HARNESS, home });
    const insert = kind.insert;
    if (insert === undefined) throw new Error("the kind has no insert side");
    expect(insert.events).toBeUndefined();
    expect(typeof insert.install).toBe("function");

    const report = await insertConformance("claude-code", {
      instance: installation(kind.kind, controlOf(claudeCodeSides), HARNESS, home, true),
      insert,
    })();
    const failed = report.results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.passed).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * What an installation declares of the control side, the control side does.
 *
 * Every ability is exercised against the harness of the kind: the session is named by the
 * harness, it resumes, it takes a message, its turn is interrupted, and a question comes back as
 * a value that passed the schema.
 */
async function checkControl(control: SessionControl): Promise<void> {
  const { session: id, first } = await control.start({ prompt: promptFromText("hello") });
  // The session belongs to the installation, and the harness named it.
  expect(id.harness).toBe(HARNESS);
  expect(id.native.length).toBeGreaterThan(0);
  // The prompt is the first turn: the start says it began, and does not wait for its end. The
  // caller that needs the session idle waits for that turn itself.
  expect(first?.status).toBe("started");
  await idle(control, id);

  await control.resume(id);

  const receipt = await control.send(id, "hold");
  expect(receipt.status).toBe("started");
  expect(await control.state(id)).toBe("running");

  await control.interrupt(id);
  await idle(control, id);

  const answer = await control.ask(id, {
    schema: z.string(),
    prompt: promptFromText("what?"),
  });
  expect(answer.value).toBe("ok");
}

/** Waits until the session is idle: the turn it ran has ended. */
async function idle(control: SessionControl, id: SessionId): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await control.state(id)) !== "idle") {
    if (Date.now() > deadline) throw new Error("the session did not become idle");
    await Bun.sleep(20);
  }
}

/** A fake harness CLI: a directory of its own, a log of the frames it received, and a stop. */
interface Fake {
  /** The directory the fake lives in. */
  readonly dir: string;
  /** The program to run. */
  readonly path: string;
  /** The file the frames it received are written to. */
  readonly log: string;
  /** The file whose existence tells the fake to go. */
  readonly stop: string;
}

/** A fake harness CLI, ready to be started. */
async function fakeAgent(script: string, replaced: Readonly<Record<string, string>> = {}): Promise<Fake> {
  const dir = await tempDir("kinds-fake");
  const log = join(dir, "frames.log");
  const stop = join(dir, "stop");
  const path = join(dir, "fake-harness");
  let written = script.replaceAll("@LOG@", log).replaceAll("@STOP@", stop);
  for (const [from, to] of Object.entries(replaced)) written = written.replaceAll(from, to);
  await writeFile(path, written);
  await chmod(path, 0o755);
  return { dir, path, log, stop };
}

/** The frames the fake received. */
async function framesOf(log: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The first frame the fake received that matches, waited for.
 *
 * The fake writes its log as it goes, so a frame that is answered a moment later is not there
 * yet when the first question is asked.
 */
async function frameOf(
  log: string,
  matches: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = (await framesOf(log)).find(matches);
    if (frame !== undefined) return frame;
    await Bun.sleep(20);
  }
  return undefined;
}

/** Tells the fake to go, stops what the control side owns, and waits until the fake is gone. */
async function stopFake(fake: Fake, control: SessionControl): Promise<void> {
  // The fake goes first, on its own: it says so, and only then is the control side released.
  await writeFile(fake.stop, "");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(fake.log, "utf8").catch(() => "");
    if (text.includes("stopped")) break;
    await Bun.sleep(20);
  }
  await disposeOf(control);
  await rm(fake.dir, { recursive: true, force: true });
}

/** Stops what the control side owns, when it owns anything. */
async function disposeOf(control: SessionControl): Promise<void> {
  if ("dispose" in control && typeof control.dispose === "function") await control.dispose();
}

/**
 * A fake pi, in its RPC mode.
 *
 * It speaks pi's dialect: a request per line on stdin, an answer per line on stdout, and the
 * events of a run in between. It names its session and its file in `get_state`, and it runs a
 * turn when it is given a prompt: `agent_start`, the steps, `agent_end`. A prompt that says
 * "hold" is kept open until the client aborts it, so a turn can be interrupted.
 *
 * It asks one question of its own, the way an extension does, so the side has to answer it
 * rather than leave the run waiting.
 */
const FAKE_PI = `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const log = "@LOG@";
const stop = "@STOP@";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
setInterval(() => { if (existsSync(stop)) { appendFileSync(log, "stopped\\n"); process.exit(0); } }, 25);
const SESSION = "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FILE = "/tmp/niwa-kinds-pi/--tmp--/2026-11-16T13-00-00-000Z_" + SESSION + ".jsonl";
let held = false;
let asked = false;
function run(text) {
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant" } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
  if (text.includes("hold")) {
    held = true;
  } else {
    out({ type: "agent_end", messages: [], willRetry: false });
  }
}
function finish() {
  if (!held) return;
  held = false;
  out({ type: "agent_end", messages: [], willRetry: false });
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    appendFileSync(log, JSON.stringify(frame) + "\\n");
    if (frame.type === "get_state") {
      out({ type: "response", id: frame.id, command: "get_state", success: true, data: {
        sessionId: SESSION, sessionFile: FILE, isStreaming: held, messageCount: 1,
      } });
    } else if (frame.type === "prompt") {
      out({ type: "response", id: frame.id, command: "prompt", success: true });
      if (!asked) {
        asked = true;
        // A question of an extension: it waits for an answer, and the side must answer it.
        out({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "go on?" });
      }
      // A prompt sent with a streaming behavior while a run is held is queued by pi, not run.
      if (!(held && frame.streamingBehavior !== undefined)) run(frame.message ?? "");
    } else if (frame.type === "follow_up" || frame.type === "steer") {
      out({ type: "response", id: frame.id, command: frame.type, success: true });
    } else if (frame.type === "abort") {
      out({ type: "response", id: frame.id, command: "abort", success: true });
      finish();
    } else if (frame.type === "extension_ui_response") {
      appendFileSync(log, JSON.stringify({ answered: frame.id, cancelled: frame.cancelled }) + "\\n");
    }
  }
}
`;

/**
 * A fake ACP adapter: the one Claude Code is driven through.
 *
 * It answers the handshake, names a session, takes the model and the mode, and answers every
 * prompt with one JSON string. It asks for permission on its first prompt, so the policy of the
 * control side is the thing that answers it. A prompt that says "hold" is kept open until the
 * client cancels it, so a turn can be interrupted.
 */
const FAKE_CLAUDE_ACP = `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const log = "@LOG@";
const stop = "@STOP@";
const out = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
setInterval(() => { if (existsSync(stop)) { appendFileSync(log, "stopped\\n"); process.exit(0); } }, 25);
let pending = null;
let asked = false;
function reply(stopReason) {
  if (pending === null) return;
  const prompt = pending;
  pending = null;
  if (stopReason !== "cancelled") {
    out({ method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\\"ok\\"" } } } });
  }
  out({ id: prompt.id, result: { stopReason } });
}
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
      out({ id: frame.id, result: { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [] }, models: { currentModelId: "default", availableModels: [] }, configOptions: [] } });
    } else if (frame.method === "session/load") {
      out({ id: frame.id, result: { sessionId: frame.params.sessionId } });
    } else if (frame.method === "session/set_model" || frame.method === "session/set_mode") {
      out({ id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      pending = frame;
      const text = frame.params.prompt[0].text;
      if (!asked) {
        asked = true;
        out({ id: "perm-1", method: "session/request_permission", params: { sessionId: "fake-session", options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ], toolCall: { toolCallId: "tu-1", title: "Bash", rawInput: { command: "ls" } } } });
      } else if (!text.includes("hold")) {
        reply("end_turn");
      }
      // A prompt that says "hold" stays open until the client cancels it.
    } else if (frame.method === "session/cancel") {
      reply("cancelled");
    } else if (frame.method === undefined && frame.id === "perm-1") {
      reply("end_turn");
    }
  }
}
`;

/**
 * A fake Codex app-server: the one Codex is driven through.
 *
 * It answers the handshake, starts and resumes a thread, and answers every turn with one JSON
 * string. A turn that says "hold" is kept open until the client interrupts it, so a turn can be
 * interrupted.
 */
const FAKE_CODEX = `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import { agentMessageCompleted, turnCompleted, turnStarted } from ${JSON.stringify(new URL("./fixtures/codex-frames.ts", import.meta.url).pathname)};
const log = "@LOG@";
const stop = "@STOP@";
const out = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
setInterval(() => { if (existsSync(stop)) { appendFileSync(log, "stopped\\n"); process.exit(0); } }, 25);
const THREAD = "11111111-2222-3333-4444-555555555555";
let turn = 0;
let held = false;
function finish() {
  out(agentMessageCompleted(THREAD, "t" + turn, "\\"ok\\""));
  out(turnCompleted(THREAD, "t" + turn, "completed"));
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    appendFileSync(log, JSON.stringify(frame) + "\\n");
    if (frame.method === "initialize") {
      out({ id: frame.id, result: {} });
    } else if (frame.method === "thread/start") {
      out({ id: frame.id, result: { thread: { id: THREAD } } });
    } else if (frame.method === "thread/resume") {
      out({ id: frame.id, result: { thread: { id: frame.params.threadId } } });
    } else if (frame.method === "turn/start") {
      turn += 1;
      out({ id: frame.id, result: { turn: { id: "t" + turn } } });
      out(turnStarted(THREAD, "t" + turn));
      if (frame.params.input[0].text.includes("hold")) {
        held = true;
      } else {
        finish();
      }
    } else if (frame.method === "turn/interrupt") {
      out({ id: frame.id, result: {} });
      if (held) {
        held = false;
        finish();
      }
    }
  }
}
`;

/**
 * A fake MiniMax Code agent: the one `mcode acp` is.
 *
 * It answers the handshake, names a session, advertises one model, takes the config options and
 * answers every prompt with one JSON string. It asks for permission on its first prompt, so the
 * policy of the control side is the thing that answers it. A prompt that says "hold" is kept open
 * until the client cancels it, so a turn can be interrupted.
 */
const FAKE_MCODE = `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const log = "@LOG@";
const stop = "@STOP@";
const out = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
setInterval(() => { if (existsSync(stop)) { appendFileSync(log, "stopped\\n"); process.exit(0); } }, 25);
let pending = null;
let asked = false;
function reply(stopReason) {
  if (pending === null) return;
  const prompt = pending;
  pending = null;
  if (stopReason !== "cancelled") {
    out({ method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\\"ok\\"" } } } });
  }
  out({ id: prompt.id, result: { stopReason } });
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    appendFileSync(log, JSON.stringify(frame) + "\\n");
    if (frame.method === "initialize") {
      // The fork serves the turn status and the history; the published build does not.
      out({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], _meta: { "minimax-code/extensions": { version: 1, methods: @METHODS@, notifications: [] } } } });
    } else if (frame.method === "session/new") {
      out({ id: frame.id, result: { sessionId: "fake-session", configOptions: [
        { id: "model", options: [{ value: "m:minimax:MiniMax-M3.1-Flash:u", name: "M3.1-Flash" }] },
      ] } });
    } else if (frame.method === "session/load") {
      out({ id: frame.id, result: { sessionId: frame.params.sessionId, configOptions: [
        { id: "model", options: [{ value: "m:minimax:MiniMax-M3.1-Flash:u", name: "M3.1-Flash" }] },
      ] } });
    } else if (frame.method === "session/set_config_option") {
      out({ id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      pending = frame;
      const text = frame.params.prompt[0].text;
      if (!asked) {
        asked = true;
        out({ id: "perm-1", method: "session/request_permission", params: { sessionId: "fake-session", options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ], toolCall: { toolCallId: "tu-1", title: "Bash", rawInput: { command: "ls" } } } });
      } else if (!text.includes("hold")) {
        reply("end_turn");
      }
      // A prompt that says "hold" stays open until the client cancels it.
    } else if (frame.method === "session/cancel") {
      reply("cancelled");
    } else if (frame.method === undefined && frame.id === "perm-1") {
      reply("end_turn");
    }
  }
}
`;
