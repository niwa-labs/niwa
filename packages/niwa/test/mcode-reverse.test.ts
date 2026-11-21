/**
 * Reverse requests of MiniMax Code.
 *
 * A fake ACP agent asks for permission with the options the real one offers (the fork's lasting
 * ones too), puts a questionnaire as an `elicitation/create` form, and as the single-choice
 * permission request a client without form support gets. Every test runs the whole way, through
 * the sessions module and the requests module, to the one who started the session. The live test
 * at the end runs the real `mcode`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText } from "@niwa-labs/harness";
import type { Harness, ReverseHandler } from "@niwa-labs/harness";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempDir, tempHome, live } from "@niwa-labs/testing";

import { MCODE_LAUNCH, mcodeControl } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl, MinimaxLineage } from "@niwa-labs/harness-mcode";

let dir = "";
let control: McodeSessionControl | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("mcode-reverse");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

/** What the fake agent does in its first turn, in order. */
type Step = { readonly out: unknown } | { readonly wait: string } | { readonly waitCancel: true };

/** The options the fork offers for a tool: the lasting ones first, then the once-only ones. */
const FORK_OPTIONS = [
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "deny-always", name: "Always deny", kind: "reject_always" },
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

const permission = (frameId: string, toolCallId: string, tool: string, rawInput: unknown, locations?: Array<{ path: string }>): Step => ({
  out: {
    jsonrpc: "2.0",
    id: frameId,
    method: "session/request_permission",
    params: {
      sessionId: "fake-1",
      toolCall: { toolCallId, title: `${tool} description`, name: tool, kind: "execute", status: "pending", rawInput, locations },
      options: FORK_OPTIONS,
    },
  },
});

/** The questionnaire as a client that declared form support gets it. */
const form = (frameId: string, properties: Record<string, unknown>): Step => ({
  out: {
    jsonrpc: "2.0",
    id: frameId,
    method: "elicitation/create",
    params: { mode: "form", sessionId: "fake-1", message: "MiniMax Code needs your input", requestedSchema: { type: "object", properties } },
  },
});

/** The first step of a questionnaire as a client without form support gets it: a permission request. */
const fallback = (frameId: string, requestId: string, question: string, choices: string[]): Step => ({
  out: {
    jsonrpc: "2.0",
    id: frameId,
    method: "session/request_permission",
    params: {
      sessionId: "fake-1",
      toolCall: { toolCallId: requestId, title: question, kind: "other", status: "pending" },
      options: [
        ...choices.map((choice) => ({ optionId: `questionnaire:${requestId}:${choice}`, name: choice, kind: "allow_once" })),
        { optionId: `questionnaire:${requestId}:cancel`, name: "Cancel", kind: "reject_once" },
      ],
    },
  },
});

/**
 * A fake `mcode acp`. In its first turn it plays `script`, waiting for the client's reply to a
 * request where the script says so, and then ends the turn. A `session/cancel` ends the turn as
 * cancelled at once. It logs the params of `initialize` and every reply it gets.
 */
async function fakeAgent(script: readonly Step[], lineage: MinimaxLineage = "fork"): Promise<string> {
  const path = join(dir, "mcode");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = (name, value) => appendFileSync(${JSON.stringify(dir)} + "/" + name, JSON.stringify(value) + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const script = ${JSON.stringify(script)};
// The fork serves the turn status and the history; the published build does not.
const methods = ${JSON.stringify(lineage === "fork" ? ["mcode/session/steer", "mcode/session/turn_status", "session/history"] : ["mcode/session/steer"])};
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
      log("initialize.log", frame.params);
      out({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, _meta: { "minimax-code/extensions": { version: 1, methods, notifications: [] } } } });
    } else if (frame.method === "session/new") {
      out({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "fake-1" } });
    } else if (frame.method === "session/prompt") {
      void play(frame);
    } else if (frame.method === "session/cancel") {
      log("cancel.log", frame.params);
      cancelWake?.();
    } else if (frame.method === undefined && frame.id !== undefined) {
      log("replies.log", frame);
      replies.set(frame.id, frame);
      waiters.get(frame.id)?.();
    } else if (frame.id !== undefined) {
      out({ jsonrpc: "2.0", id: frame.id, result: {} });
    }
  }
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

const logOf = async <T>(name: string): Promise<T[]> =>
  (await readFile(join(dir, name), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);

interface Reply {
  id: string;
  result?: Record<string, unknown>;
  error?: unknown;
}
const repliesOf = (): Promise<Reply[]> => logOf<Reply>("replies.log");
const repliesCount = async (count: number): Promise<boolean> => (await repliesOf()).length === count;

const HARNESS = "mcode-fake";

const installation = (kind: "mcode" | "ncode"): Harness => ({
  id: harnessId(HARNESS),
  kind: harnessKind(kind),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: MCODE_LAUNCH } },
});

async function stack(
  script: readonly Step[],
  lineage: MinimaxLineage = "fork",
): Promise<{ niwa: Host; records: StoredRecord[] }> {
  const side = mcodeControl({ harness: HARNESS, lineage, binary: await fakeAgent(script, lineage), mode: "ask" });
  control = side;
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation(lineage === "fork" ? "ncode" : "mcode"), control: side }] }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since()) records.push(record);
  })();
  closers.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return { niwa, records };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

interface OpenRequest {
  id: string;
  question: string;
  to: { kind: string };
  input: { kind: string; title: string; allowOther?: boolean; options?: Array<{ id: string; label: string; flavor: string }> };
}

async function reverseRequests(niwa: Host): Promise<OpenRequest[]> {
  const { requests: all } = await call<{ requests: OpenRequest[] }>(niwa, "request.open", {});
  return all.filter((entry) => entry.question === "session.reverse");
}

async function nextRequest(niwa: Host, timeoutMs = 10_000, not?: string): Promise<OpenRequest> {
  let found: OpenRequest | undefined;
  await eventually(async () => {
    found = (await reverseRequests(niwa)).find((entry) => entry.id !== not);
    return found !== undefined;
  }, timeoutMs);
  if (found === undefined) throw new Error("no request");
  return found;
}

for (const lineage of ["upstream", "fork"] as const) {
  test(`${lineage}: a permission is a request to the starter with the once-only options, and the answer goes back natively`, async () => {
    const { niwa, records } = await stack([permission("perm-1", "tc-1", "Bash", { command: "ls" }), { wait: "perm-1" }], lineage);
    await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

    const request = await nextRequest(niwa);
    expect(request.to).toEqual({ kind: "owner" });
    expect(request.input).toMatchObject({ kind: "permission", title: "Bash description" });
    // The lasting options of the agent are not offered; niwa adds its own "allow always".
    expect(request.input.options?.map((option) => option.flavor)).toEqual(["allow_once", "reject_once", "allow_always"]);
    expect(request.input.options?.slice(0, 2).map((option) => option.id)).toEqual(["allow-once", "deny"]);

    await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow-once"] } });
    await eventually(() => repliesCount(1));
    expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
    expect(records.find((record) => record.type === "session.reverse.asked")?.data).toMatchObject({
      raw: { method: "session/request_permission", params: { toolCall: { name: "Bash", rawInput: { command: "ls" } } } },
    });
  });
}

test("reject goes back as the agent's one-off reject, never its deny-always", async () => {
  const { niwa } = await stack([permission("perm-1", "tc-1", "Bash", { command: "rm x" }), { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["deny"] } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
});

test("an answer that picks an option the agent offered only as a lasting one is refused", async () => {
  const { niwa } = await stack([permission("perm-1", "tc-1", "Bash", { command: "ls" }), { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  await expect(call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow-always"] } })).rejects.toBeDefined();
  expect((await reverseRequests(niwa)).length).toBe(1);
  expect(await repliesOf()).toEqual([]);
});

test("a grant of every tool allows with no request", async () => {
  const { niwa, records } = await stack([permission("perm-1", "tc-1", "Bash", { command: "ls" }), { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:*"] } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  expect(records.filter((record) => record.type === "request.created")).toEqual([]);
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("allow always: niwa answers the next matching permission with the agent's allow once, and never asks again", async () => {
  const same = { command: "ls" };
  const { niwa, records } = await stack([
    permission("perm-1", "tc-1", "Bash", same),
    { wait: "perm-1" },
    permission("perm-2", "tc-2", "Bash", same),
    { wait: "perm-2" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["niwa.allow_always"] } });
  await eventually(() => repliesCount(2));

  // Both replies are the agent's once-only allow: its own allow-always was never chosen.
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([
    { outcome: { outcome: "selected", optionId: "allow-once" } },
    { outcome: { outcome: "selected", optionId: "allow-once" } },
  ]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  expect(records.filter((record) => record.type === "session.reverse.answered").map((record) => (record.data as { by: string }).by)).toEqual(["starter", "remembered"]);
});

test("a permission with only lasting options offers a cancel and is answered cancelled", async () => {
  const lastingOnly: Step = {
    out: {
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: { sessionId: "fake-1", toolCall: { toolCallId: "tc-1", title: "Bash" }, options: FORK_OPTIONS.slice(0, 2) },
    },
  };
  const { niwa } = await stack([lastingOnly, { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  expect(request.input.options?.map((option) => option.flavor)).toEqual(["reject_once"]);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["cancel"] } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("a questionnaire is a request per step, and the answers go back as the form's content", async () => {
  const { niwa } = await stack([
    form("form-1", {
      library: { type: "string", title: "Which library?", oneOf: [{ const: "date-fns", title: "date-fns", description: "small" }, { const: "dayjs", title: "dayjs" }] },
      library__other: { type: "string", title: "Which library? — Other" },
      features: { type: "array", title: "Which features?", items: { anyOf: [{ const: "tz", title: "Time zones" }, { const: "locale", title: "Locales" }] } },
      notes: { type: "string", title: "Anything else?" },
    }),
    { wait: "form-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const first = await nextRequest(niwa);
  expect(first.input).toMatchObject({ kind: "choice", title: "Which library?", allowOther: true });
  expect(first.input.options?.map((option) => option.id)).toEqual(["date-fns", "dayjs"]);
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["dayjs"] } });

  const second = await nextRequest(niwa, 10_000, first.id);
  expect(second.input).toMatchObject({ kind: "multi", title: "Which features?", allowOther: false });
  await call(niwa, "request.answer", { id: second.id, answer: { ids: ["tz", "locale"] } });

  const third = await nextRequest(niwa, 10_000, second.id);
  expect(third.input).toMatchObject({ kind: "text", title: "Anything else?" });
  await call(niwa, "request.answer", { id: third.id, answer: { text: "no" } });

  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({
    action: "accept",
    content: { library: "dayjs", features: ["tz", "locale"], notes: "no" },
  });
});

test("an answer in the person's own words fills the other field of the step", async () => {
  const { niwa } = await stack([
    form("form-1", {
      library: { type: "string", title: "Which library?", oneOf: [{ const: "date-fns", title: "date-fns" }] },
      library__other: { type: "string", title: "Which library? — Other" },
    }),
    { wait: "form-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { text: "luxon" } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ action: "accept", content: { library__other: "luxon" } });
});

test("a questionnaire is never auto-answered: the grant and a remembered allow do not take it", async () => {
  const { niwa, records } = await stack([
    form("form-1", { colour: { type: "string", title: "Colour?", oneOf: [{ const: "red", title: "red" }, { const: "blue", title: "blue" }] } }),
    { wait: "form-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:*"] } });
  await nextRequest(niwa);
  expect(records.find((record) => record.type === "session.reverse.asked")?.data).toMatchObject({ route: "starter" });
});

test("a questionnaire that reaches a client without form support as a permission request is a choice, not a permission", async () => {
  const { niwa, records } = await stack([fallback("perm-1", "q1", "Which colour?", ["red", "blue"]), { wait: "perm-1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:*"] } });

  const request = await nextRequest(niwa);
  expect(request.input).toMatchObject({ kind: "choice", title: "Which colour?", allowOther: false });
  expect(request.input.options?.map((option) => [option.id, option.label, option.flavor])).toEqual([
    ["questionnaire:q1:red", "red", "plain"],
    ["questionnaire:q1:blue", "blue", "plain"],
  ]);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["questionnaire:q1:blue"] } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "selected", optionId: "questionnaire:q1:blue" } });
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "starter" });
});

test("the questionnaire form is declared only when the session has a place for its reverse requests", async () => {
  const { niwa } = await stack([]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await eventually(async () => (await logOf("initialize.log")).length === 1);
  expect((await logOf<{ clientCapabilities: Record<string, unknown> }>("initialize.log"))[0]?.clientCapabilities.elicitation).toEqual({ form: {} });

  await control?.dispose();
  await rm(join(dir, "initialize.log"));
  const bare = mcodeControl({ harness: HARNESS, lineage: "fork", binary: join(dir, "mcode"), mode: "ask" });
  control = bare;
  await bare.start({ prompt: promptFromText(""), cwd: dir });
  expect((await logOf<{ clientCapabilities: Record<string, unknown> }>("initialize.log"))[0]?.clientCapabilities.elicitation).toBeUndefined();
});

// -- the agent stops waiting ----------------------------------------------------------------------

test("when the agent cancels its request, niwa's request is cancelled and closed", async () => {
  const { niwa, records } = await stack([
    permission("perm-1", "tc-1", "Bash", { command: "sleep 99" }),
    { out: { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "perm-1" } } },
    { wait: "perm-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  expect(await reverseRequests(niwa)).toEqual([]);
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("when the agent cancels a questionnaire, the rest of its steps are not asked and the form is cancelled", async () => {
  const { niwa, records } = await stack([
    form("form-1", {
      one: { type: "string", title: "One?", oneOf: [{ const: "a", title: "a" }] },
      two: { type: "string", title: "Two?", oneOf: [{ const: "b", title: "b" }] },
    }),
    { out: { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "form-1" } } },
    { wait: "form-1" },
  ]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ action: "cancel" });
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  expect(await reverseRequests(niwa)).toEqual([]);
});

test("an interrupt cancels the request the agent was waiting on", async () => {
  const { niwa, records } = await stack([permission("perm-1", "tc-1", "Bash", { command: "sleep 99" }), { waitCancel: true }]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);

  await call(niwa, "session.interrupt", { session });
  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled" });
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("the end of the turn cancels what the agent left open", async () => {
  const { niwa, records } = await stack([permission("perm-1", "tc-1", "Bash", { command: "ls" })]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  expect(await reverseRequests(niwa)).toEqual([]);
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

// -- a handler of the control side itself ---------------------------------------------------------

async function startedWith(handler: ReverseHandler, script: readonly Step[]): Promise<void> {
  control = mcodeControl({ harness: HARNESS, binary: await fakeAgent(script, "upstream"), mode: "ask" });
  await control.start({ prompt: promptFromText("go"), cwd: dir, reverse: handler });
}

test("a handler that fails answers cancelled: the turn does not hang", async () => {
  await startedWith(
    async () => {
      throw new Error("boom");
    },
    [permission("perm-1", "tc-1", "Bash", { command: "ls" }), { wait: "perm-1" }],
  );
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("an answer that is not one of the offered once-only ids is answered cancelled", async () => {
  await startedWith(async (): Promise<Answer> => ({ ids: [OptionIdSchema.parse("allow-always")] }), [
    permission("perm-1", "tc-1", "Bash", { command: "ls" }),
    { wait: "perm-1" },
  ]);
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
});

test("a questionnaire the control side cannot make into questions is refused, so the agent does not wait", async () => {
  await startedWith(async () => ({ cancelled: true }), [form("form-1", { n: { type: "number", title: "How many?" } }), { wait: "form-1" }]);
  await eventually(() => repliesCount(1));
  expect((await repliesOf())[0]?.error).toMatchObject({ code: -32602 });
});

// -- live --------------------------------------------------------------------------------------

test.skipIf(!live || Bun.which("mcode") === null)(
  "the real mcode asks for permission in mode ask, and the answer given through request.answer lets it write",
  async () => {
    const home = await tempHome();
    const side = mcodeControl({ harness: HARNESS, lineage: "fork", mode: "ask", model: "minimax/MiniMax-M3.1-Flash", turnTimeoutMs: 120_000 });
    const niwa = createNiwa({ home: home.path });
    niwa.use(requests({ bind: () => owner }));
    niwa.use(sessions({ harnesses: [{ instance: installation("ncode"), control: side }] }));
    await niwa.serve();
    try {
      // A write inside the working directory is allowed by mcode itself; one outside it asks.
      const cwd = join(dir, "work");
      const target = join(dir, "outside", "note.txt");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(dir, "outside"), { recursive: true });
      await call(niwa, "session.start", {
        harness: HARNESS,
        mode: "ask",
        cwd,
        prompt: `Use the Write tool to create the file ${target} with the text hello. Then reply done.`,
      });
      const request = await nextRequest(niwa, 120_000);
      expect(request.input).toMatchObject({ kind: "permission", subject: { tool: "write", kind: "edit", target } });
      const allow = request.input.options?.find((option) => option.flavor === "allow_once");
      expect(allow).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [allow?.id] } });
      await eventually(async () => await Bun.file(target).exists(), 120_000, "the file was not written after the permission was allowed");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  240_000,
);
