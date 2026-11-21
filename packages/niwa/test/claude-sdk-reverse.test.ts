/**
 * Reverse requests of the Claude Agent SDK.
 *
 * The fake `query` asks `canUseTool` the way the SDK does: a tool wanting leave, and an
 * `AskUserQuestion` call whose questions are in its input and whose answers go back in the
 * `updatedInput`. Some tests hand the control side a handler and look at what it is given and how
 * its answer is sent back; the others run the whole way, through the sessions module and the
 * requests module, to the one who started the session. The live test at the end runs the real SDK.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText, sessionId } from "@niwa-labs/harness";
import type { Harness, ReverseHandler, ReverseRequest } from "@niwa-labs/harness";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempDir, tempHome, live, fakeSdkQuery } from "@niwa-labs/testing";

import { CLAUDE_SDK_LAUNCH, ClaudeSdkControl } from "@niwa-labs/harness-claude";

import type { FakeCall } from "@niwa-labs/testing";

let dir = "";
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("claude-sdk-reverse");
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

const HARNESS = "claude-sdk-fake";
const id = (text: string) => OptionIdSchema.parse(text);
const picks = (...texts: string[]): Answer => ({ ids: texts.map(id) });

const bash = (command: string, extra: Partial<FakeCall> = {}): FakeCall => ({ tool: "Bash", input: { command }, ...extra });

const asking = (...asked: Array<{ question: string; multiSelect?: boolean; options: string[] }>): FakeCall => ({
  tool: "AskUserQuestion",
  input: {
    questions: asked.map((entry) => ({
      question: entry.question,
      header: "Q",
      multiSelect: entry.multiSelect ?? false,
      options: entry.options.map((label) => ({ label, description: `${label}!` })),
    })),
  },
});

/** A control side over the fake query, which asks `calls` in its first turn. */
function sideWith(calls: readonly FakeCall[], options: { mode?: "ask" | "auto" | "full" } = {}) {
  const fake = fakeSdkQuery({ calls });
  const side = new ClaudeSdkControl({ harness: HARNESS, query: fake.query, ...options });
  closers.push(() => side.dispose());
  return { fake, side };
}

/** A handler that keeps what it was given, and answers with what the test says. */
function handler(answer: (request: ReverseRequest, nth: number) => Promise<Answer> | Answer): {
  handler: ReverseHandler;
  seen: ReverseRequest[];
} {
  const seen: ReverseRequest[] = [];
  return {
    seen,
    handler: async (_session, request) => {
      seen.push(request);
      return await answer(request, seen.length);
    },
  };
}

/** Waits until the fake has an answer from `canUseTool` for `count` calls. */
const answered = async (fake: ReturnType<typeof fakeSdkQuery>, count: number): Promise<ReadonlyArray<PermissionResult | undefined>> => {
  await eventually(() => fake.outcomes().length === count);
  return fake.outcomes();
};

/** A handler that waits until the request is no longer wanted, and then answers cancelled. */
function waitsForCancel(): { handler: ReverseHandler; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    handler: (_session, request) => {
      signals.push(request.signal);
      return new Promise<Answer>((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
    },
  };
}

test("a permission is a question with the tool and what it acts on, and only the once-only options; allow runs the tool as asked", async () => {
  const { handler: given, seen } = handler(() => picks("allow"));
  const { fake, side } = sideWith([bash("ls", { title: "Claude wants to run ls" })]);
  await side.start({ prompt: promptFromText("go"), reverse: given });

  const [outcome] = await answered(fake, 1);
  const question = seen[0]?.question;
  expect(question).toMatchObject({
    kind: "permission",
    title: "Claude wants to run ls",
    subject: { tool: "Bash", kind: "execute", target: '{"command":"ls"}' },
  });
  expect(question?.kind === "permission" && question.options.map((option) => [String(option.id), option.flavor])).toEqual([
    ["allow", "allow_once"],
    ["reject", "reject_once"],
  ]);
  expect(seen[0]?.raw).toMatchObject({ method: "canUseTool", params: { toolName: "Bash", input: { command: "ls" }, title: "Claude wants to run ls" } });
  // The SDK is told to run the tool as asked, and is given no rule of its own to remember.
  expect(outcome).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
});

test("a path of the input is what a file tool acts on, and the kind is the one Claude Code names", async () => {
  const { handler: given, seen } = handler(() => picks("allow"));
  const { fake, side } = sideWith([
    { tool: "Write", input: { file_path: "/tmp/a.txt", content: "x" } },
    { tool: "mcp__x__y", input: { n: 1 } },
  ]);
  await side.start({ prompt: promptFromText("go"), reverse: given });
  await answered(fake, 2);
  expect(seen[0]?.question).toMatchObject({ subject: { tool: "Write", kind: "edit", target: "/tmp/a.txt" } });
  // A tool that is not one of Claude Code's own is its own kind.
  expect(seen[1]?.question).toMatchObject({ subject: { tool: "mcp__x__y", kind: "mcp__x__y", target: '{"n":1}' } });
});

test("reject is a one-off refusal: the tool is denied and the turn goes on", async () => {
  const { handler: given } = handler(() => picks("reject"));
  const { fake, side } = sideWith([bash("rm x")]);
  const { session } = await side.start({ prompt: promptFromText("go"), reverse: given });
  const [outcome] = await answered(fake, 1);
  expect(outcome).toEqual({ behavior: "deny", message: "the user refused the tool" });
  await eventually(async () => (await side.state(session)) === "idle");
});

test("a cancelled answer and a handler that fails both deny: the turn does not hang", async () => {
  const cancelled = handler(() => ({ cancelled: true }));
  const broken = handler(() => {
    throw new Error("boom");
  });
  for (const given of [cancelled.handler, broken.handler]) {
    const { fake, side } = sideWith([bash("ls")]);
    const { session } = await side.start({ prompt: promptFromText("go"), reverse: given });
    const [outcome] = await answered(fake, 1);
    expect(outcome?.behavior).toBe("deny");
    await eventually(async () => (await side.state(session)) === "idle");
  }
});

test("the SDK's cancel of a call aborts what the handler waits for, and the SDK is answered anyway", async () => {
  const waits = waitsForCancel();
  const { fake, side } = sideWith([bash("sleep 99", { cancelAfterMs: 50 })]);
  const { session } = await side.start({ prompt: promptFromText("go"), reverse: waits.handler });
  const [outcome] = await answered(fake, 1);
  expect(waits.signals[0]?.aborted).toBe(true);
  expect(outcome?.behavior).toBe("deny");
  await eventually(async () => (await side.state(session)) === "idle");
});

test("an interrupt aborts what the handler waits for", async () => {
  const waits = waitsForCancel();
  const { fake, side } = sideWith([bash("sleep 99")]);
  const { session } = await side.start({ prompt: promptFromText("go"), reverse: waits.handler });
  await eventually(() => waits.signals.length === 1);
  expect(waits.signals[0]?.aborted).toBe(false);

  await side.interrupt(session);
  expect(waits.signals[0]?.aborted).toBe(true);
  expect((await answered(fake, 1))[0]?.behavior).toBe("deny");
});

test("the end of the query aborts what the handler waits for", async () => {
  const waits = waitsForCancel();
  const { side } = sideWith([bash("sleep 99")]);
  await side.start({ prompt: promptFromText("go"), reverse: waits.handler });
  await eventually(() => waits.signals.length === 1);
  await side.dispose();
  expect(waits.signals[0]?.aborted).toBe(true);
});

test("the questions of an AskUserQuestion call go one by one; labels, a comma-joined multi-select and a free text come back in the call's answers", async () => {
  const { handler: given, seen } = handler((request) => {
    const question = request.question;
    if (question.title === "Which library?") return picks("option-2");
    if (question.title === "Which features?") return picks("option-1", "option-3");
    return { text: "luxon" };
  });
  const { fake, side } = sideWith([
    asking(
      { question: "Which library?", options: ["date-fns", "dayjs"] },
      { question: "Which features?", multiSelect: true, options: ["tz", "locale", "plugins"] },
      { question: "Which other?", options: ["a", "b"] },
    ),
  ]);
  await side.start({ prompt: promptFromText("go"), reverse: given });
  const [outcome] = await answered(fake, 1);

  expect(
    seen.map((request) => [request.question.kind, request.question.title, request.question.kind === "choice" || request.question.kind === "multi" ? request.question.allowOther : undefined]),
  ).toEqual([
    ["choice", "Which library?", true],
    ["multi", "Which features?", true],
    ["choice", "Which other?", true],
  ]);
  expect(seen[0]?.raw.method).toBe("canUseTool");
  expect(outcome).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { "Which library?": "dayjs", "Which features?": "tz, plugins", "Which other?": "luxon" } },
  });
  // The questions go back as they came, with the answers added.
  expect(outcome?.behavior === "allow" && outcome.updatedInput?.questions).toHaveLength(3);
});

test("a question nobody answers ends the call: the tool is told, and the later questions are not asked", async () => {
  const { handler: given, seen } = handler(() => ({ cancelled: true }));
  const { fake, side } = sideWith([
    asking({ question: "One?", options: ["a", "b"] }, { question: "Two?", options: ["a", "b"] }),
  ]);
  await side.start({ prompt: promptFromText("go"), reverse: given });
  const [outcome] = await answered(fake, 1);
  expect(outcome).toEqual({ behavior: "deny", message: "the questions were not answered" });
  expect(seen).toHaveLength(1);
});

test("a call whose questions are not well formed is refused, not asked", async () => {
  const { handler: given, seen } = handler(() => picks("option-1"));
  const { fake, side } = sideWith([{ tool: "AskUserQuestion", input: { questions: [] } }]);
  await side.start({ prompt: promptFromText("go"), reverse: given });
  expect((await answered(fake, 1))[0]?.behavior).toBe("deny");
  expect(seen).toHaveLength(0);
});

test("a session with a place for its reverse requests takes its questions in every mode, `full` included; one without answers by the side's policy", async () => {
  const given = handler(() => picks("allow")).handler;
  for (const mode of ["ask", "full"] as const) {
    const { fake, side } = sideWith([], { mode });
    await side.start({ prompt: promptFromText("go"), tools: { allow: ["Read"] }, reverse: given });
    const options = fake.asked().at(-1);
    expect(options?.canUseTool).toBeDefined();
    // The allowance is the grant's own: nothing is added to it.
    expect(options?.tools).toEqual(["Read"]);
  }

  // Without it: `full` asks nothing, `ask` is answered by the policy, the tool allowance is its own.
  const full = sideWith([], { mode: "full" });
  await full.side.start({ prompt: promptFromText("go"), tools: { allow: ["Read"] } });
  expect(full.fake.asked().at(-1)?.canUseTool).toBeUndefined();
  expect(full.fake.asked().at(-1)?.tools).toEqual(["Read"]);

  const policy = sideWith([bash("ls")], { mode: "ask" });
  await policy.side.start({ prompt: promptFromText("go") });
  expect(await answered(policy.fake, 1)).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
});

test("a resume names where the reverse requests of a held session go from now on", async () => {
  const first = handler(() => picks("allow"));
  const second = handler(() => picks("reject"));
  const { fake, side } = sideWith([bash("ls"), bash("pwd", { turn: 2 })]);
  const { session } = await side.start({ prompt: promptFromText("go"), reverse: first.handler });
  await answered(fake, 1);
  await eventually(async () => (await side.state(session)) === "idle");

  await side.resume(session, { prompt: promptFromText("again"), reverse: second.handler });
  const outcomes = await answered(fake, 2);
  expect(first.seen.map((request) => request.question.title)).toEqual(["Use Bash"]);
  expect(second.seen.map((request) => request.question.title)).toEqual(["Use Bash"]);
  expect(outcomes.map((outcome) => outcome?.behavior)).toEqual(["allow", "deny"]);
});

// -- the whole way: sessions, requests, and the one who started the session ---------------------

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("claude-sdk"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: CLAUDE_SDK_LAUNCH, tools: { niwaOnly: true, allow: true } } },
};

async function stack(calls: readonly FakeCall[]) {
  const { fake, side } = sideWith(calls);
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
  return { niwa, records, fake, side };
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

test("a permission of an SDK session is a request to the starter, and the answer goes back natively", async () => {
  const { niwa, records, fake } = await stack([bash("ls")]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  expect(request.to).toEqual({ kind: "owner" });
  expect(request.input).toMatchObject({ kind: "permission", subject: { tool: "Bash", kind: "execute" } });
  expect(request.input.options?.map((option) => option.flavor)).toEqual(["allow_once", "reject_once", "allow_always"]);

  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow"] } });
  expect(await answered(fake, 1)).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
});

test("reject goes back as a refusal of the tool", async () => {
  const { niwa, fake } = await stack([bash("rm x")]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["reject"] } });
  expect((await answered(fake, 1))[0]?.behavior).toBe("deny");
});

test("allow always: niwa answers the next matching permission with a once-only allow and never asks again; the SDK keeps no rule", async () => {
  const { niwa, records, fake } = await stack([bash("ls"), bash("ls")]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["niwa.allow_always"] } });
  const outcomes = await answered(fake, 2);

  expect(outcomes).toEqual([
    { behavior: "allow", updatedInput: { command: "ls" } },
    { behavior: "allow", updatedInput: { command: "ls" } },
  ]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  expect(records.filter((record) => record.type === "session.reverse.answered").map((record) => (record.data as { by: string }).by)).toEqual(["starter", "remembered"]);
});

test("a tool the grant covers is allowed with no request", async () => {
  const { niwa, records, fake } = await stack([bash("ls")]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:Bash"] } });
  expect(await answered(fake, 1)).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
  // The records reach this reader by a live stream: the answer may come before its record does.
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.filter((record) => record.type === "request.created")).toEqual([]);
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("an AskUserQuestion of an SDK session is a request per question to the starter", async () => {
  const { niwa, fake } = await stack([
    asking({ question: "Which library?", options: ["date-fns", "dayjs"] }, { question: "Which features?", multiSelect: true, options: ["tz", "locale"] }),
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

  const [outcome] = await answered(fake, 1);
  expect(outcome).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which library?": "date-fns", "Which features?": "tz, locale" } } });
});

test("when the SDK cancels the call, niwa's request is cancelled and closed", async () => {
  const { niwa, records, fake, side } = await stack([bash("sleep 99", { cancelAfterMs: 300 })]);
  const { ref } = await call<{ ref: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  // The records are kept, so a request the SDK cancels before a poll sees it is not missed.
  await eventually(() => records.some((record) => record.type === "request.created"));

  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  expect((await answered(fake, 1))[0]?.behavior).toBe("deny");
  // The turn is not left hanging: the session is idle.
  await eventually(async () => (await side.state(sessionId(harnessId(HARNESS), ref.split(" ")[1] ?? ""))) === "idle");
});

// -- live --------------------------------------------------------------------------------------

test.skipIf(!live || Bun.which("claude") === null)(
  "the real SDK asks for permission in mode ask, and the answer given through request.answer lets it write",
  async () => {
    const home = await tempHome();
    const side = new ClaudeSdkControl({ harness: HARNESS, model: "haiku", turnTimeoutMs: 120_000 });
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
      await eventually(async () => await Bun.file(join(cwd, "note.txt")).exists(), 120_000, "the file was not written after the permission was allowed");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  240_000,
);
