// The session control side against a fake harness, driven through the public actions.
//
// The fake is a real implementation of the control interface: it names the sessions it starts,
// queues what is sent to a busy session, and reports signs of life when told a turn happened.

import { afterEach, expect, test } from "bun:test";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { QuestionSchema, ValidationError, actionName, record, seq, owner } from "@niwa-labs/core";
import { connect, token } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import type { Plugin } from "@niwa-labs/plugin";
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
  SessionMode,
} from "@niwa-labs/harness";
import {
  ProtocolNameSchema,
  VariantNameSchema,
  harnessId,
  harnessKind,
  machineId,
  modelName,
  sessionId,
} from "@niwa-labs/harness";
import { QuestionName, REQUEST_CANCEL, RequestAnswered, RequestCreated, requests } from "@niwa-labs/requests";
import { SUBMIT_ANSWER_ACTION, SessionTurnEnded, sessions } from "@niwa-labs/sessions";
import { eventually, tempHome, pick, requestIdOf } from "@niwa-labs/testing";
import { catalogOf } from "@niwa-labs/mcp";
import { mcpPair } from "./fixtures/mcp-pair.ts";
import { z } from "zod";

const HARNESS = "fake-harness";
const SESSION = `${HARNESS} session-1`;
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

/** The fake control side. */
class FakeControl implements SessionControl {
  readonly starts: StartOptions[] = [];
  readonly resumes: (ResumeOptions | undefined)[] = [];
  readonly interrupted: string[] = [];
  readonly asks: AskOptions<unknown>[] = [];
  /** What was sent into a session, as it was sent. */
  readonly sent: string[] = [];
  /** What a native ask answers with. */
  nativeAnswer: unknown = undefined;
  private busy = false;
  private turn = 0;
  private readonly lifeQueue: LifeEvent[] = [];
  private lifeWake: (() => void) | undefined;
  lifeStreams = 0;
  private lifeOver = false;

  /**
   * Whether the prompt of a start becomes a first turn that runs on after the start returned, as
   * a real side does; its start sign is kept for the first stream of life.
   */
  firstTurn = false;

  /** The name the harness gives the next session it starts. */
  named = "session-1";

  /**
   * While set, a start waits for it after the harness has named the session: the host is cut off
   * with a session made and its receipt not yet recorded.
   */
  startHold: Promise<void> | undefined;

  async start(options: StartOptions): Promise<StartedSession> {
    this.starts.push(options);
    const session = sessionId(harnessId(HARNESS), this.named);
    await this.startHold;
    if (!this.firstTurn) return { session };
    this.busy = true;
    this.turn += 1;
    this.lifeQueue.push({ kind: "turn-started", turn: this.turn });
    return { session, first: { status: "started", turn: this.turn } };
  }

  async resume(_id: SessionId, options?: ResumeOptions): Promise<void> {
    this.resumes.push(options);
    // A process that is launched again counts its turns from 1.
    if (this.gone) {
      this.gone = false;
      this.turn = 0;
    }
  }

  async send(_id: SessionId, message: string): Promise<DeliveryReceipt> {
    this.sent.push(message);
    if (this.busy) return { status: "queued" };
    this.busy = true;
    this.turn += 1;
    return { status: "started", turn: this.turn };
  }

  endTurn(): void {
    this.busy = false;
  }

  async interrupt(id: SessionId): Promise<void> {
    this.interrupted.push(id.native);
  }

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    this.asks.push(options as AskOptions<unknown>);
    return { session: id, value: this.nativeAnswer as T, at: Date.now() as never };
  }

  /** The signs of life are what the test pushes; the stream stays open. */
  async *life(): AsyncIterable<LifeEvent> {
    this.lifeStreams += 1;
    for (;;) {
      const next = this.lifeQueue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.lifeOver) return;
      await new Promise<void>((wake) => {
        this.lifeWake = wake;
      });
    }
  }

  /** The session is over: the stream of life ends. */
  endLife(): void {
    this.lifeOver = true;
    this.lifeWake?.();
  }

  async dispose(): Promise<void> {
    this.endLife();
  }

  pushLife(event: LifeEvent): void {
    this.lifeQueue.push(event);
    this.lifeWake?.();
  }

  /** Whether the process of the session is gone, as after a restart. */
  gone = false;

  async state(): Promise<SessionState> {
    return this.gone ? "unknown" : "idle";
  }
}

function installation(abilities: { interrupt?: boolean; structuredOutput?: boolean; launch?: { model: boolean; effort: string[]; modes: SessionMode[] } } = {}): Harness {
  return {
    id: harnessId(HARNESS),
    kind: harnessKind("fake-kind"),
    machine: machineId("machine-1"),
    home: "/tmp/fake-home",
    sides: {
      control: {
        start: true,
        resume: true,
        send: true,
        interrupt: abilities.interrupt ?? false,
        ask: true,
        structuredOutput: abilities.structuredOutput ?? false,
        launch: abilities.launch ?? { model: false, effort: [], modes: [] },
      },
    },
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

/**
 * The record the asker writes when it has the answer.
 *
 * It says that the answer arrived and what it was: the asker is the only one who knows it.
 */
const Answered = record("session-ask.answered", z.object({ answer: z.unknown() }));

/** A record that has nothing to do with questions. */
const Other = record("session-ask.other", z.object({}));

/** The record that starts the ask. */
const Ask = record("session-ask.ask", z.object({}));

/** The action the asker calls: the sessions module serves it. */
const SESSION_ASK: ActionName = actionName("session.ask");

/**
 * The asker: a tiny plugin whose handler asks a session and writes down what it was told.
 *
 * The ask happens inside an invocation, so the wait for the answer is durable: the request
 * that waits is in the journal, not in the memory of the process.
 */
function asker(session: string): Plugin {
  return plugin("session-asker", (api) => {
    api.declare(Ask, Answered, Other);
    api.on(Ask, { concurrency: Number.POSITIVE_INFINITY }, async (_data, step) => {
      const answer = await step<unknown, { value: unknown }>(SESSION_ASK, {
        session,
        prompt: "good?",
        schema: SCHEMA,
      });
      await step.emit(Answered, { answer: answer.value });
    });
  });
}

/** A served host with the sessions plugin over the fake, and what it has written so far. */
async function serve(
  control: FakeControl,
  harness: Harness,
  options: {
    niwaMcp?: { command: string; args: readonly string[] };
    /** A plugin installed beside the sessions one, as the asker of the rq-2 test. */
    with?: Plugin | Plugin[];
    /** The home of a host that was stopped: the new host starts from its journal. */
    home?: string;
    /** Bind a session's own client to its session address, as a composition that wants sessions held to their questions does. */
    sessionBinding?: boolean;
  } = {},
): Promise<{ niwa: Host; records: StoredRecord[]; home: string; stop: () => Promise<void> }> {
  const fresh = options.home === undefined ? await tempHome() : undefined;
  const homePath = options.home ?? fresh?.path ?? "";
  const niwa = createNiwa({ home: homePath });
  // The requests module is here: a non-native ask is a request, and the requests module is
  // what serves it.
  const made = sessions({ harnesses: [{ instance: harness, control }], niwaMcp: options.niwaMcp });
  niwa.use(requests({ bind: options.sessionBinding === true ? made.bind() : () => owner }));
  niwa.use(made);
  for (const extra of [options.with ?? []].flat()) niwa.use(extra);
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
  return { niwa, records, home: homePath, stop };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> =>
  niwa.call(name as ActionName, input) as Promise<O>;

const typesOf = (records: StoredRecord[]): string[] =>
  records.map((record) => record.type).filter((type) => type.startsWith("session."));

test("start returns the name the harness gave, as one volatile section, with the visible set at start", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation(), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });

  const started = await call<{ session: string; ref: string }>(niwa, "session.start", {
    harness: HARNESS,
    prompt: "do the thing",
    visible: { actions: ["session.send"], disabledTools: ["Bash"] },
  });
  // The start returns the id niwa gave the session, and the pair the harness named.
  expect(started.session).toMatch(/^s-[0-9a-f]{6,8}$/);
  expect(started.ref).toBe(SESSION);

  const options = control.starts[0];
  expect(options?.prompt.sections).toEqual([{ id: "prompt", tier: "volatile", text: "do the thing" }]);
  // The action that answers a question is among the ones the session sees: this harness
  // cannot answer natively, so the session answers the questions itself.
  expect(options?.visible).toEqual({ actions: ["session.send", SUBMIT_ANSWER_ACTION], disabledTools: ["Bash"] });

  await eventually(() => typesOf(records).includes("session.started"));
  const record = records.find((entry) => entry.type === "session.started");
  expect(record?.data).toEqual({ session: SESSION, id: started.session });
  // A session that was given no visible actions sees none.
  await call(niwa, "session.start", { harness: HARNESS, prompt: "again" });
  expect(control.starts[1]?.visible).toEqual({ actions: [], disabledTools: [] });
});

test("a session is named by the id niwa gave it: whole, by its start or its end, and never by a text that fits two", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation({ interrupt: true, structuredOutput: true }));
  const first = await call<{ session: string; ref: string }>(niwa, "session.start", { harness: HARNESS, prompt: "" });
  control.named = "session-2";
  const second = await call<{ session: string; ref: string }>(niwa, "session.start", { harness: HARNESS, prompt: "" });
  expect(first.session).toMatch(/^s-[0-9a-f]{6,8}$/);
  expect(second.ref).toBe(`${HARNESS} session-2`);
  expect(second.session).not.toBe(first.session);

  // The caller never passes the pair: the id, its start or its end reach the same session.
  await call(niwa, "session.send", { session: first.session, message: "whole" });
  await call(niwa, "session.send", { session: first.session.slice(0, 6), message: "start" });
  await call(niwa, "session.send", { session: first.session.slice(-4), message: "end" });
  expect(control.sent).toEqual(["whole", "start", "end"]);
  await call(niwa, "session.interrupt", { session: second.session.slice(0, 5) });
  expect(control.interrupted).toEqual(["session-2"]);
  await call(niwa, "session.resume", { session: second.session });
  expect(control.resumes).toHaveLength(1);
  control.nativeAnswer = { answer: "yes" };
  const asked = await call<{ value: unknown }>(niwa, "session.ask", {
    session: first.session,
    prompt: "well?",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  });
  expect(asked.value).toEqual({ answer: "yes" });
  // The pair still names a session, for one niwa did not start.
  await call(niwa, "session.send", { session: { harness: HARNESS, native: "session-2" }, message: "pair" });
  expect(control.sent.at(-1)).toBe("pair");

  // A text that fits both is refused with the candidates; one that fits none is unknown.
  await expect(call(niwa, "session.send", { session: "s-", message: "x" })).rejects.toThrow(first.session);
  await expect(call(niwa, "session.send", { session: "s-zzzzzz", message: "x" })).rejects.toThrow('no session "s-zzzzzz"');

  // `session.list` and `session.get` give the id back, with the pair.
  const listed = await call<{ sessions: { id?: string; ref: string }[] }>(niwa, "session.list", {});
  // The list is ordered by recency, which two starts in one millisecond do not fix: compare as a set.
  expect(listed.sessions.map((entry) => [entry.id, entry.ref]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
    [first.session, first.ref],
    [second.session, second.ref],
  ]);
  await call(niwa, "session.belong", { session: first.session.slice(0, 6), to: owner, source: "explicit" });
  const got = await call<{ id: string; ref: string; belongings: unknown[] }>(niwa, "session.get", { id: first.session.slice(-5) });
  expect(got).toMatchObject({ id: first.session, ref: first.ref, belongings: [{ session: first.ref, to: owner, source: "explicit" }] });
  await expect(call(niwa, "session.get", { id: `${HARNESS} elsewhere` })).rejects.toThrow("no session");
});

test("a model and an effort reach the harness at the start, and the session records its effort but not its model", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ launch: { model: true, effort: ["low", "high"], modes: [] } }));

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", model: "gpt-6-luna", effort: "high" });

  expect(control.starts[0]).toMatchObject({ model: "gpt-6-luna", effort: "high" });
  await eventually(() => typesOf(records).includes("session.started"));
  // The alias is the request of the start call: the session has one model, the one the harness names.
  expect(records.find((entry) => entry.type === "session.started")?.data).toEqual({ session: SESSION, id: expect.stringMatching(/^s-/), effort: "high" });
  expect(typesOf(records)).not.toContain("session.model");
});

test("the model the harness names is written as its own record, the session lists it, and a resume pins it", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ launch: { model: true, effort: [], modes: [] } }));
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", model: "luna" });

  // Until the harness names it the model of the session is unknown, and a resume pins nothing.
  const unknown = await call<{ sessions: Array<{ ref: string; model?: string }> }>(niwa, "session.list", {});
  expect(unknown.sessions.find((entry) => entry.ref === SESSION)?.model).toBeUndefined();
  await call(niwa, "session.resume", { session: SESSION });
  expect(control.resumes[0]?.model).toBeUndefined();

  control.pushLife({ kind: "model", model: modelName("gpt-6-real") });
  await eventually(() => typesOf(records).includes("session.model"));
  expect(records.find((entry) => entry.type === "session.model")?.data).toEqual({ session: SESSION, model: "gpt-6-real" });
  const listed = await call<{ sessions: Array<{ ref: string; model?: string }> }>(niwa, "session.list", {});
  expect(listed.sessions.find((entry) => entry.ref === SESSION)?.model).toBe("gpt-6-real");
  await call(niwa, "session.resume", { session: SESSION });
  expect(control.resumes[1]?.model).toBe(modelName("gpt-6-real"));

  // The same name said again is no new fact; a different one is, and it is the latest that counts.
  control.pushLife({ kind: "model", model: modelName("gpt-6-real") });
  control.pushLife({ kind: "model", model: modelName("gpt-6-better") });
  await eventually(() => typesOf(records).filter((type) => type === "session.model").length === 2);
  await call(niwa, "session.resume", { session: SESSION });
  expect(control.resumes[2]?.model).toBe(modelName("gpt-6-better"));
  expect(typesOf(records).filter((type) => type === "session.model")).toHaveLength(2);
});

test("a resume names the directory the session was started in", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: "/somewhere/else" });
  await eventually(() => control.starts.length === 1);
  control.gone = true;
  await call(niwa, "session.resume", { session: SESSION });
  expect(control.resumes[0]?.cwd).toBe("/somewhere/else");
});

test("a mode reaches the harness at the start, the mode the harness applied is written down, and a resume names it again", async () => {
  const control = new FakeControl();
  const reported = control.start.bind(control);
  // The default is the control side's to apply: it says which mode the session really has.
  control.start = async (options) => ({ ...(await reported(options)), mode: options.mode ?? "auto" });
  const { niwa, records } = await serve(control, installation({ launch: { model: false, effort: [], modes: ["ask", "auto"] } }));

  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", mode: "ask" });
  expect(control.starts[0]?.mode).toBe("ask");
  await eventually(() => typesOf(records).includes("session.started"));
  expect(records.find((entry) => entry.type === "session.started")?.data).toMatchObject({ session: SESSION, mode: "ask" });

  await call(niwa, "session.resume", { session: SESSION });
  expect(control.resumes[0]?.mode).toBe("ask");

  // None asked for: the record carries the mode the harness applied, not a blank.
  const unasked = new FakeControl();
  const reportedUnasked = unasked.start.bind(unasked);
  unasked.start = async (options) => ({ ...(await reportedUnasked(options)), mode: "auto" });
  const second = await serve(unasked, installation({ launch: { model: false, effort: [], modes: ["ask", "auto"] } }));
  await call(second.niwa, "session.start", { harness: HARNESS, prompt: "go" });
  expect(unasked.starts[0]?.mode).toBeUndefined();
  await eventually(() => typesOf(second.records).includes("session.started"));
  expect(second.records.find((entry) => entry.type === "session.started")?.data).toMatchObject({ mode: "auto" });
});

test("a mode the kind does not have is refused before the start, naming the modes it has", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation({ launch: { model: false, effort: [], modes: ["ask", "full"] } }));
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "go", mode: "auto" })).rejects.toThrow(
    /the mode "auto" is not one of ask, full/,
  );
  expect(control.starts).toEqual([]);

  const none = await serve(control, installation());
  await expect(call(none.niwa, "session.start", { harness: HARNESS, prompt: "go", mode: "full" })).rejects.toThrow(
    /it has no working modes \(asked for "full"\)/,
  );
  expect(control.starts).toEqual([]);
});

test("a model or an effort the kind cannot apply is refused before the start, saying what the kind supports", async () => {
  const control = new FakeControl();
  const taking = await serve(control, installation({ launch: { model: true, effort: ["low", "high"], modes: [] } }));
  await expect(call(taking.niwa, "session.start", { harness: HARNESS, prompt: "go", effort: "max" })).rejects.toThrow(
    /effort "max" is not one of low, high/,
  );

  const refusing = await serve(control, installation());
  await expect(call(refusing.niwa, "session.start", { harness: HARNESS, prompt: "go", effort: "low" })).rejects.toThrow(
    /it accepts no effort \(asked for "low"\)/,
  );
  await expect(call(refusing.niwa, "session.start", { harness: HARNESS, prompt: "go", model: "x" })).rejects.toThrow(
    /it cannot choose a model per session \(asked for "x"\)/,
  );
  expect(control.starts).toEqual([]);
});

test("a prompt of sections keeps them, and two sections with one id are refused", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation());
  const sections = [
    { id: "rules", tier: "constant" as const, text: "be brief" },
    { id: "task", tier: "stable" as const, text: "fix it" },
  ];
  await call(niwa, "session.start", { harness: HARNESS, prompt: { sections } });
  expect(control.starts[0]?.prompt.sections).toEqual(sections);

  await expect(
    call(niwa, "session.start", { harness: HARNESS, prompt: { sections: [sections[0], sections[0]] } }),
  ).rejects.toThrow('the prompt has two sections with the id "rules"');
  expect(control.starts.length).toBe(1);
});

test("the tools listing still gives a valid object input schema for the actions that take a prompt", async () => {
  const { niwa } = await serve(new FakeControl(), installation());
  const catalog = catalogOf(await niwa.describe());
  for (const name of ["session_start", "session_send", "session_ask"]) {
    const tool = catalog.tools.find((found) => found.name === name);
    expect(tool).toBeDefined();
    const input = tool?.inputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {}).length).toBeGreaterThan(0);
  }
  const start = catalog.tools.find((found) => found.name === "session_start")?.inputSchema as {
    properties: { prompt: { anyOf: Array<{ type: string }> } };
  };
  expect(start.properties.prompt.anyOf.map((branch) => branch.type).sort()).toEqual(["object", "string"]);
});

test("a message to a busy session is queued, to an idle one it starts a turn, and nothing is interrupted", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation());
  const send = (message: string) => call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session: SESSION, message });

  expect((await send("one")).receipt).toEqual({ status: "started", turn: 1 });
  expect((await send("two")).receipt).toEqual({ status: "queued" });
  control.endTurn();
  expect((await send("three")).receipt).toEqual({ status: "started", turn: 2 });
  expect(control.interrupted).toEqual([]);
});

test("an interrupt is refused where it is not declared, and made where it is", async () => {
  const blind = new FakeControl();
  const first = await serve(blind, installation({ interrupt: false }));
  await expect(call(first.niwa, "session.interrupt", { session: SESSION })).rejects.toThrow("interrupt");
  expect(blind.interrupted).toEqual([]);

  const able = new FakeControl();
  const second = await serve(able, installation({ interrupt: true }));
  await call(second.niwa, "session.interrupt", { session: SESSION });
  expect(able.interrupted).toEqual(["session-1"]);
});

test("a native ask returns the value that passed the schema and refuses one that did not", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation({ structuredOutput: true }));
  const ask = () => call<{ value: unknown }>(niwa, "session.ask", { session: SESSION, prompt: "good?", schema: SCHEMA });

  control.nativeAnswer = { answer: "yes" };
  expect((await ask()).value).toEqual({ answer: "yes" });
  // A native ask is not given a question id: there is nothing to submit.
  expect(control.asks[0]?.question).toBeUndefined();

  control.nativeAnswer = { answer: 42 };
  await expect(ask()).rejects.toBeInstanceOf(ValidationError);
});

test("without structured output the session submits the answer by the request id", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;

  // An answer that does not pass the schema is refused, and the request stays open.
  await expect(call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: 42 } })).rejects.toThrow(
    "not valid",
  );
  // Text that is not JSON, or JSON that does not pass, is refused the same way.
  await expect(call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: "yes" })).rejects.toThrow("not valid");
  await expect(call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: '{"answer":42}' })).rejects.toThrow(
    "not valid",
  );
  // A tool layer that passes the answer as JSON text: the text is read as the JSON it holds.
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: '{"answer":"yes"}' })).toEqual({
    accepted: true,
  });

  // A request is answered once: a second answer writes nothing.
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "no" } })).toEqual({
    accepted: false,
  });
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });
  await eventually(
    () => records.filter((record) => record.type === "request.answered").length === 1,
    10_000,
    "the request was answered twice",
  );
});

test("submit-answer inside an invocation records the refusal as given, then the answer read as JSON text", async () => {
  const control = new FakeControl();
  const Submit = record("session-ask.submit", z.object({ request: z.string(), value: z.string() }));
  const Submitted = record("session-ask.submitted", z.object({ accepted: z.boolean() }));
  const submitter = plugin("session-submitter", (api) => {
    api.declare(Submit, Submitted);
    api.on(Submit, async (data, step) => {
      const result = await step<unknown, { accepted: boolean }>(actionName(SUBMIT_ANSWER_ACTION), {
        question: data.request,
        value: data.value,
      });
      await step.emit(Submitted, { accepted: result.accepted });
    });
  });
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: [asker(SESSION), submitter],
  });

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const request = ((records.find((record) => record.type === RequestCreated.name))?.data as { id: string }).id;

  await niwa.emit(Submit, { request, value: '{"answer":"yes"}' });
  await eventually(() => records.some((record) => record.type === Submitted.name), 10_000, "not submitted");
  expect(records.find((record) => record.type === Submitted.name)?.data).toEqual({ accepted: true });

  // The step as given is recorded as failed, the step as read as completed: a replay returns both.
  const outcomes = records
    .filter((record) => record.type === "niwa.step.outcome")
    .map((record) => record.data as { invocation: string; key: string; outcome: { status: string } })
    .filter((data) => data.invocation.startsWith("inv:session-submitter") && data.key.includes(".step-"));
  expect(outcomes.map((data) => data.outcome.status)).toEqual(["failed", "completed"]);
});

test("an answer that passes as given is not read as JSON text, and one refused both ways says both", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });
  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const request = ((records.find((record) => record.type === RequestCreated.name))?.data as { id: string }).id;

  const refused = await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: '{"answer":42}' }).then(
    () => "",
    (error: Error) => error.message,
  );
  expect(refused).toContain("not valid");
  expect(refused).toContain("read as the JSON it holds");
});

test("submit-answer takes the plain value of a choice, a multi and a text, and the JSON text of it", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }));
  const asked = async (name: string, input: unknown): Promise<string> => {
    await niwa.emit(RequestCreated, {
      id: requestIdOf(name),
      to: owner,
      question: QuestionName.parse(`plain.${name}`),
      input: QuestionSchema.parse(input),
    });
    return requestIdOf(name);
  };
  const options = ["a", "b", "c"].map((id) => ({ id, label: id, flavor: "plain" }));
  const multi = await asked("multi", { kind: "multi", title: "some", options });
  const choice = await asked("choice", { kind: "choice", title: "one", options });
  const text = await asked("text", { kind: "text", title: "say" });

  // A multi given as the text of a JSON list: the list is read, and the question decides.
  await expect(call(niwa, SUBMIT_ANSWER_ACTION, { question: multi, value: '["a","zzz"]' })).rejects.toThrow("not valid");
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: multi, value: '["a","c"]' })).toEqual({ accepted: true });
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: choice, value: "b" })).toEqual({ accepted: true });
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: text, value: "hello" })).toEqual({ accepted: true });

  const answered = records
    .filter((record) => record.type === RequestAnswered.name)
    .map((record) => RequestAnswered.schema.parse(record.data));
  expect(answered.map((data) => data.answer)).toEqual([pick("a", "c"), pick("b"), { text: "hello" }]);
});

test("an answer that came before the request was answered is not lost", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;

  // The answer comes first, the request is answered by it, and the ask goes on.
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "early" } })).toEqual({
    accepted: true,
  });
  await eventually(
    () => records.some((record) => record.type === Answered.name),
    10_000,
    "the ask did not go on",
  );
  const answered = records.find((record) => record.type === Answered.name);
  expect(answered?.data).toEqual({ answer: { answer: "early" } });
});

test("an answer to a request that was cancelled is not accepted and writes nothing", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;

  await call(niwa, REQUEST_CANCEL, { id: request, reason: "not now" });
  await eventually(() => records.some((record) => record.type === "request.cancelled"), 10_000, "not cancelled");

  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "late" } })).toEqual({
    accepted: false,
  });
  expect(records.filter((record) => record.type === "request.answered")).toHaveLength(0);
});

test("signs of life become session records, once per session, saying only that they happened", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  // Resuming a session that is already followed does not start a second stream of records.
  await call(niwa, "session.resume", { session: SESSION });
  expect(control.lifeStreams).toBe(1);

  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({ kind: "activity", at: 5, detail: "read a file" });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => typesOf(records).includes("session.turn-ended"));

  expect(typesOf(records)).toEqual([
    "session.start.reserved",
    "session.started",
    "session.marked",
    "session.input.sending",
    "session.marked",
    "session.turn-started",
    "session.activity",
    "session.turn-ended",
  ]);
  const activity = records.find((record) => record.type === "session.activity");
  // What the harness said in words is not recorded: only a tool name is.
  expect(activity?.data).toEqual({ session: SESSION });
  const turn = records.find((record) => record.type === "session.turn-started");
  expect(turn?.data).toEqual({ session: SESSION, turn: 1 });
});

test("a turn that the harness says failed is recorded as failed, one it says nothing of as completed", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  for (const [turn, outcome] of [[1, "failed"], [2, undefined], [3, "unknown"], [4, "completed"]] as const) {
    control.pushLife({ kind: "turn-started", turn });
    control.pushLife({ kind: "turn-ended", turn, ...(outcome === undefined ? {} : { outcome }) });
  }
  await eventually(() => turnNumbers(records, "session.turn-ended").length === 4);

  expect(endings(records)).toEqual(["failed", "completed", "unknown", "completed"]);
});

test("a burst of signs of life is one activity record, and a new turn says it again", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  for (let at = 0; at < 20; at += 1) control.pushLife({ kind: "activity", at, detail: "work" });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  control.pushLife({ kind: "turn-started", turn: 2 });
  control.pushLife({ kind: "activity", at: 99, detail: "work" });
  control.pushLife({ kind: "turn-ended", turn: 2 });
  await eventually(() => typesOf(records).filter((type) => type === "session.turn-ended").length === 2);

  expect(typesOf(records).filter((type) => type === "session.activity")).toHaveLength(2);
});

/** The numbers of the turns of a kind of turn record, in the order they were written. */
const turnNumbers = (records: StoredRecord[], type: "session.turn-started" | "session.turn-ended"): number[] =>
  records.filter((record) => record.type === type).map((record) => (record.data as { turn: number }).turn);

/** How the turns ended, in the order they ended. */
const endings = (records: StoredRecord[]): Array<string | undefined> =>
  records.filter((record) => record.type === "session.turn-ended").map((record) => (record.data as { how?: string }).how);

/** Three turns of a started session, sent and run to their end. */
async function threeTurns(control: FakeControl, niwa: Host, records: StoredRecord[]): Promise<void> {
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  for (const turn of [1, 2, 3]) {
    const sent = await call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session: SESSION, message: `turn ${turn}` });
    expect(sent.receipt).toEqual({ status: "started", turn });
    control.pushLife({ kind: "turn-started", turn });
    control.pushLife({ kind: "turn-ended", turn });
    control.endTurn();
    await eventually(() => turnNumbers(records, "session.turn-ended").length === turn);
  }
}

test("a turn ended record that has no how, as written before niwa said how, still reads, as a completed turn", () => {
  const old = SessionTurnEnded.schema.safeParse({ session: SESSION, turn: 1 });
  expect(old.success).toBe(true);
  expect(SessionTurnEnded.schema.safeParse({ session: SESSION, turn: 1, how: "interrupted" }).success).toBe(true);
});

test("a resume after the process is gone goes on numbering the turns, in the records and in the receipt of a send", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await threeTurns(control, niwa, records);

  control.gone = true;
  await call(niwa, "session.resume", { session: SESSION });
  // The harness counts this turn as its first: the receipt names it as the records will.
  const sent = await call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session: SESSION, message: "again" });
  expect(sent.receipt).toEqual({ status: "started", turn: 4 });
  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => turnNumbers(records, "session.turn-ended").length === 4);
  expect(turnNumbers(records, "session.turn-started")).toEqual([1, 2, 3, 4]);
  expect(turnNumbers(records, "session.turn-ended")).toEqual([1, 2, 3, 4]);
});

test("a resume of a process that is still running keeps the numbers the harness gives", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await threeTurns(control, niwa, records);

  await call(niwa, "session.resume", { session: SESSION });
  const sent = await call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session: SESSION, message: "again" });
  expect(sent.receipt).toEqual({ status: "started", turn: 4 });
  control.pushLife({ kind: "turn-started", turn: 4 });
  await eventually(() => turnNumbers(records, "session.turn-started").length === 4);
  expect(turnNumbers(records, "session.turn-started")).toEqual([1, 2, 3, 4]);
});

test("a restarted host goes on from the journal: the turns of a resumed session follow its last, and another session's do not count", async () => {
  const first = new FakeControl();
  const host = await serve(first, installation());
  await threeTurns(first, host.niwa, host.records);
  await host.stop();

  const control = new FakeControl();
  control.gone = true;
  const reopened = await serve(control, installation(), { home: host.home });
  await call(reopened.niwa, "session.resume", { session: SESSION });
  const sent = await call<{ receipt: DeliveryReceipt }>(reopened.niwa, "session.send", { session: SESSION, message: "again" });
  expect(sent.receipt).toEqual({ status: "started", turn: 4 });
  control.pushLife({ kind: "turn-started", turn: 1 });
  await eventually(() => turnNumbers(reopened.records, "session.turn-started").includes(4));

  // A session of its own starts from its own first turn, whatever another has written.
  control.named = "session-2";
  await call(reopened.niwa, "session.start", { harness: HARNESS, prompt: "go" });
  const before = turnNumbers(reopened.records, "session.turn-started").length;
  control.pushLife({ kind: "turn-started", turn: 1 });
  await eventually(() => turnNumbers(reopened.records, "session.turn-started").length === before + 1);
  expect(turnNumbers(reopened.records, "session.turn-started").at(-1)).toBe(1);
});

test("a harness that begins counting again without being resumed still gets a turn after the last one written", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  for (const turn of [1, 2, 3, 2]) {
    control.pushLife({ kind: "turn-started", turn });
    control.pushLife({ kind: "turn-ended", turn });
  }
  await eventually(() => turnNumbers(records, "session.turn-ended").length === 4);
  expect(turnNumbers(records, "session.turn-started")).toEqual([1, 2, 3, 4]);
  expect(turnNumbers(records, "session.turn-ended")).toEqual([1, 2, 3, 4]);
});

test("a turn that niwa interrupted ends as interrupted, and the interrupt does not reach the turn after it", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ interrupt: true }));
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  await eventually(() => turnNumbers(records, "session.turn-started").length === 1);
  await call(niwa, "session.interrupt", { session: SESSION });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  control.pushLife({ kind: "turn-started", turn: 2 });
  control.pushLife({ kind: "turn-ended", turn: 2 });
  await eventually(() => turnNumbers(records, "session.turn-ended").length === 2);
  expect(endings(records)).toEqual(["interrupted", "completed"]);
});

test("an interrupt that ended no turn does not make the next turn end as interrupted", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ interrupt: true }));
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  // Nothing runs: the interrupt ends no turn.
  await call(niwa, "session.interrupt", { session: SESSION });
  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => turnNumbers(records, "session.turn-ended").length === 1);
  expect(endings(records)).toEqual(["completed"]);
});

test("the throttled activity record keeps the latest tool name of its window", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({ kind: "activity", at: 1, detail: "tool_use:Read", tool: "Read" });
  control.pushLife({ kind: "activity", at: 2, detail: "tool_use:Edit", tool: "Edit" });
  control.pushLife({ kind: "activity", at: 3, detail: "tool_use:Bash", tool: "Bash" });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  control.pushLife({ kind: "turn-started", turn: 2 });
  control.pushLife({ kind: "activity", at: 4, detail: "tool_use:Grep", tool: "Grep" });
  control.pushLife({ kind: "turn-ended", turn: 2 });
  await eventually(() => typesOf(records).filter((type) => type === "session.turn-ended").length === 2);

  const tools = records.filter((record) => record.type === "session.activity").map((record) => (record.data as { tool?: string }).tool);
  expect(tools).toEqual(["Read", "Grep"]);
});

test("a tool name that is not a short identifier is dropped from the activity record", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  // Each turn opens a window: its first activity is the record.
  const names = ["ran: cat /etc/passwd", "x".repeat(65), "", "mcp__niwa__session.send"];
  for (const [index, tool] of names.entries()) {
    control.pushLife({ kind: "turn-started", turn: index + 1 });
    control.pushLife({ kind: "activity", at: index + 1, detail: "work", tool });
    control.pushLife({ kind: "turn-ended", turn: index + 1 });
  }
  await eventually(() => typesOf(records).filter((type) => type === "session.turn-ended").length === names.length);

  expect(records.filter((record) => record.type === "session.activity").map((record) => record.data)).toEqual([
    { session: SESSION },
    { session: SESSION },
    { session: SESSION },
    { session: SESSION, tool: "mcp__niwa__session.send" },
  ]);
});

test("a decision the harness made on a tool call rides the throttled activity record, the latest one of the window, without its free-text reason", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({
    kind: "activity",
    at: 1,
    detail: "tool_call",
    permission: { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto" },
  });
  // The window is open: these are not records, but the latest decision among them is kept for the next one.
  control.pushLife({ kind: "activity", at: 2, detail: "tool_call", permission: { decision: "deny", decidedBy: "rule", ruleKind: "builtin", mode: "default" } });
  control.pushLife({ kind: "activity", at: 3, detail: "tool_call", permission: { decision: "allow", decidedBy: "hook", ruleKind: null, mode: "default" } });
  control.pushLife({ kind: "activity", at: 4, detail: "tool_call_update" });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => typesOf(records).includes("session.turn-ended"));

  const activity = records.filter((record) => record.type === "session.activity").map((record) => record.data);
  expect(activity).toEqual([
    { session: SESSION, permission: { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto" } },
  ]);
});

test("the reason of a permission mark is not recorded", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  control.pushLife({
    kind: "activity",
    at: 1,
    detail: "tool_call",
    permission: { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto", reason: "read only" } as never,
  });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => typesOf(records).includes("session.turn-ended"));

  const activity = records.filter((record) => record.type === "session.activity").map((record) => record.data);
  expect(activity).toEqual([{ session: SESSION, permission: { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto" } }]);
});

test("a message of the harness that niwa's protocol snapshot does not know is a record of its own, with the message as it came", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });

  control.pushLife({ kind: "turn-started", turn: 1 });
  const raw = { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "brand_new" } } };
  const protocol = ProtocolNameSchema.parse("acp-1.3.0/mcode");
  const variant = VariantNameSchema.parse("session/update brand_new");
  control.pushLife({ kind: "unknown-variant", at: 1, protocol, variant, raw });
  control.pushLife({ kind: "unknown-variant", at: 2, protocol, variant, raw });
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => typesOf(records).includes("session.turn-ended"));

  // Back to back, the same variant is one record: the first message of it is the one worth reading.
  const unknown = records.filter((record) => record.type === "session.unknown-variant").map((record) => record.data);
  expect(unknown).toEqual([{ session: SESSION, protocol: "acp-1.3.0/mcode", variant: "session/update brand_new", raw }]);
});

test("the start returns with the receipt of its first turn, and the signs of that turn become records", async () => {
  const control = new FakeControl();
  control.firstTurn = true;
  const { niwa, records } = await serve(control, installation());
  // The start does not wait for the first turn: it returns while that turn runs, and says so.
  const started = await call<{ session: string; ref: string; receipt?: unknown; operation: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  expect(started).toEqual({ session: expect.stringMatching(/^s-/), ref: SESSION, receipt: { status: "started", turn: 1 }, operation: expect.any(String) });

  // The turn began before the stream of life was opened, and its end comes after: both are
  // written, after the record that the session started.
  control.pushLife({ kind: "turn-ended", turn: 1 });
  await eventually(() => typesOf(records).includes("session.turn-ended"));
  expect(typesOf(records)).toEqual([
    "session.start.reserved",
    "session.started",
    "session.marked",
    "session.input.sending",
    "session.input.settled",
    "session.turn-started",
    "session.turn-ended",
  ]);
});

test("a session the control side reports as over is written as ended, and so is one that was stopped with the host", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation());
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  control.endLife();
  await eventually(() => typesOf(records).includes("session.ended"));
  expect(records.find((record) => record.type === "session.ended")?.data).toMatchObject({ session: SESSION });

  const second = new FakeControl();
  const host = await serve(second, installation());
  await call(host.niwa, "session.start", { harness: HARNESS, prompt: "go" });
  await host.stop();
  const reopened = await serve(new FakeControl(), installation(), { home: host.home });
  await eventually(() => typesOf(reopened.records).includes("session.ended"));
});

test("a session that may see niwa actions is given the niwa MCP server, and one that may not is given none", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation(), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });

  await call(niwa, "session.start", {
    harness: HARNESS,
    prompt: "go",
    visible: { actions: ["session.send", "task.create"] },
  });
  expect(control.starts[0]?.servers).toEqual([
    {
      name: "niwa",
      command: "bun",
      args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"],
      env: {
        NIWA_VISIBLE: `session.send,task.create,${SUBMIT_ANSWER_ACTION}`,
        NIWA_SESSION_MARK: expect.any(String),
        NIWA_ID: expect.any(String),
      },
      tools: ["session_send", "task_create", "submit_answer"],
    },
  ]);
  // The mark the server is given names the session, once the harness has named it.
  const mark = control.starts[0]?.servers?.[0]?.env.NIWA_SESSION_MARK;
  await eventually(() => typesOf(records).includes("session.marked"));
  expect(records.filter((record) => record.type === "session.marked").map((record) => record.data)).toEqual([
    { session: SESSION, mark },
  ]);

  // A session that may see no niwa action is given no server: it has no use for one.
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go" });
  expect(control.starts[1]?.servers).toBeUndefined();
});

test("a session that may see niwa actions and has no niwa MCP server is refused, not silently started", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation());

  await expect(
    call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } }),
  ).rejects.toThrow("no niwa MCP server");
  expect(control.starts).toEqual([]);
});

test("a resume passes the servers the same way a start does", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation(), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });

  await call(niwa, "session.resume", {
    session: SESSION,
    visible: { actions: ["session.send"] },
  });
  expect(control.resumes[0]?.servers).toEqual([
    {
      name: "niwa",
      command: "bun",
      args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"],
      env: {
        NIWA_VISIBLE: `session.send,${SUBMIT_ANSWER_ACTION}`,
        NIWA_SESSION_MARK: expect.any(String),
        NIWA_ID: expect.any(String),
      },
      tools: ["session_send", "submit_answer"],
    },
  ]);
  // A resume gives the server a mark of its own, paired with the session it resumes.
  const mark = control.resumes[0]?.servers?.[0]?.env.NIWA_SESSION_MARK;
  await eventually(() => typesOf(records).includes("session.marked"));
  expect(records.filter((record) => record.type === "session.marked").map((record) => record.data)).toEqual([
    { session: SESSION, mark },
  ]);

  // The visible set of the resume reaches the control side as well.
  expect(control.resumes[0]?.visible).toEqual({
    actions: ["session.send", SUBMIT_ANSWER_ACTION],
    disabledTools: [],
  });

  // A resume that names no actions has nothing to add, but it is still the session's own: it
  // carries the session's token and where its reverse requests go, and no servers, visible actions or launch of its own.
  await call(niwa, "session.resume", { session: SESSION });
  expect(Object.keys(control.resumes[1] ?? {})).toEqual(["env", "reverse"]);
  expect(control.resumes[1]?.env?.["NIWA_ID"]).toBeTruthy();
});

test("rq-2: a non-native ask is a request addressed to the session, and the answer goes back through it", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });

  // The ask happens inside an invocation: the handler waits for the answer.
  await niwa.emit(Ask, {});

  // The question niwa asks of the session is a request, and it is addressed to the session.
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = records.find((record) => record.type === RequestCreated.name);
  const asked = created?.data as { id: string; to: unknown; question: string };
  expect(asked.to).toEqual({ kind: "session", harness: HARNESS, id: "session-1" });
  expect(asked.question).toBe("session.answer");

  // The session answers with the id of the request: the answer goes back through it.
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: asked.id, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });

  // The handler gets the value.
  await eventually(
    () => records.some((record) => record.type === Answered.name),
    10_000,
    "the handler did not get the answer",
  );
  const answered = records.find((record) => record.type === Answered.name);
  expect(answered?.data).toEqual({ answer: { answer: "yes" } });
});

test("rq-2: a session answers the question addressed to it with its own token, and no session answers another's", async () => {
  const control = new FakeControl();
  const { niwa, records, home } = await serve(control, installation({ structuredOutput: false }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
    sessionBinding: true,
    with: asker(SESSION),
  });
  const clientOf = async (start: number) => {
    const secret = control.starts[start]?.servers?.[0]?.env.NIWA_ID;
    const client = await connect({ home, token: token(secret ?? "") });
    open.unshift(() => client.close());
    return client;
  };
  // The first session is `session-1`, the one the question is addressed to; the second is another.
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } });
  control.named = "session-2";
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } });
  const addressee = await clientOf(0);
  const other = await clientOf(1);

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const request = (records.find((record) => record.type === RequestCreated.name)?.data as { id: string }).id;

  await expect(other.call(actionName(SUBMIT_ANSWER_ACTION), { question: request, value: { answer: "no" } })).rejects.toThrow(
    "only the addressee",
  );
  expect(await addressee.call(actionName(SUBMIT_ANSWER_ACTION), { question: request, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });
  await eventually(() => records.some((record) => record.type === Answered.name), 10_000, "the handler did not get the answer");
  expect(records.find((record) => record.type === Answered.name)?.data).toEqual({ answer: { answer: "yes" } });
});

test("rq-2: a restart in between leaves the ask waiting, and the answer after it ends the wait", async () => {
  const control = new FakeControl();
  const first = await serve(control, installation({ structuredOutput: false }), { with: asker(SESSION) });
  await first.niwa.emit(Ask, {});
  await eventually(() => first.records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = first.records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;

  await first.stop();
  const second = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
    home: first.home,
  });
  // The host read its journal: the request is still the one that waits, and nothing was answered.
  await eventually(
    () => second.records.some((record) => record.type === RequestCreated.name),
    10_000,
    "the journal was not read",
  );
  expect(second.records.filter((record) => record.type === Answered.name)).toHaveLength(0);
  expect(second.records.filter((record) => record.type === RequestCreated.name)).toHaveLength(1);

  expect(await call(second.niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });
  await eventually(
    () => second.records.some((record) => record.type === Answered.name),
    10_000,
    "the ask did not go on after the restart",
  );
  expect(second.records.find((record) => record.type === Answered.name)?.data).toEqual({ answer: { answer: "yes" } });
  expect(second.records.filter((record) => record.type === RequestCreated.name)).toHaveLength(1);
});

test("rq-6: the question reaches the session, with the request id and how to answer it", async () => {
  const control = new FakeControl();
  const { niwa, records } = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
  });

  await niwa.emit(Ask, {});
  await eventually(() => records.some((record) => record.type === RequestCreated.name), 10_000, "no request");
  const created = records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;

  // The session is told the question, the id it must answer by, and how to answer.
  await eventually(() => control.sent.length > 0, 10_000, "the question did not reach the session");
  const text = control.sent[0] ?? "";
  expect(text).toContain(request);
  expect(text).toContain("good?");
  // The schema the answer must pass is in the text too.
  expect(text).toContain("answer");
  expect(text).toContain(SUBMIT_ANSWER_ACTION);
  expect(text).toContain(request);

  // The session answers by the request id, and the ask goes on.
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });
  await eventually(
    () => records.some((record) => record.type === Answered.name),
    10_000,
    "the ask did not go on",
  );
  expect(records.find((record) => record.type === Answered.name)?.data).toEqual({ answer: { answer: "yes" } });
});

test("rq-6: a restart in between does not ask the session twice", async () => {
  const control = new FakeControl();
  const first = await serve(control, installation({ structuredOutput: false }), { with: asker(SESSION) });
  await first.niwa.emit(Ask, {});
  await eventually(
    () => first.records.some((record) => record.type === RequestCreated.name),
    10_000,
    "no request",
  );
  const created = first.records.find((record) => record.type === RequestCreated.name);
  const request = (created?.data as { id: string }).id;
  await eventually(() => control.sent.length === 1, 10_000, "the question did not reach the session");

  await first.stop();
  const second = await serve(control, installation({ structuredOutput: false }), {
    with: asker(SESSION),
    home: first.home,
  });
  await eventually(
    () => second.records.some((record) => record.type === RequestCreated.name),
    10_000,
    "the journal was not read",
  );

  // The question was asked once: the delivery is a step, so a restart does not ask again.
  await eventually(() => control.sent.length >= 1, 10_000, "the question did not reach the session");
  // A second delivery would come after the restart has read the journal, so the count is
  // read after the host had its chance to make one.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(control.sent).toHaveLength(1);

  // The answer after the restart ends the wait.
  expect(await call(second.niwa, SUBMIT_ANSWER_ACTION, { question: request, value: { answer: "yes" } })).toEqual({
    accepted: true,
  });
  await eventually(
    () => second.records.some((record) => record.type === Answered.name),
    10_000,
    "the ask did not go on after the restart",
  );
  expect(second.records.find((record) => record.type === Answered.name)?.data).toEqual({ answer: { answer: "yes" } });
});

/** The record that starts a session from inside an invocation, and the one that says it was started. */
const Begin = record("session-start.begin", z.object({}));
const Began = record("session-start.began", z.object({ session: z.string() }));

test("a start cut off after the harness named the session is not made again by the restart", async () => {
  const control = new FakeControl();
  control.firstTurn = true;
  let release: () => void = () => {};
  control.startHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starter = plugin("session-starter", (api) => {
    api.declare(Begin, Began);
    api.on(Begin, async (_data, step) => {
      const started = await step<unknown, { session: string }>(actionName("session.start"), {
        harness: HARNESS,
        prompt: "go",
      });
      await step.emit(Began, { session: started.session });
    });
  });
  const first = await serve(control, installation(), { with: starter });
  await first.niwa.emit(Begin, {});
  await eventually(() => control.starts.length === 1, 10_000, "the session was not started");

  // The host is cut off after the harness named the session, before the start step has an outcome.
  void first.stop().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  control.startHold = undefined;
  release();

  const second = await serve(control, installation(), { with: starter, home: first.home });
  await eventually(
    () =>
      second.records.some(
        (record) =>
          record.type === "niwa.invocation.state" &&
          (record.data as { state?: string }).state === "paused",
      ),
    10_000,
    "the cut-off start was not paused",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The start may have made a session nothing knows of: it is not made a second time.
  expect(control.starts).toHaveLength(1);
  expect(second.records.some((record) => record.type === Began.name)).toBe(false);
});

test("rq-6: a session that cannot answer natively sees the action that answers", async () => {
  const control = new FakeControl();
  const { niwa } = await serve(control, installation({ structuredOutput: false }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });

  await call(niwa, "session.start", {
    harness: HARNESS,
    prompt: "go",
    visible: { actions: ["session.send"] },
  });
  // The action that answers a question is among the ones the session sees.
  expect(control.starts[0]?.visible?.actions).toEqual(["session.send", SUBMIT_ANSWER_ACTION]);
  expect(control.starts[0]?.servers?.[0]?.env?.NIWA_VISIBLE).toBe(`session.send,${SUBMIT_ANSWER_ACTION}`);

  // A harness that answers natively has no such action to see.
  const native = new FakeControl();
  const second = await serve(native, installation({ structuredOutput: true }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
  });
  await call(second.niwa, "session.start", {
    harness: HARNESS,
    prompt: "go",
    visible: { actions: ["session.send"] },
  });
  expect(native.starts[0]?.visible?.actions).toEqual(["session.send"]);
});

test("ans-1: the niwa MCP server of a session shows submit_answer with the exact schema of its open questions", async () => {
  const control = new FakeControl();
  const { niwa, records, home } = await serve(control, installation({ structuredOutput: false }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
    with: asker(SESSION),
  });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } });
  const mark = control.starts[0]?.servers?.[0]?.env.NIWA_SESSION_MARK;
  expect(mark).toBeString();
  const pair = await mcpPair(home, ["session.send", SUBMIT_ANSWER_ACTION], mark);
  open.unshift(pair.close);

  const submitAnswer = async (client = pair.client) => {
    const { tools } = await client.listTools();
    return tools.find((tool) => tool.name === "submit_answer")?.inputSchema as unknown as {
      properties: { question: { enum?: string[] }; value: Record<string, unknown> };
      required?: string[];
    };
  };

  // No question is open: the tool is as the action declares it.
  const plain = await submitAnswer();
  expect(plain.properties.question.enum).toBeUndefined();
  expect(plain.properties.value).toEqual({});

  // One question: its request id is the only `question`, and `value` is its answer schema.
  await niwa.emit(Ask, {});
  await eventually(() => records.filter((record) => record.type === RequestCreated.name).length === 1, 10_000, "no request");
  const ids = () =>
    records.filter((record) => record.type === RequestCreated.name).map((record) => (record.data as { id: string }).id);
  const one = await submitAnswer();
  expect(one.properties.question.enum).toEqual(ids());
  expect(one.properties.value).toMatchObject(SCHEMA);
  expect(one.required).toEqual(["question", "value"]);

  // Two questions: either id, and the value passes either schema.
  await niwa.emit(Ask, {});
  await eventually(() => ids().length === 2, 10_000, "no second request");
  const two = await submitAnswer();
  expect(two.properties.question.enum?.sort()).toEqual([...ids()].sort());
  expect((two.properties.value.anyOf as unknown[]).length).toBe(2);

  // Both answered: the tool is plain again.
  for (const id of ids()) {
    expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: id, value: { answer: "yes" } })).toEqual({ accepted: true });
  }
  const after = await submitAnswer();
  expect(after.properties.question.enum).toBeUndefined();
  expect(after.properties.value).toEqual({});

  // A server whose mark names no session shows the plain tool.
  const stranger = await mcpPair(home, ["session.send", SUBMIT_ANSWER_ACTION], "not-a-mark");
  open.unshift(stranger.close);
  await niwa.emit(Ask, {});
  await eventually(() => ids().length === 3, 10_000, "no third request");
  const unmarked = await submitAnswer(stranger.client);
  expect(unmarked.properties.question.enum).toBeUndefined();
  // The marked server sees the question its session is asked.
  expect((await submitAnswer()).properties.question.enum).toEqual(ids().slice(2));
});

test("ans-1: listing the tools of the niwa MCP server writes nothing to the journal", async () => {
  const control = new FakeControl();
  const { niwa, records, home } = await serve(control, installation({ structuredOutput: false }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
    with: asker(SESSION),
  });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } });
  const mark = control.starts[0]?.servers?.[0]?.env.NIWA_SESSION_MARK;
  const pair = await mcpPair(home, ["session.send", SUBMIT_ANSWER_ACTION], mark);
  open.unshift(pair.close);
  await eventually(() => typesOf(records).includes("session.marked"));

  // With and without an open question, a list of tools is a read.
  await pair.client.listTools();
  const quiet = async (): Promise<void> => {
    const before = await niwa.records.read();
    await pair.client.listTools();
    await pair.client.listTools();
    const after = await niwa.records.read();
    expect(after.map((record) => record.id)).toEqual(before.map((record) => record.id));
  };
  await quiet();
  await niwa.emit(Ask, {});
  await eventually(() => records.filter((record) => record.type === RequestCreated.name).length === 1, 10_000, "no request");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await quiet();
});

test("ans-1: the niwa MCP server sends tools/list_changed only when the tools of its session change", async () => {
  const control = new FakeControl();
  const { niwa, records, home } = await serve(control, installation({ structuredOutput: false }), {
    niwaMcp: { command: "bun", args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "mcp"] },
    with: asker(SESSION),
  });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", visible: { actions: ["session.send"] } });
  const mark = control.starts[0]?.servers?.[0]?.env.NIWA_SESSION_MARK;
  await eventually(() => typesOf(records).includes("session.marked"));
  const pair = await mcpPair(home, ["session.send", SUBMIT_ANSWER_ACTION], mark);
  open.unshift(pair.close);
  expect(pair.client.getServerCapabilities()?.tools?.listChanged).toBe(true);

  let changed = 0;
  pair.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed += 1;
  });
  const submitAnswer = async () => {
    const { tools } = await pair.client.listTools();
    return tools.find((tool) => tool.name === "submit_answer")?.inputSchema as unknown as {
      properties: { question: { enum?: string[] }; value: Record<string, unknown> };
    };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const plain = await submitAnswer();
  await settle();
  expect(changed).toBe(0);

  // An unrelated record: no notification.
  await niwa.emit(Other, {});
  await settle();
  expect(changed).toBe(0);

  // A question opens: a notification, and the new list holds its schema.
  await niwa.emit(Ask, {});
  await eventually(() => changed === 1, 10_000, "no list_changed for the question");
  const asked = await submitAnswer();
  expect(asked.properties.value).toMatchObject(SCHEMA);
  expect(asked.properties.question.enum?.length).toBe(1);

  // A record that is not about questions leaves it alone.
  await niwa.emit(Other, {});
  await settle();
  expect(changed).toBe(1);

  // The question is answered: a notification, and the tool is as before.
  const id = records.filter((record) => record.type === RequestCreated.name).map((record) => (record.data as { id: string }).id)[0];
  expect(await call(niwa, SUBMIT_ANSWER_ACTION, { question: id, value: { answer: "yes" } })).toEqual({ accepted: true });
  await eventually(() => changed === 2, 10_000, "no list_changed for the answer");
  expect(await submitAnswer()).toEqual(plain);
  await settle();
  expect(changed).toBe(2);
});
