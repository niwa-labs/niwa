/**
 * Reverse requests of Claude Code's ACP dialect.
 *
 * A fake ACP agent asks for permission and asks the questions of an AskUserQuestion call, the way
 * the adapter does (the tool call is announced with `session/update`, the permission is
 * `session/request_permission`, the questions are `_niwa/ask_user_question`). Some tests hand the
 * control side a handler and look at what it is given and how its answer is sent back; the others
 * run the whole way, through the sessions module and the requests module, to the one who started
 * the session. The live test at the end runs the real adapter and the real Claude Code.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText, sessionId } from "@niwa-labs/harness";
import type { Harness, ReverseHandler, ReverseRequest, SessionControl, SessionId } from "@niwa-labs/harness";
import { CLAUDE_CODE_LAUNCH, claudeCodeControl } from "@niwa-labs/harness-claude";
import type { ClaudeCodeSessionControl } from "@niwa-labs/harness-claude";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempDir, tempHome, live } from "@niwa-labs/testing";

let dir = "";
let control: ClaudeCodeSessionControl | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("claude-reverse");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

const id = (text: string) => OptionIdSchema.parse(text);
const picks = (...texts: string[]): Answer => ({ ids: texts.map(id) });

/** What the fake agent does in its first turn, in order. */
type Step =
  | { readonly out: unknown }
  | { readonly wait: string }
  | { readonly waitCancel: true }
  | { readonly ms: number };

const toolCall = (callId: string, tool: string, kind: string, rawInput: unknown, locations?: Array<{ path: string }>): Step => ({
  out: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: { sessionUpdate: "tool_call", toolCallId: callId, kind, title: tool, rawInput, status: "pending", locations, _meta: { claudeCode: { toolName: tool } } },
    },
  },
});

/** The permission request the adapter sends: the three options, and a tool call with a title and the input only. */
const permission = (frameId: string, callId: string, title: string, rawInput: unknown): Step => ({
  out: {
    jsonrpc: "2.0",
    id: frameId,
    method: "session/request_permission",
    params: {
      sessionId: "fake-session",
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      toolCall: { toolCallId: callId, title, rawInput },
    },
  },
});

const questions = (frameId: string, callId: string, asked: unknown[]): Step => ({
  out: { jsonrpc: "2.0", id: frameId, method: "_niwa/ask_user_question", params: { sessionId: "fake-session", toolCallId: callId, questions: asked } },
});

/**
 * A fake ACP adapter. In its first turn it plays `script`, waiting for the client's reply to a
 * request where the script says so, and then ends the turn. A `session/cancel` ends the turn as
 * cancelled at once. It logs the params of `session/new` and every reply and notification it gets.
 */
async function fakeAgent(script: readonly Step[]): Promise<string> {
  const path = join(dir, "fake-acp");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = (name, value) => appendFileSync(${JSON.stringify(dir)} + "/" + name, JSON.stringify(value) + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const script = ${JSON.stringify(script)};
const replies = new Map();
const waiters = new Map();
let cancelWake;
let turn = 0;
async function play(job) {
  turn += 1;
  let cancelled = false;
  if (turn === 1) {
    for (const step of script) {
      if (step.out !== undefined) out(step.out);
      else if (step.ms !== undefined) await Bun.sleep(step.ms);
      else if (step.wait !== undefined) {
        const outcome = await Promise.race([
          replies.has(step.wait) ? Promise.resolve("reply") : new Promise((resolve) => waiters.set(step.wait, () => resolve("reply"))),
          new Promise((resolve) => { cancelWake = () => resolve("cancel"); }),
        ]);
        if (outcome === "cancel") { cancelled = true; break; }
      } else if (step.waitCancel) {
        await new Promise((resolve) => { cancelWake = resolve; });
        cancelled = true;
        break;
      }
    }
  }
  out({ jsonrpc: "2.0", id: job.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.method === "initialize") {
      out({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    } else if (frame.method === "session/new") {
      log("sessions.log", frame.params);
      out({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [] }, models: { currentModelId: "default", availableModels: [] }, configOptions: [] } });
    } else if (frame.method === "session/set_mode" || frame.method === "session/set_model") {
      out({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      void play(frame);
    } else if (frame.method === "session/cancel") {
      log("cancel.log", frame.params);
      cancelWake?.();
    } else if (frame.method === undefined && frame.id !== undefined) {
      log("replies.log", frame);
      replies.set(frame.id, frame);
      waiters.get(frame.id)?.();
    } else if (frame.method === undefined || frame.id === undefined) {
      log("notices.log", frame);
    }
  }
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

const repliesOf = async (): Promise<Array<{ id: string; result?: Record<string, unknown>; error?: unknown }>> =>
  (await readFile(join(dir, "replies.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; result?: Record<string, unknown>; error?: unknown });

const sessionRequestsOf = async (): Promise<Array<{ _meta?: { niwa?: { askUserQuestion?: boolean } } }>> =>
  (await readFile(join(dir, "sessions.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { _meta?: { niwa?: { askUserQuestion?: boolean } } });

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

async function startedWith(reverse: ReverseHandler | undefined, script: readonly Step[]): Promise<{ side: ClaudeCodeSessionControl; session: SessionId }> {
  const side = claudeCodeControl({ harness: "fake", command: [await fakeAgent(script)], executable: "claude" });
  control = side;
  const { session } = await side.start({ prompt: promptFromText("go"), cwd: dir, ...(reverse === undefined ? {} : { reverse }) });
  return { side, session };
}

test("a permission request is a question with the tool and what it acts on, and only the once-only options of the agent", async () => {
  const { handler: given, seen } = handler(() => picks("allow"));
  await startedWith(given, [
    toolCall("tu-1", "Bash", "execute", { command: "ls" }),
    permission("perm-1", "tu-1", "`ls`", { command: "ls" }),
    { wait: "perm-1" },
  ]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);

  const question = seen[0]?.question;
  expect(question).toMatchObject({
    kind: "permission",
    title: "`ls`",
    subject: { tool: "Bash", kind: "execute", target: '{"command":"ls"}' },
  });
  expect(question?.kind === "permission" && question.options.map((option) => [String(option.id), option.flavor])).toEqual([
    ["allow", "allow_once"],
    ["reject", "reject_once"],
  ]);
  expect(seen[0]?.raw.method).toBe("session/request_permission");
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("a path the agent announced is what the permission acts on", async () => {
  const { handler: given, seen } = handler(() => picks("reject"));
  await startedWith(given, [
    toolCall("tu-1", "Write", "edit", { file_path: "/tmp/a.txt", content: "x" }, [{ path: "/tmp/a.txt" }]),
    permission("perm-1", "tu-1", "Write /tmp/a.txt", { file_path: "/tmp/a.txt", content: "x" }),
    { wait: "perm-1" },
  ]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect(seen[0]?.question).toMatchObject({ subject: { tool: "Write", kind: "edit", target: "/tmp/a.txt" } });
  // Reject goes back as the agent's once-only reject.
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
});

test("a cancelled answer is a cancelled outcome", async () => {
  const { handler: given } = handler(() => ({ cancelled: true }));
  await startedWith(given, [permission("perm-1", "tu-1", "`ls`", { command: "ls" }), { wait: "perm-1" }]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("a handler that fails answers cancelled: the turn does not hang", async () => {
  const { handler: given } = handler(() => {
    throw new Error("boom");
  });
  await startedWith(given, [permission("perm-1", "tu-1", "`ls`", { command: "ls" }), { wait: "perm-1" }]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("an interrupt aborts what the agent waits for, and the request is answered cancelled", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
  });
  const { side, session } = await startedWith(given, [permission("perm-1", "tu-1", "`sleep 99`", { command: "sleep 99" }), { wait: "perm-1" }]);
  await eventually(() => aborted !== undefined);
  expect(aborted?.aborted).toBe(false);

  await side.interrupt(session);
  expect(aborted?.aborted).toBe(true);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("the end of the turn aborts what the agent was still waiting for", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
  });
  // The agent does not wait for the answer: it ends the turn with the request open.
  await startedWith(given, [permission("perm-1", "tu-1", "`ls`", { command: "ls" })]);
  await eventually(() => aborted?.aborted === true);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("the questions of an AskUserQuestion call go one by one; labels, a comma-joined multi-select and a free text come back as answers", async () => {
  const { handler: given, seen } = handler((request) => {
    const question = request.question;
    if (question.kind === "choice") return picks("option-2");
    if (question.kind === "multi") return picks("option-1", "option-3");
    return { text: "never" };
  });
  await startedWith(given, [
    questions("q-1", "tu-q", [
      { question: "Which library?", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "small" }, { label: "dayjs", description: "tiny" }] },
      { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "tz", description: "" }, { label: "locale", description: "" }, { label: "plugins", description: "" }] },
    ]),
    { wait: "q-1" },
  ]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);

  expect(seen.map((request) => [request.question.kind, request.question.title, request.question.kind !== "permission" && request.question.kind !== "text" && request.question.kind !== "form" && request.question.allowOther])).toEqual([
    ["choice", "Which library?", true],
    ["multi", "Which features?", true],
  ]);
  expect(seen[0]?.raw.method).toBe("_niwa/ask_user_question");
  expect((await repliesOf())[0]?.result).toEqual({ answers: { "Which library?": "dayjs", "Which features?": "tz, plugins" } });
});

test("a question answered with other words returns the words", async () => {
  const { handler: given } = handler(() => ({ text: "luxon" }));
  await startedWith(given, [
    questions("q-1", "tu-q", [{ question: "Which library?", header: "Library", multiSelect: false, options: [{ label: "date-fns" }, { label: "dayjs" }] }]),
    { wait: "q-1" },
  ]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ answers: { "Which library?": "luxon" } });
});

test("a question nobody answers ends the call: the tool is told it was cancelled", async () => {
  const { handler: given } = handler(() => ({ cancelled: true }));
  await startedWith(given, [
    questions("q-1", "tu-q", [
      { question: "One?", header: "One", multiSelect: false, options: [{ label: "a" }, { label: "b" }] },
      { question: "Two?", header: "Two", multiSelect: false, options: [{ label: "a" }, { label: "b" }] },
    ]),
    { wait: "q-1" },
  ]);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ cancelled: true });
});

test("the agent's cancel of a tool call aborts its questions", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
  });
  await startedWith(given, [
    questions("q-1", "tu-q", [{ question: "One?", header: "One", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }]),
    { out: { jsonrpc: "2.0", method: "_niwa/cancel_request", params: { sessionId: "fake-session", toolCallId: "tu-q" } } },
    { wait: "q-1" },
  ]);
  await eventually(() => aborted?.aborted === true);
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ cancelled: true });
});

test("a session with a place for its reverse requests keeps AskUserQuestion; one without has it off as the adapter has it", async () => {
  await startedWith(handler(() => picks("allow")).handler, []);
  expect((await sessionRequestsOf())[0]?._meta?.niwa).toEqual({ askUserQuestion: true });
  await control?.dispose();
  await rm(join(dir, "sessions.log"));

  await startedWith(undefined, []);
  expect((await sessionRequestsOf())[0]?._meta?.niwa).toBeUndefined();
});

// -- the whole way: sessions, requests, and the one who started the session ---------------------

const HARNESS = "claude-fake";

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("claude-code"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: false, launch: CLAUDE_CODE_LAUNCH, tools: { niwaOnly: true, allow: true } } },
};

async function stack(script: readonly Step[]): Promise<{ niwa: Host; records: StoredRecord[]; side: SessionControl }> {
  const side = claudeCodeControl({ harness: HARNESS, command: [await fakeAgent(script)], executable: "claude" });
  control = side;
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since()) records.push(record);
  })();
  closers.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return { niwa, records, side };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

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

test("a permission of a claude session is a request to the starter, and the answer goes back natively", async () => {
  const { niwa, records } = await stack([
    toolCall("tu-1", "Bash", "execute", { command: "ls" }),
    permission("perm-1", "tu-1", "`ls`", { command: "ls" }),
    { wait: "perm-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  expect(request.to).toEqual({ kind: "owner" });
  expect(request.input).toMatchObject({ kind: "permission", title: "`ls`" });
  expect(request.input.options?.map((option) => option.flavor)).toEqual(["allow_once", "reject_once", "allow_always"]);

  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow"] } });
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
});

test("reject goes back as the agent's reject", async () => {
  const { niwa } = await stack([permission("perm-1", "tu-1", "`rm x`", { command: "rm x" }), { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["reject"] } });
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
});

test("allow always: niwa answers the next matching permission with the agent's allow once, and never asks again", async () => {
  const same = { command: "ls" };
  const { niwa, records } = await stack([
    toolCall("tu-1", "Bash", "execute", same),
    permission("perm-1", "tu-1", "`ls`", same),
    { wait: "perm-1" },
    toolCall("tu-2", "Bash", "execute", same),
    permission("perm-2", "tu-2", "`ls`", same),
    { wait: "perm-2" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["niwa.allow_always"] } });
  await eventually(async () => (await repliesOf().catch(() => [])).length === 2);

  // Both replies are the agent's once-only allow: its own allow_always was never chosen.
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "selected", optionId: "allow" } },
  ]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  expect(records.filter((record) => record.type === "session.reverse.answered").map((record) => (record.data as { by: string }).by)).toEqual(["starter", "remembered"]);
});

test("a tool the grant covers is allowed with no request", async () => {
  const { niwa, records } = await stack([
    toolCall("tu-1", "Bash", "execute", { command: "ls" }),
    permission("perm-1", "tu-1", "`ls`", { command: "ls" }),
    { wait: "perm-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:Bash"] } });
  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  expect(records.filter((record) => record.type === "request.created")).toEqual([]);
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("an AskUserQuestion of a claude session is a request per question to the starter", async () => {
  const { niwa } = await stack([
    questions("q-1", "tu-q", [
      { question: "Which library?", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "small" }, { label: "dayjs", description: "tiny" }] },
      { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "tz" }, { label: "locale" }] },
    ]),
    { wait: "q-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

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

  await eventually(async () => (await repliesOf().catch(() => [])).length === 1);
  expect((await repliesOf())[0]?.result).toEqual({ answers: { "Which library?": "date-fns", "Which features?": "tz, locale" } });
});

test("when the agent cancels the turn, niwa's request is cancelled and closed", async () => {
  const { niwa, records, side } = await stack([permission("perm-1", "tu-1", "`sleep 99`", { command: "sleep 99" }), { waitCancel: true }]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);

  await call(niwa, "session.interrupt", { session });
  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
  expect(await side.state(sessionId(harnessId(HARNESS), "fake-session"))).toBe("idle");
});

// -- live --------------------------------------------------------------------------------------

test.skipIf(!live || Bun.which("claude") === null)(
  "the real claude asks for permission in mode ask, and the answer given through request.answer lets it write",
  async () => {
    const home = await tempHome();
    const side = claudeCodeControl({ harness: HARNESS, model: "haiku", turnTimeoutMs: 120_000 });
    const niwa = createNiwa({ home: home.path });
    niwa.use(requests({ bind: () => owner }));
    niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
    await niwa.serve();
    try {
      const cwd = join(dir, "work");
      await mkdir(cwd, { recursive: true });
      await call(niwa, "session.start", {
        harness: HARNESS,
        model: "haiku",
        mode: "ask",
        cwd,
        prompt: "Use the Write tool to create the file note.txt in the current directory with the text hello. Then reply done.",
      });
      const request = await nextRequest(niwa, 120_000);
      expect(request.input.kind).toBe("permission");
      const allow = request.input.options?.find((option) => option.flavor === "allow_once");
      expect(allow).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [allow?.id] } });
      await eventually(async () => (await Bun.file(join(cwd, "note.txt")).exists()), 120_000, "the file was not written after the permission was allowed");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  240_000,
);

test.skipIf(!live || Bun.which("claude") === null)(
  "the real claude keeps AskUserQuestion, and the answer given through request.answer comes back to it",
  async () => {
    const home = await tempHome();
    const side = claudeCodeControl({ harness: HARNESS, model: "haiku", turnTimeoutMs: 120_000 });
    const niwa = createNiwa({ home: home.path });
    niwa.use(requests({ bind: () => owner }));
    niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
    await niwa.serve();
    try {
      const cwd = join(dir, "work");
      await mkdir(cwd, { recursive: true });
      const { session } = await call<{ session: string }>(niwa, "session.start", {
        harness: HARNESS,
        model: "haiku",
        mode: "full",
        cwd,
        prompt:
          "Call the AskUserQuestion tool once to ask which colour I like, with the options red and blue. When you have my answer, reply with only the colour I chose, in lower case.",
      });
      const request = await nextRequest(niwa, 120_000);
      expect(request.input.kind).toBe("choice");
      const blue = request.input.options?.find((option) => option.label.toLowerCase() === "blue");
      expect(blue).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [blue?.id] } });
      // The turn goes on with the answer; a question asked after it is answered once the turn is over.
      const told = await side.ask(sessionId(harnessId(HARNESS), session.split(" ")[1] ?? ""), {
        schema: z.object({ colour: z.string() }),
        prompt: promptFromText("Which colour did I choose in my answer to your question? Reply with the JSON only."),
      });
      expect(told.value.colour.toLowerCase()).toBe("blue");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  240_000,
);
