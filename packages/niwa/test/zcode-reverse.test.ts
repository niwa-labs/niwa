/**
 * Reverse requests of ZCode.
 *
 * The stand-in for `zcode app-server --stdio` asks the client for permission and for
 * the answers to a question the way the real server does: `interaction/requestPermission` with the
 * options and the response each takes, `interaction/requestUserInput` with `questions` or with a
 * bare `prompt`, announced again under a new id while it waits, and closed with a `permission.resolved`
 * event. Some tests hand the control side a handler and look at what it is given and how its answer
 * goes back; the others run the whole way, through the sessions module and the requests module, to the
 * one who started the session. The live test at the end runs the real ZCode.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText, sessionId } from "@niwa-labs/harness";
import type { Harness, ReverseHandler, ReverseRequest, SessionId } from "@niwa-labs/harness";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { SessionTurnResult, SessionTurnStarted, sessionStart, sessionTurnSend, sessionTurnWait } from "@niwa-labs/sessions/records";
import { eventually, openBoxes, tempDir, tempHome, live, ZCODE_FAKE } from "@niwa-labs/testing";

import { zcodeControl, zcodeSides } from "@niwa-labs/harness-zcode";
import type { ZcodeSessionControl } from "@niwa-labs/harness-zcode";

const HARNESS = "zcode-fake";

let dir = "";
let bin = "";
let side: ZcodeSessionControl | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("zcode-reverse");
  bin = join(dir, "zcode");
  await writeFile(bin, ZCODE_FAKE);
  await chmod(bin, 0o755);
});

afterEach(async () => {
  await side?.dispose();
  side = undefined;
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

const id = (text: string) => OptionIdSchema.parse(text);
const picks = (...texts: string[]): Answer => ({ ids: texts.map(id) });

/** A step of the fake's first turn. */
type Step =
  | { readonly ask: { readonly method: string; readonly params: Record<string, unknown> }; readonly again?: number; readonly wait?: boolean }
  | { readonly event: { readonly type: string; readonly payload: Record<string, unknown> } }
  | { readonly ms: number };

/** How the turn plays a request: announced again under new ids `again` times, and waited for unless `wait` is false. */
interface Flow {
  readonly again?: number;
  readonly wait?: boolean;
}

const permissionOf = (requestId: string, toolName: string, input: unknown, extra: Record<string, unknown> = {}, flow: Flow = {}): Step => ({
  ...flow,
  ask: {
    method: "interaction/requestPermission",
    params: {
      requestId,
      sessionId: "sess_fake-1",
      toolCallId: `call-${requestId}`,
      toolName,
      reason: "the tool wants to run",
      riskLevel: "medium",
      input,
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { decision: "allow", reason: "Approved once" } },
        {
          optionId: "allow_project",
          kind: "allow_always",
          name: "Always allow in this project",
          response: { decision: "allow", reason: "Approved for this project", permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName }] }] },
        },
        { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny", reason: "The user does not want this." } },
      ],
      ...extra,
    },
  },
});

interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** A user input request with questions, as AskUserQuestion, a plan approval or an MCP elicitation send it. */
const questionsOf = (requestId: string, asked: ReadonlyArray<{ question: string; header: string; options: readonly Choice[]; multiSelect?: boolean }>, extra: Record<string, unknown> = {}): Step => ({
  ask: {
    method: "interaction/requestUserInput",
    params: { requestId, sessionId: "sess_fake-1", toolCallId: `call-${requestId}`, toolName: "AskUserQuestion", prompt: "The agent asks", questions: asked, schema: { toolName: "AskUserQuestion" }, ...extra },
  },
});

/** The bare form of a user input request: a prompt, and a text to answer it. */
const promptOf = (requestId: string, prompt: string): Step => ({
  ask: { method: "interaction/requestUserInput", params: { requestId, sessionId: "sess_fake-1", prompt } },
});

const resolved = (requestId: string): Step => ({ event: { type: "permission.resolved", payload: { requestId, toolCallId: `call-${requestId}` } } });

const logOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, name), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** What the client answered to a request of the fake: every answer that is not one of a preference or an unknown request. */
const answersOf = async (): Promise<Array<{ id: string; result: Record<string, unknown> }>> =>
  (await logOf("answers.log"))
    .filter((frame) => "decision" in (frame["result"] as object) || "action" in (frame["result"] as object))
    .map((frame) => ({ id: frame["id"] as string, result: frame["result"] as Record<string, unknown> }));

const answered = async (count: number): Promise<void> => {
  await eventually(async () => (await answersOf()).length >= count);
};

/** A handler that keeps what it was given, and answers with what the test says. */
function handler(answer: (request: ReverseRequest, nth: number) => Promise<Answer> | Answer): { handler: ReverseHandler; seen: ReverseRequest[] } {
  const seen: ReverseRequest[] = [];
  return {
    seen,
    handler: async (_session, request) => {
      seen.push(request);
      return await answer(request, seen.length);
    },
  };
}

/** A handler that waits for the question to be closed, and says so. */
function waiting(): { handler: ReverseHandler; seen: ReverseRequest[] } {
  return handler((request) => new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true }))));
}

async function startedWith(reverse: ReverseHandler | undefined, script: readonly Step[]): Promise<{ control: ZcodeSessionControl; session: SessionId }> {
  await writeFile(join(dir, "script.json"), JSON.stringify(script));
  const control = zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 });
  side = control;
  const { session } = await control.start({ prompt: promptFromText("script"), cwd: dir, ...(reverse === undefined ? {} : { reverse }) });
  return { control, session };
}

test("a permission request is a question with the tool and its input, and only the once-only options of ZCode", async () => {
  const { handler: given, seen } = handler(() => picks("allow_once"));
  await startedWith(given, [permissionOf("perm-1", "Bash", { command: "ls" })]);
  await answered(1);

  const question = seen[0]?.question;
  expect(question).toMatchObject({ kind: "permission", title: "Bash", subject: { tool: "Bash", kind: "Bash", target: '{"command":"ls"}' } });
  expect(question?.kind === "permission" && question.options.map((option) => [String(option.id), option.flavor])).toEqual([
    ["allow_once", "allow_once"],
    ["deny", "reject_once"],
  ]);
  expect(question?.kind === "permission" && question.detail).toContain("the tool wants to run");
  expect(seen[0]?.raw.method).toBe("interaction/requestPermission");
  // ZCode's own "always allow in this project" is neither offered nor sent: its rule updates never go back.
  expect((await answersOf())[0]?.result).toEqual({ decision: "allow", reason: "Approved once" });
});

test("reject goes back as ZCode's own deny, with its words", async () => {
  const { handler: given } = handler(() => picks("deny"));
  await startedWith(given, [permissionOf("perm-1", "Bash", { command: "rm x" })]);
  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ decision: "deny", reason: "The user does not want this." });
});

test("a permission that offers no once-only options is still a question with an allow and a deny", async () => {
  const { handler: given, seen } = handler(() => picks("allow_once"));
  await startedWith(given, [permissionOf("perm-1", "Bash", { command: "ls" }, { options: [{ optionId: "allow_project", kind: "allow_always", name: "Always", response: { decision: "allow", permissionUpdates: [] } }] })]);
  await answered(1);
  expect(seen[0]?.question.kind === "permission" && seen[0].question.options.map((option) => option.flavor)).toEqual(["allow_once", "reject_once"]);
  expect((await answersOf())[0]?.result).toEqual({ decision: "allow", reason: "Approved once" });
});

test("a cancelled answer and a handler that fails both deny: the turn does not hang", async () => {
  const { handler: cancelling } = handler(() => ({ cancelled: true }));
  const { control, session } = await startedWith(cancelling, [permissionOf("perm-1", "Bash", { command: "ls" })]);
  await answered(1);
  expect((await answersOf())[0]?.result).toMatchObject({ decision: "deny" });
  await eventually(async () => (await control.state(session)) === "idle");

  await control.dispose();
  await rm(join(dir, "answers.log"));
  await startedWith(
    () => {
      throw new Error("boom");
    },
    [permissionOf("perm-2", "Bash", { command: "ls" })],
  );
  await answered(1);
  expect((await answersOf())[0]?.result).toMatchObject({ decision: "deny" });
});

test("a request announced again under a new id is one question, and every id gets the answer", async () => {
  const { handler: given, seen } = handler(async () => {
    await Bun.sleep(100);
    return picks("allow_once");
  });
  await startedWith(given, [permissionOf("perm-1", "Bash", { command: "ls" }, {}, { again: 2 })]);
  await answered(3);
  expect(seen.length).toBe(1);
  const replies = await answersOf();
  expect(new Set(replies.map((answer) => answer.id)).size).toBe(3);
  expect(replies.map((answer) => answer.result["decision"])).toEqual(["allow", "allow", "allow"]);
});

test("the server's resolving of a request aborts the question, and the turn goes on", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
  });
  const { control, session } = await startedWith(given, [
    permissionOf("perm-1", "Bash", { command: "sleep 99" }, {}, { wait: false }),
    { ms: 200 },
    resolved("perm-1"),
    { ms: 3000 },
  ]);
  await eventually(() => aborted !== undefined);
  expect(aborted?.aborted).toBe(false);
  await eventually(() => aborted?.aborted === true);
  // The server stopped waiting for the request, not for the turn.
  expect(await control.state(session)).toBe("running");
  await answered(1);
  expect((await answersOf())[0]?.result).toMatchObject({ decision: "deny" });
});

test("an interrupt aborts what the server waits for", async () => {
  const { handler: given, seen } = waiting();
  const { control, session } = await startedWith(given, [permissionOf("perm-1", "Bash", { command: "sleep 99" })]);
  await eventually(() => seen.length === 1);
  expect(seen[0]?.signal.aborted).toBe(false);
  await control.interrupt(session);
  expect(seen[0]?.signal.aborted).toBe(true);
  await eventually(async () => (await control.state(session)) === "idle");
});

test("the end of the turn aborts what the server was still waiting for", async () => {
  const { handler: given, seen } = waiting();
  // The turn ends with the request open: the script does not wait for its answer.
  await startedWith(given, [permissionOf("perm-1", "Bash", { command: "ls" }, {}, { wait: false })]);
  await eventually(() => seen[0]?.signal.aborted === true);
});

test("the questions of a request go one by one; the value of the choice, a comma-joined multi-select and a free text come back", async () => {
  const { handler: given, seen } = handler((request) => {
    const question = request.question;
    if (question.kind === "choice") return picks("option-2");
    if (question.kind === "multi") return picks("option-1", "option-3");
    return { text: "typed words" };
  });
  await startedWith(given, [
    questionsOf("ask-1", [
      { question: "Review this implementation plan.", header: "Plan", options: [{ value: "approve", label: "Approve" }, { value: "revise", label: "Ask for changes", description: "tell it what" }] },
      { question: "Which features?", header: "Features", multiSelect: true, options: [{ value: "tz", label: "Time zones" }, { value: "locale", label: "Locale" }, { value: "plugins", label: "Plugins" }] },
      { question: "A free text", header: "Text", options: [{ value: "__zcode_free_text__", label: "Type your answer" }] },
    ]),
  ]);
  await answered(1);

  expect(seen.map((request) => [request.question.kind, request.question.title])).toEqual([
    ["choice", "Review this implementation plan."],
    ["multi", "Which features?"],
    ["text", "A free text"],
  ]);
  expect(seen[0]?.question).toMatchObject({ allowOther: true, detail: "Plan" });
  expect(seen[0]?.raw.method).toBe("interaction/requestUserInput");
  // The answers are the values the server gave the choices, which are not their labels.
  expect((await answersOf())[0]?.result).toEqual({
    action: "accept",
    content: { answers: { "Review this implementation plan.": "revise", "Which features?": "tz, plugins", "A free text": "typed words" } },
  });
});

test("a question answered with other words returns the words", async () => {
  const { handler: given } = handler(() => ({ text: "luxon" }));
  await startedWith(given, [questionsOf("ask-1", [{ question: "Which library?", header: "Library", options: [{ value: "date-fns", label: "date-fns" }, { value: "dayjs", label: "dayjs" }] }])]);
  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ action: "accept", content: { answers: { "Which library?": "luxon" } } });
});

test("the bare form of a question, a prompt with no questions, is a free text", async () => {
  const { handler: given, seen } = handler(() => ({ text: "the answer" }));
  await startedWith(given, [promptOf("ask-1", "What is the name?")]);
  await answered(1);
  expect(seen[0]?.question).toMatchObject({ kind: "text", title: "What is the name?" });
  expect((await answersOf())[0]?.result).toEqual({ action: "accept", content: { answer: "the answer" } });
});

test("a question nobody answers ends the request cancelled; nothing is answered for it by niwa", async () => {
  const { handler: given, seen } = handler(() => ({ cancelled: true }));
  await startedWith(given, [
    questionsOf("ask-1", [
      { question: "One?", header: "One", options: [{ value: "a", label: "a" }] },
      { question: "Two?", header: "Two", options: [{ value: "b", label: "b" }] },
    ]),
  ]);
  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ action: "cancel" });
  // The second question was never asked.
  expect(seen.length).toBe(1);
});

test("a session with no place for its reverse requests declines a question and keeps the policy for a permission", async () => {
  await startedWith(undefined, [
    questionsOf("ask-1", [{ question: "One?", header: "One", options: [{ value: "a", label: "a" }] }]),
    permissionOf("perm-1", "Bash", { command: "ls" }),
  ]);
  await answered(2);
  expect((await answersOf()).map((answer) => answer.result["action"] ?? answer.result["decision"])).toEqual(["decline", "allow"]);
});

test("ZCode's own answering of a question after a countdown is off for a session whose questions are asked of someone", async () => {
  await startedWith(handler(() => picks("allow_once")).handler, []);
  await eventually(async () => (await logOf("answers.log")).length >= 3);
  const preferences = (await logOf("answers.log")).map((frame) => frame["result"] as Record<string, unknown>).filter((result) => "memoryEnabled" in result);
  expect(preferences.length).toBeGreaterThan(0);
  expect(preferences.every((result) => result["askUserQuestionAutoResolutionEnabled"] === false)).toBe(true);
});

test("a resume that names a handler gives the held session its reverse requests from then on", async () => {
  const control = zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 });
  side = control;
  const { session } = await control.start({ prompt: promptFromText("hello"), cwd: dir });
  await eventually(async () => (await control.state(session)) === "idle");

  const { handler: given, seen } = handler(() => picks("allow_once"));
  await writeFile(join(dir, "script.json"), JSON.stringify([permissionOf("perm-1", "Bash", { command: "ls" })]));
  await control.resume(session, { reverse: given, prompt: promptFromText("script") });
  await answered(1);
  expect(seen.length).toBe(1);
});

// -- the whole way: sessions, requests, and the one who started the session ---------------------

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("zcode"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: zcodeSides.control!.launch, tools: zcodeSides.control!.tools } },
};

async function stack(script: readonly Step[]): Promise<{ niwa: Host; records: StoredRecord[]; control: ZcodeSessionControl }> {
  await writeFile(join(dir, "script.json"), JSON.stringify(script));
  const control = zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 });
  side = control;
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control }] }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since()) records.push(record);
  })();
  closers.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return { niwa, records, control };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

test("late ZCode completions and failures cannot settle a queued receipt or overwrite its SQLite result", async () => {
  await Promise.all(["hold-reply", "no-turn-id", "hold-failure", "partial-failure-start", "idle-projection-while-busy"]
    .map((name) => writeFile(join(dir, name), "")));
  const home = await tempHome();
  const control = zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 });
  let niwa = createNiwa({ home: home.path });
  niwa.use(sessions({ sandbox: openBoxes(), harnesses: [{ instance: installation, control }] }));
  try {
    await niwa.serve();
    const { session } = await niwa.call(sessionStart, { harness: HARNESS, prompt: "", cwd: dir });
    const life = control.life(sessionId(harnessId(HARNESS), "sess_fake-1"))[Symbol.asyncIterator]();
    const ignored: string[] = [];
    const observing = (async () => {
      for (let next = await life.next(); !next.done; next = await life.next()) {
        const event = next.value;
        if (event.kind === "activity" && event.detail?.startsWith("ignored")) {
          ignored.push(event.detail);
          if (ignored.length === 4) return;
        }
      }
    })();
    const first = await niwa.call(sessionTurnSend, { session, message: "stray" });
    const second = await niwa.call(sessionTurnSend, { session, message: "give the word" });
    const third = await niwa.call(sessionTurnSend, { session, message: "fail" });
    expect(first.receipt).toMatchObject({ status: "started", turn: 1 });
    expect(second.receipt).toMatchObject({ status: "queued", turn: 2 });
    expect(third.receipt).toMatchObject({ status: "queued", turn: 3 });
    const result = (handle: typeof first.handle, timeoutMs = 3000) => niwa.call(sessionTurnWait, { ...handle, timeoutMs });
    await writeFile(join(dir, "release-first"), "");
    expect(await result(first.handle)).toEqual({ status: "completed", value: "fake reply" });
    await eventually(() => ignored.length === 4, 3000);
    await observing;
    await life.return?.();
    expect(ignored.sort()).toEqual([
      "ignored a ZCode terminal event for another turn",
      "ignored a ZCode terminal event for another turn",
      "ignored an uncorrelated ZCode terminal event",
      "ignored an uncorrelated ZCode terminal event",
    ]);
    // Keep B busy past the old one-second recovery window after all of A's late events.
    expect(await result(second.handle, 1400)).toEqual({ status: "timed-out" });
    expect(await result(third.handle, 0)).toEqual({ status: "timed-out" });
    expect(await control.state(sessionId(harnessId(HARNESS), "sess_fake-1"))).toBe("running");
    expect((await niwa.records.read({ types: [SessionTurnResult] })).map(({ data }) => [data.turn, data.answer]))
      .toEqual([[1, "fake reply"]]);

    const secondWaits = [result(second.handle), result(second.handle)];
    await writeFile(join(dir, "release-reply"), "");
    const expected = { status: "completed", value: '{"word":"ok"}' };
    expect(await Promise.all(secondWaits)).toEqual([expected, expected]);

    expect(await result(third.handle, 0)).toEqual({ status: "timed-out" });
    await writeFile(join(dir, "release-failure"), "");
    // C actually failed. Its start and terminal had no IDs, so the exact outcome is unknown.
    expect(await result(third.handle)).toEqual({ status: "ended", how: "unknown" });
    const wire = (await readFile(join(dir, "requests.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(wire.filter(({ method }) => method === "session/read").length).toBeGreaterThan(1);
    expect(wire.filter(({ method }) => method === "session/messages")).toEqual([]);
    await niwa.close();
    niwa = createNiwa({ home: home.path });
    niwa.use(sessions({
      sandbox: openBoxes(),
      harnesses: [{ instance: installation, control: zcodeControl({ harness: HARNESS, binary: bin }) }],
    }));
    await niwa.serve();
    expect(await result(first.handle, 0)).toEqual({ status: "completed", value: "fake reply" });
    expect(await result(second.handle, 0)).toEqual(expected);
    expect(await result(third.handle, 0)).toEqual({ status: "ended", how: "unknown" });
    expect((await niwa.records.read({ types: [SessionTurnResult] })).map(({ data }) => [data.turn, data.how, data.answer]))
      .toEqual([[1, "completed", "fake reply"], [2, "completed", '{"word":"ok"}'], [3, "unknown", undefined]]);
  } finally {
    await control.dispose();
    await niwa.close();
    await home.cleanup();
  }
}, 15_000);

test.each([
  { scenario: "lagging history", flags: ["lag-history-once", "hold-reply"], firstMessage: "give the word", release: "release-reply", firstOutcome: "completed", secondOutcome: "completed" },
  { scenario: "identified failure in the projection", flags: ["hold-failure"], firstMessage: "fail", release: "release-failure", firstOutcome: "failed", secondOutcome: "completed" },
  { scenario: "failure without start or terminal IDs", flags: ["hold-failure", "partial-failure-start"], firstMessage: "fail", release: "release-failure", firstOutcome: "unknown", secondOutcome: "failed" },
  { scenario: "failure after a start without a payload or turn ID", flags: ["hold-failure", "partial-failure-start", "bare-failure-start"], firstMessage: "fail", release: "release-failure", firstOutcome: "unknown", secondOutcome: "failed" },
])("ZCode reconciles ID-less terminals with $scenario and stores both receipt outcomes", async ({ flags, firstMessage, release, firstOutcome, secondOutcome }) => {
  await Promise.all(["no-turn-id", ...flags].map((name) => writeFile(join(dir, name), "")));
  const home = await tempHome();
  let niwa = createNiwa({ home: home.path });
  const mount = () => niwa.use(sessions({
    sandbox: openBoxes(),
    harnesses: [{ instance: installation, control: zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 }) }],
  }));
  mount();
  try {
    await niwa.serve();
    const { session } = await niwa.call(sessionStart, { harness: HARNESS, prompt: "", cwd: dir });
    const first = await niwa.call(sessionTurnSend, { session, message: firstMessage });
    const second = await niwa.call(sessionTurnSend, { session, message: "next" });
    expect(first.receipt).toMatchObject({ status: "started", turn: 1 });
    expect(second.receipt).toMatchObject({ status: "queued", turn: 2 });
    const wait = (handle: typeof first.handle, timeoutMs: number) => niwa.call(sessionTurnWait, { ...handle, timeoutMs });
    expect(await wait(first.handle, 0)).toEqual({ status: "timed-out" });
    const waits = Promise.all([wait(first.handle, 4000), wait(second.handle, 4000)]);
    await writeFile(join(dir, release), "");

    const expected = [
      firstOutcome === "completed" ? { status: "completed", value: '{"word":"ok"}' } : { status: "ended", how: firstOutcome },
      secondOutcome === "completed" ? { status: "completed", value: "fake reply" } : { status: "ended", how: secondOutcome },
    ];
    expect(await waits).toEqual(expected);
    const methods = (await readFile(join(dir, "requests.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).method);
    expect(methods).toContain("session/read");
    if (firstOutcome === "completed") expect(methods.filter((method) => method === "session/messages").length).toBeGreaterThanOrEqual(2);
    expect(methods.filter((method) => method === "session/send")).toHaveLength(secondOutcome === "completed" ? 2 : 1);
    expect((await niwa.records.read({ types: [SessionTurnResult] })).map(({ data }) => [data.turn, data.how]))
      .toEqual([[1, firstOutcome], [2, secondOutcome]]);

    await niwa.close();
    niwa = createNiwa({ home: home.path });
    mount();
    await niwa.serve();
    expect(await Promise.all([wait(first.handle, 0), wait(second.handle, 0)])).toEqual(expected);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 15_000);

test.each([
  { scenario: "after acknowledgement", earlyStart: false },
  { scenario: "before acknowledgement, ahead of an already numbered queue entry", earlyStart: true },
])("ZCode tracks a steer redirected into a new turn starting $scenario", async ({ earlyStart }) => {
  await writeFile(join(dir, "hold-first-terminal"), "");
  await writeFile(join(dir, "hold-reply"), "");
  if (earlyStart) await writeFile(join(dir, "start-before-steer-ack"), "");
  const home = await tempHome();
  let niwa = createNiwa({ home: home.path });
  const mount = () => niwa.use(sessions({
    sandbox: openBoxes(),
    harnesses: [{ instance: installation, control: zcodeControl({ harness: HARNESS, binary: bin, stopGraceMs: 300 }) }],
  }));
  mount();
  try {
    await niwa.serve();
    const { session } = await niwa.call(sessionStart, { harness: HARNESS, prompt: "", cwd: dir });
    const firstInput = { session, message: "first", operation: "first" };
    const first = await niwa.call(sessionTurnSend, firstInput);
    expect(first.receipt).toMatchObject({ status: "started", turn: 1 });
    const queued = earlyStart ? await niwa.call(sessionTurnSend, { session, message: "give the fenced word" }) : undefined;
    if (queued !== undefined) expect(queued.receipt).toMatchObject({ status: "queued", turn: 2 });

    await eventually(() => Bun.file(join(dir, "first-idle")).exists());
    const secondInput = { session, message: "give the word", into: "turn", operation: "redirected" } as const;
    const second = await niwa.call(sessionTurnSend, secondInput);
    const turn = earlyStart ? 3 : 2;
    expect(second.receipt).toMatchObject({ status: "started", turn });
    expect(second.handle.turn).toBe(turn);
    const wait = (handle: typeof first.handle, timeoutMs = 4000) => niwa.call(sessionTurnWait, { ...handle, timeoutMs });
    const firstAnswer = { status: "completed", value: "fake reply" };
    const secondAnswer = { status: "completed", value: '{"word":"ok"}' };
    expect(await wait(first.handle)).toEqual(firstAnswer);
    expect(await wait(second.handle, 0)).toEqual({ status: "timed-out" });
    if (queued !== undefined) expect(await wait(queued.handle, 0)).toEqual({ status: "timed-out" });
    const secondWaits = Promise.all([wait(second.handle), wait(second.handle)]);
    await writeFile(join(dir, "release-reply"), "");
    expect(await secondWaits).toEqual([secondAnswer, secondAnswer]);
    const queuedAnswer = { status: "completed", value: 'Here it is: ```json\n{"word":"fenced"}\n```' };
    if (queued !== undefined) expect(await wait(queued.handle)).toEqual(queuedAnswer);
    expect((await niwa.records.read({ types: [SessionTurnStarted] })).map(({ data }) => data.turn))
      .toEqual(earlyStart ? [1, 3, 2] : [1, 2]);

    await niwa.close();
    niwa = createNiwa({ home: home.path });
    mount();
    await niwa.serve();
    expect(await niwa.call(sessionTurnSend, firstInput)).toEqual(first);
    expect(await niwa.call(sessionTurnSend, secondInput)).toEqual(second);
    expect(await Promise.all([wait(first.handle, 0), wait(second.handle, 0)])).toEqual([firstAnswer, secondAnswer]);
    if (queued !== undefined) expect(await wait(queued.handle, 0)).toEqual(queuedAnswer);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 15_000);

interface OpenRequest {
  id: string;
  question: string;
  to: { kind: string };
  input: { kind: string; title: string; options?: Array<{ id: string; label: string; flavor: string }> };
}

async function reverseRequests(niwa: Host): Promise<OpenRequest[]> {
  const { requests: all } = await call<{ requests: OpenRequest[] }>(niwa, "request.open", {});
  return all.filter((entry) => entry.question === "session.reverse");
}

async function nextRequest(niwa: Host, timeoutMs = 10_000): Promise<OpenRequest> {
  let found: OpenRequest | undefined;
  await eventually(async () => {
    found = (await reverseRequests(niwa))[0];
    return found !== undefined;
  }, timeoutMs);
  if (found === undefined) throw new Error("no request");
  return found;
}

const startWith = (niwa: Host, extra: Record<string, unknown> = {}) => call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "script", cwd: dir, ...extra });

test("a permission of a zcode session is a request to the starter, and the answer goes back natively", async () => {
  const { niwa, records } = await stack([permissionOf("perm-1", "Bash", { command: "ls" })]);
  await startWith(niwa);

  const request = await nextRequest(niwa);
  expect(request.to).toEqual({ kind: "owner" });
  expect(request.input).toMatchObject({ kind: "permission", title: "Bash" });
  expect(request.input.options?.map((option) => option.flavor)).toEqual(["allow_once", "reject_once", "allow_always"]);

  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow_once"] } });
  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ decision: "allow", reason: "Approved once" });
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.asked")?.data).toMatchObject({ route: "starter", raw: { method: "interaction/requestPermission" } });
});

test("allow always: niwa answers the next matching permission with ZCode's allow once, and never asks again", async () => {
  const same = { command: "ls" };
  const { niwa, records } = await stack([permissionOf("perm-1", "Bash", same), permissionOf("perm-2", "Bash", same)]);
  await startWith(niwa);

  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["niwa.allow_always"] } });
  await answered(2);

  // Both answers are ZCode's once-only allow: its own "allow in this project" (with rule updates) was never sent.
  expect((await answersOf()).map((answer) => answer.result)).toEqual([
    { decision: "allow", reason: "Approved once" },
    { decision: "allow", reason: "Approved once" },
  ]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  expect(records.filter((record) => record.type === "session.reverse.answered").map((record) => (record.data as { by: string }).by)).toEqual(["starter", "remembered"]);
});

test("a tool the grant covers is allowed with no request", async () => {
  const { niwa, records } = await stack([permissionOf("perm-1", "Bash", { command: "ls" })]);
  await startWith(niwa, { visible: { actions: ["tool:Bash"] } });
  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ decision: "allow", reason: "Approved once" });
  expect(records.filter((record) => record.type === "request.created")).toEqual([]);
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("a request announced again is one request to the starter", async () => {
  const { niwa, records } = await stack([permissionOf("perm-1", "Bash", { command: "ls" }, {}, { again: 2 })]);
  await startWith(niwa);
  const request = await nextRequest(niwa);
  await Bun.sleep(300);
  expect((await reverseRequests(niwa)).length).toBe(1);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["deny"] } });
  await answered(3);
  expect((await answersOf()).map((answer) => answer.result["decision"])).toEqual(["deny", "deny", "deny"]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
});

test("a question of a zcode session is a request per question to the starter", async () => {
  const { niwa } = await stack([
    questionsOf("ask-1", [
      { question: "Which library?", header: "Library", options: [{ value: "date-fns", label: "date-fns", description: "small" }, { value: "dayjs", label: "dayjs" }] },
      { question: "Which features?", header: "Features", multiSelect: true, options: [{ value: "tz", label: "tz" }, { value: "locale", label: "locale" }] },
    ]),
  ]);
  await startWith(niwa);

  const first = await nextRequest(niwa);
  expect(first.input).toMatchObject({ kind: "choice", title: "Which library?" });
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["option-1"] } });

  let second: OpenRequest | undefined;
  await eventually(async () => {
    second = (await reverseRequests(niwa))[0];
    return second !== undefined && second.id !== first.id;
  });
  expect(second?.input).toMatchObject({ kind: "multi", title: "Which features?" });
  await call(niwa, "request.answer", { id: second?.id, answer: { ids: ["option-1", "option-2"] } });

  await answered(1);
  expect((await answersOf())[0]?.result).toEqual({ action: "accept", content: { answers: { "Which library?": "date-fns", "Which features?": "tz, locale" } } });
});

test("when the server stops waiting for a request, niwa's request is cancelled and closed, and the turn goes on", async () => {
  const { niwa, records, control } = await stack([permissionOf("perm-1", "Bash", { command: "sleep 99" }, {}, { wait: false }), { ms: 300 }, resolved("perm-1"), { ms: 3000 }]);
  await startWith(niwa);
  await nextRequest(niwa);

  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  expect(await control.state(sessionId(harnessId(HARNESS), "sess_fake-1"))).toBe("running");
});

test("an interrupt closes niwa's request", async () => {
  const { niwa, records } = await stack([permissionOf("perm-1", "Bash", { command: "sleep 99" })]);
  const { session } = await startWith(niwa);
  await nextRequest(niwa);

  await call(niwa, "session.interrupt", { session });
  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled" });
});

// -- live --------------------------------------------------------------------------------------

/** Runs `body` against the real ZCode, with the sessions and requests modules in front of it. */
async function withRealZcode(body: (niwa: Host, cwd: string) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const control = zcodeControl({ harness: HARNESS, turnTimeoutMs: 180_000 });
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control }] }));
  await niwa.serve();
  try {
    const cwd = join(dir, "work");
    await mkdir(cwd, { recursive: true });
    await body(niwa, cwd);
  } finally {
    await control.dispose();
    await niwa.close();
    await home.cleanup();
  }
}

// ZCode's `guarded` asks only for dangerous commands; `auto` (its `edit`) asks for a command of the shell.
test.skipIf(!live || Bun.which("zcode") === null)(
  "the real ZCode asks for permission in mode auto, and the answer given through request.answer lets the command run",
  async () => {
    await withRealZcode(async (niwa, cwd) => {
      await call(niwa, "session.start", {
        harness: HARNESS,
        mode: "auto",
        cwd,
        prompt: "Run the shell command `touch note.txt` with the Bash tool. Then reply done.",
      });
      const request = await nextRequest(niwa, 150_000);
      expect(request.input).toMatchObject({ kind: "permission", title: "Bash" });
      const allow = request.input.options?.find((option) => option.flavor === "allow_once");
      expect(allow).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [allow?.id] } });
      await eventually(async () => await Bun.file(join(cwd, "note.txt")).exists(), 150_000, "the command did not run after the permission was allowed");
    });
  },
  360_000,
);

test.skipIf(!live || Bun.which("zcode") === null)(
  "the real ZCode keeps AskUserQuestion, and the answer given through request.answer comes back to it",
  async () => {
    await withRealZcode(async (niwa, cwd) => {
      await call(niwa, "session.start", {
        harness: HARNESS,
        mode: "full",
        cwd,
        prompt:
          "Call the AskUserQuestion tool once to ask which colour I like, with the options red and blue. When you have my answer, use the Write tool to create a file named after the colour I chose, in lower case with the extension .txt (for red, red.txt), containing the word ok. Then reply done.",
      });
      const request = await nextRequest(niwa, 150_000);
      expect(request.input.kind).toBe("choice");
      const blue = request.input.options?.find((option) => option.label.toLowerCase() === "blue");
      expect(blue).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [blue?.id] } });
      await eventually(async () => await Bun.file(join(cwd, "blue.txt")).exists(), 150_000, "the file named after the answer was not written");
    });
  },
  360_000,
);
