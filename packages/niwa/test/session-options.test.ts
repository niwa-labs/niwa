// The options of a session's kind, through session.start: the block named after the kind is checked,
// reaches the control side, is recorded, and is given again when the session is resumed. The block of
// another kind, and a field the block does not have, are refused before anything is started.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import { inputOf } from "@niwa-labs/cli";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import {
  HarnessInstanceRegistry,
  HarnessKindRegistry,
  KIND_OPTIONS,
  defineHarnessKind,
  harnessId,
  harnessKind,
  machineId,
  sessionId,
} from "@niwa-labs/harness";
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
import { claudeCode, claudeSdkKind } from "@niwa-labs/harness-claude";
import { codex } from "@niwa-labs/harness-codex";
import { mcode, ncode } from "@niwa-labs/harness-mcode";
import { pi } from "@niwa-labs/harness-pi";
import { zcode } from "@niwa-labs/harness-zcode";
import { sessions } from "@niwa-labs/sessions";
import type { HarnessBinding } from "@niwa-labs/sessions";
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

function installation(kind: string, structuredOutput = false): Harness {
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
  bindings: readonly HarnessBinding[] | { harnesses: HarnessInstanceRegistry; kinds: HarnessKindRegistry },
  home?: string,
): Promise<Served> {
  const fresh = home === undefined ? await tempHome() : undefined;
  const path = home ?? fresh?.path ?? "";
  const niwa = createNiwa({ home: path });
  niwa.use(sessions("harnesses" in bindings ? bindings : { harnesses: bindings }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since(seq(0))) records.push(record);
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

const claude = (control: SessionControl): HarnessBinding => ({ instance: installation("claude-code", true), control, options: KIND_OPTIONS.claude });

const typesOf = (records: StoredRecord[]): string[] => records.map((record) => record.type).filter((type) => type.startsWith("session."));

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition() && waited < 5_000; waited += 20) await Bun.sleep(20);
}

test("the block of the session's kind reaches the control side and is recorded; a start without one carries none", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false } });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "again" });

  expect(control.starts[0]?.claude).toEqual({ advisor: false });
  expect(Object.keys(control.starts[1] ?? {})).not.toContain("claude");
  await until(() => records.filter((entry) => entry.type === "session.started").length === 2);
  const started = records.filter((entry) => entry.type === "session.started").map((entry) => entry.data);
  expect(started[0]).toMatchObject({ options: { claude: { advisor: false } } });
  expect(started[1]).not.toHaveProperty("options");
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
  const { niwa } = await serve([{ instance: installation("codex"), control, options: KIND_OPTIONS.codex }]);

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", codex: {} });
  expect(control.starts[0]?.codex).toEqual({});
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
  expect(second.resumes[0]?.claude).toEqual({ advisor: false });
});

test("a resume of a session that was started with no options gives none", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  await until(() => typesOf(records).includes("session.started"));

  await call(niwa, "session.resume", { session });
  expect(Object.keys(control.resumes[0] ?? {})).not.toContain("claude");
});

test("a kind registry carries the options each kind declares to the sessions plugin", async () => {
  const control = new RecordingControl();
  const kinds = new HarnessKindRegistry();
  kinds.register(defineHarnessKind({ name: "claude-code", control, options: KIND_OPTIONS.claude }));
  const harnesses = new HarnessInstanceRegistry();
  harnesses.register(installation("claude-code"));
  const { niwa } = await serve({ harnesses, kinds });

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", claude: { advisor: false } });
  expect(control.starts[0]?.claude).toEqual({ advisor: false });
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
  expect(control.starts[0]?.claude).toEqual({ advisor: false });
  // Every block is a flag the command knows; one no kind declares is not.
  expect(() => inputOf(description, ["--codex", "{}", "--ncode", "{}", "--mcode", "{}", "--pi", "{}", "--zcode", "{}"])).not.toThrow();
  expect(() => inputOf(description, ["--gemini", "{}"])).toThrow(/has no field "gemini"/);
});

test("a question over the session is asked with the options the session was started with", async () => {
  const control = new RecordingControl();
  const { niwa, records } = await serve([claude(control)]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "", claude: { advisor: false } });
  const plain = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "" });
  await until(() => records.filter((entry) => entry.type === "session.started").length === 2);

  await call(niwa, "session.ask", { session, prompt: "word?", schema: { type: "string" } });
  await call(niwa, "session.ask", { session: plain.session, prompt: "word?", schema: { type: "string" } });
  expect(control.asks[0]?.claude).toEqual({ advisor: false });
  expect(Object.keys(control.asks[1] ?? {})).not.toContain("claude");
});

test("every kind niwa serves declares the block named after it", () => {
  const blocks = [
    claudeCode().options?.block,
    claudeSdkKind().options?.block,
    codex().options?.block,
    mcode().options?.block,
    ncode().options?.block,
    pi({ harness: harnessId("pi"), sessionsRoot: "/tmp/niwa-options-pi" }).options?.block,
    zcode().options?.block,
  ];
  expect(blocks).toEqual(["claude", "claude", "codex", "mcode", "ncode", "pi", "zcode"]);
});
