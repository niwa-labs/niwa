// The options of a session's kind, through session.start: the block named after the kind is checked,
// reaches the control side, is recorded, and is given again when the session is resumed. The block of
// another kind, and a field the block does not have, are refused before anything is started.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import { inputOf } from "@niwa-labs/cli";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import {
  HarnessInstanceRegistry,
  HarnessKindRegistry,
  defineHarnessKind,
  harnessId,
  harnessKind,
  machineId,
  sessionId,
  NO_INSERT,
  NO_READING,
  UNSUPPORTED,
  kindOptions,
} from "@niwa-labs/harness";
import { CLAUDE_CODE_CAPABILITIES, CLAUDE_OPTIONS, claudeCodeKind, claudeSdkKind } from "@niwa-labs/harness-claude";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  ResumeOptions,
  SessionControl,
  SessionId,
  SessionState,
  StartOptions,
  StartedSession,
} from "@niwa-labs/harness";
import { CODEX_OPTIONS, codexKind } from "@niwa-labs/harness-codex";
import { mcodeKind, ncodeKind } from "@niwa-labs/harness-mcode";
import { piKind } from "@niwa-labs/harness-pi";
import { zcodeKind } from "@niwa-labs/harness-zcode";
import { sessions } from "@niwa-labs/sessions";
import type { HarnessBinding } from "@niwa-labs/harness";
import { tempHome } from "@niwa-labs/testing";

const HARNESS = "claude-sonnet";

/** A control side that keeps what it was started and resumed with. */
class RecordingControl implements SessionControl {
  readonly starts: StartOptions[] = [];
  readonly resumes: Array<ResumeOptions | undefined> = [];
  readonly asks: Array<AskOptions<unknown>> = [];

  async start(options: StartOptions): Promise<StartedSession> {
    this.starts.push(options);
    return { session: sessionId(harnessId(HARNESS), `native-${String(this.starts.length)}`) };
  }

  async resume(_id: SessionId, options?: ResumeOptions): Promise<void> {
    this.resumes.push(options);
  }

  async send(): Promise<DeliveryReceipt> {
    return { status: "started", turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    this.asks.push(options as AskOptions<unknown>);
    return { session: id, value: "ok" as T, at: 0 as never };
  }

  async *life(): AsyncIterable<LifeEvent> {}

  async state(): Promise<SessionState> {
    return "idle";
  }
}

function installation(kind: string, structuredOutput = false, tools?: { niwaOnly: boolean; allow: boolean }): Harness {
  return {
    id: harnessId(HARNESS),
    kind: harnessKind(kind),
    machine: machineId("machine-1"),
    home: "/tmp/fake-home",
    sides: {
      control: {
        start: true,
        resume: true,
        send: true,
        interrupt: false,
        ask: true,
        structuredOutput,
        launch: { model: false, effort: [], modes: [] },
        ...(tools === undefined ? {} : { tools }),
      },
    },
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

interface Served {
  readonly niwa: Host;
  readonly records: StoredRecord[];
  readonly home: string;
  readonly stop: () => Promise<void>;
}

/** A served host with the sessions plugin over the given bindings, and what it has written so far. */
async function serve(
  bindings: readonly HarnessBinding[] | { harnesses: HarnessInstanceRegistry },
  home?: string,
): Promise<Served> {
  const fresh = home === undefined ? await tempHome() : undefined;
  const path = home ?? fresh?.path ?? "";
  const niwa = createNiwa({ home: path });
  niwa.use(sessions("harnesses" in bindings ? bindings : { harnesses: bindings }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since()) records.push(record);
  })();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await niwa.close();
  };
  open.push(async () => {
    await stop();
    await fresh?.cleanup();
  });
  return { niwa, records, home: path, stop };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

const claude = (control: SessionControl): HarnessBinding => ({ instance: installation("claude-code", true), control, options: CLAUDE_OPTIONS });

const typesOf = (records: StoredRecord[]): string[] => records.map((record) => record.type).filter((type) => type.startsWith("session."));

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition() && waited < 5_000; waited += 20) await Bun.sleep(20);
}

test("the block of the session's kind reaches the control side and is recorded; a start without one carries none", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false } });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "again" });

  expect(control.starts[0]?.blocks?.claude).toEqual({ advisor: false });
  expect(Object.keys(control.starts[1] ?? {})).not.toContain("blocks");
  await until(() => records.filter((entry) => entry.type === "session.started").length === 2);
  const started = records.filter((entry) => entry.type === "session.started").map((entry) => entry.data);
  expect(started[0]).toMatchObject({ options: { claude: { advisor: false } } });
  expect(started[1]).not.toHaveProperty("options");
});

test("a kind no package of niwa ships has a block of its own, checked by its schema like any other", async () => {
  const control = new RecordingControl();
  const acme = kindOptions("acme", z.strictObject({ speed: z.enum(["slow", "fast"]).optional() }));
  const { niwa, records } = await serve([{ instance: installation("acme-code"), control, options: acme }]);

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", acme: { speed: "fast" } });
  expect(control.starts[0]?.blocks).toEqual({ acme: { speed: "fast" } });
  await until(() => typesOf(records).includes("session.started"));
  expect(records.find((entry) => entry.type === "session.started")?.data).toMatchObject({ options: { acme: { speed: "fast" } } });

  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", acme: { speed: "warp" } })).rejects.toThrow(/speed/);
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", acme: { sped: "fast" } })).rejects.toThrow(/sped/);
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: {} })).rejects.toThrow(/takes the "acme" options block only/);
  // A key that is no field of the start and holds no object is neither a field nor a block.
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", modle: "x" })).rejects.toThrow(/no field "modle"/);
  expect(control.starts).toHaveLength(1);
  const listed = await call<{ items: Array<{ name: string; kind: string; block?: string; options?: unknown }> }>(niwa, "harness.list", {});
  expect(listed.items).toEqual([{ name: HARNESS, kind: "acme-code", block: "acme", options: expect.objectContaining({ properties: { speed: expect.anything() } }) }]);
});

test("the block of another kind is refused before anything is started, naming both", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);

  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", codex: {} })).rejects.toThrow(
    /takes the "claude" options block only \(asked for "codex"\)/,
  );
  // Claude's own block next to a foreign one is still refused: the foreign one is not ignored.
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false }, zcode: {} })).rejects.toThrow(
    /asked for "zcode"/,
  );
  expect(control.starts).toEqual([]);
  expect(typesOf(records)).toEqual([]);
});

test("a kind that declares no options takes no block", async () => {
  const control = new RecordingControl();
  const { niwa } = await serve([{ instance: installation("undeclared-kind"), control }]);

  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: {} })).rejects.toThrow(/takes no options \(asked for "claude"\)/);
  expect(control.starts).toEqual([]);
});

test("a field the block does not have, and a value of the wrong type, are errors, not ignored", async () => {
  const control = new RecordingControl();
  const { niwa } = await serve([claude(control)]);

  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false, typo: 1 } })).rejects.toThrow(/typo/);
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: "no" } })).rejects.toThrow(/advisor/);
  expect(control.starts).toEqual([]);
});

test("a kind with an empty block takes the empty block and nothing in it", async () => {
  const control = new RecordingControl();
  const { niwa } = await serve([{ instance: installation("codex"), control, options: CODEX_OPTIONS }]);

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", codex: {} });
  expect(control.starts[0]?.blocks?.codex).toEqual({});
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", codex: { speed: "fast" } })).rejects.toThrow(/speed/);
  expect(control.starts).toHaveLength(1);
});

test("a resume gives the control side the options the session was started with, from a host that was stopped", async () => {
  const first = new RecordingControl();
  const before = await serve([claude(first)]);
  const { session } = await call<{ session: string }>(before.niwa, "session.start", {
    harness: HARNESS,
    prompt: "go",
    claude: { advisor: false },
  });
  await until(() => typesOf(before.records).includes("session.started"));
  await before.stop();

  // A new host from the journal, over a control side that never held the session.
  const second = new RecordingControl();
  const after = await serve([claude(second)], before.home);
  await call(after.niwa, "session.resume", { session });
  expect(second.resumes[0]?.blocks?.claude).toEqual({ advisor: false });
});

test("a resume of a session that was started with no options gives none", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  await until(() => typesOf(records).includes("session.started"));

  await call(niwa, "session.resume", { session });
  expect(Object.keys(control.resumes[0] ?? {})).not.toContain("blocks");
});

/** A kind with a control side alone: each installation it binds gets the control side given. */
const claudeLike = (control: SessionControl, declared = CLAUDE_CODE_CAPABILITIES.control) =>
  defineHarnessKind({
    name: "claude-code",
    capabilities: { ...CLAUDE_CODE_CAPABILITIES, reading: NO_READING, control: declared, insert: NO_INSERT },
    implements: ["control"],
    options: CLAUDE_OPTIONS,
    home: () => "/tmp/fake-home",
    bind: () => ({ control }),
  });

test("an installation a kind binds carries the options the kind declares to the sessions plugin", async () => {
  const control = new RecordingControl();
  const kinds = new HarnessKindRegistry();
  const kind = claudeLike(control);
  kinds.register(kind);
  const harnesses = new HarnessInstanceRegistry(kinds);
  harnesses.register(kind.bind({ id: HARNESS }));
  const { niwa } = await serve({ harnesses });

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false } });
  expect(control.starts[0]?.blocks?.claude).toEqual({ advisor: false });
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", pi: {} })).rejects.toThrow(/takes the "claude" options block only/);
});

test("the command line gives the block as JSON: session.start --claude '{...}'", async () => {
  const control = new RecordingControl();
  const { niwa } = await serve([claude(control)]);
  const description = (await niwa.describe()).actions.find((entry) => entry.name === "session.start");
  if (description === undefined) throw new Error("session.start is not described");

  const input = inputOf(description, ["--harness", HARNESS, "--prompt", "go", "--claude", '{"advisor":false}']);
  expect(input).toMatchObject({ harness: HARNESS, claude: { advisor: false } });
  await call(niwa, "session.start", input);
  expect(control.starts[0]?.blocks?.claude).toEqual({ advisor: false });
  // Which blocks there are is the kinds' to say: the command takes any block as JSON, and the host refuses the one
  // the harness's kind does not declare.
  expect(inputOf(description, ["--gemini", '{"fast":true}'])).toEqual({ gemini: { fast: true } });
  await expect(call(niwa, "session.start", inputOf(description, ["--harness", HARNESS, "--prompt", "go", "--gemini", "{}"]))).rejects.toThrow(
    /takes the "claude" options block only \(asked for "gemini"\)/,
  );
});

test("a question over the session is asked with the options the session was started with", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "", claude: { advisor: false } });
  const plain = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "" });
  await until(() => records.filter((entry) => entry.type === "session.started").length === 2);

  await call(niwa, "session.ask", { session, prompt: "word?", schema: { type: "string" } });
  await call(niwa, "session.ask", { session: plain.session, prompt: "word?", schema: { type: "string" } });
  expect(control.asks[0]?.blocks?.claude).toEqual({ advisor: false });
  expect(Object.keys(control.asks[1] ?? {})).not.toContain("blocks");
});

test("every kind niwa serves declares the block named after it", () => {
  const blocks = [
    claudeCodeKind.options?.block,
    claudeSdkKind.options?.block,
    codexKind.options?.block,
    mcodeKind.options?.block,
    ncodeKind.options?.block,
    piKind.options?.block,
    zcodeKind.options?.block,
  ];
  expect(blocks).toEqual(["claude", "claude", "codex", "mcode", "ncode", "pi", "zcode"]);
});

test("an installation that claims more than its kind declares is refused before the plugin serves", () => {
  const kinds = new HarnessKindRegistry();
  const kind = claudeLike(new RecordingControl(), { ...CLAUDE_CODE_CAPABILITIES.control, structuredOutput: UNSUPPORTED });
  kinds.register(kind);
  // Bound by the kind, or registered by hand against it: either way it is refused before anything can ask it.
  expect(() => kind.bind({ id: HARNESS, sides: installation("claude-code", true).sides })).toThrow(/control\.structuredOutput/);
  expect(() => new HarnessInstanceRegistry(kinds).register(installation("claude-code", true))).toThrow(/control\.structuredOutput/);
});

test("a tool mode the installation cannot hold is refused before anything is started, naming the mode", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([
    { instance: installation("claude-code", true, { niwaOnly: false, allow: true }), control, options: CLAUDE_OPTIONS },
  ]);

  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", tools: "niwa-only" })).rejects.toMatchObject({
    code: "Unsupported",
    message: expect.stringContaining("tools niwa-only"),
  });
  // The harness's own tools are never refused.
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", tools: "all" });
  expect(control.starts).toHaveLength(1);
  expect(Object.keys(control.starts[0] ?? {})).not.toContain("tools");
  await until(() => typesOf(records).includes("session.started"));
  expect(records.filter((entry) => entry.type === "session.started")).toHaveLength(1);
});

test("the tool mode reaches the control side, is recorded, and a process launched again keeps it", async () => {
  const first = new RecordingControl();
  const holding = { niwaOnly: true, allow: true };
  const before = await serve([{ instance: installation("claude-code", true, holding), control: first, options: CLAUDE_OPTIONS }]);
  const { session } = await call<{ session: string }>(before.niwa, "session.start", { harness: HARNESS, prompt: "go", tools: "niwa-only" });
  await call(before.niwa, "session.start", { harness: HARNESS, prompt: "go", tools: { allow: ["Read"] } });
  expect(first.starts.map((options) => options.tools)).toEqual(["niwa-only", { allow: ["Read"] }]);
  await until(() => before.records.filter((entry) => entry.type === "session.started").length === 2);
  const started = before.records.filter((entry) => entry.type === "session.started").map((entry) => entry.data);
  expect(started.map((data) => (data as { tools?: unknown }).tools)).toEqual(["niwa-only", { allow: ["Read"] }]);
  await before.stop();

  // A control side that never held the session: its process is gone and is launched again.
  const second = new (class extends RecordingControl {
    override async state(): Promise<SessionState> {
      return "unknown";
    }
  })();
  const after = await serve([{ instance: installation("claude-code", true, holding), control: second, options: CLAUDE_OPTIONS }], before.home);
  await call(after.niwa, "session.resume", { session });
  expect(second.resumes[0]?.tools).toBe("niwa-only");
});
