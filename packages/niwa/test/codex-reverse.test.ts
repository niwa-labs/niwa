/**
 * Reverse requests of Codex.
 *
 * A fake `codex app-server` makes the requests Codex makes in a turn (the approval of a command, of a
 * file change and of extra permissions, `item/tool/requestUserInput`) and waits for the replies.
 * Some tests hand the control side a handler and look at what it is given and how its answer is
 * sent back; the others run the whole way, through the sessions module and the requests module, to
 * the one who started the session. The live test at the end runs the real Codex.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText } from "@niwa-labs/harness";
import type { Harness, ReverseHandler, ReverseRequest, SessionId } from "@niwa-labs/harness";
import { CODEX_LAUNCH, codexControl } from "@niwa-labs/harness-codex";
import type { CodexSessionControl } from "@niwa-labs/harness-codex";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempDir, tempHome, live } from "@niwa-labs/testing";

import * as framesOf from "./fixtures/codex-frames.ts";

const THREAD = "11111111-2222-3333-4444-555555555555";

/** The frames the fake sends, built as the real server builds them; the fake script imports them by path. */
const FRAMES = new URL("./fixtures/codex-frames.ts", import.meta.url).pathname;

let dir = "";
let control: CodexSessionControl | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("codex-reverse");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

const id = (text: string) => OptionIdSchema.parse(text);
const picks = (...texts: string[]): Answer => ({ ids: texts.map(id) });

/** What the fake server does in its first turn, in order. */
type Step =
  | { readonly out: unknown }
  | { readonly wait: string | number }
  | { readonly waitInterrupt: true }
  | { readonly ms: number };

const request = (frameId: string | number, method: string, params: unknown): Step => ({ out: { jsonrpc: "2.0", id: frameId, method, params } });

const notice = (method: string, params: unknown): Step => ({ out: { jsonrpc: "2.0", method, params } });

const command = (frameId: string | number, params: Record<string, unknown>): Step => ({
  out: framesOf.serverRequest(frameId, "item/commandExecution/requestApproval", THREAD, "t1", framesOf.commandApprovalParams(params)),
});

const fileChangeStarted = (itemId: string, paths: string[]): Step => ({ out: framesOf.fileChangeStarted(THREAD, "t1", itemId, paths) });

const fileChange = (frameId: string | number, params: Record<string, unknown>): Step =>
  request(frameId, "item/fileChange/requestApproval", { threadId: THREAD, turnId: "t1", itemId: "patch-1", startedAtMs: 1, ...params });

const permissionsRequest = (frameId: string | number, permissions: unknown, reason: string | null = null): Step =>
  request(frameId, "item/permissions/requestApproval", {
    threadId: THREAD,
    turnId: "t1",
    itemId: "call-2",
    environmentId: null,
    startedAtMs: 1,
    cwd: dir,
    reason,
    permissions,
  });

const userInput = (frameId: string | number, asked: unknown[]): Step =>
  request(frameId, "item/tool/requestUserInput", { threadId: THREAD, turnId: "t1", itemId: "call-3", isBlocking: true, autoResolutionMs: null, questions: asked });

/** The elicitation Codex makes to ask leave to call a tool of an MCP server, as it words it. */
const toolApproval = (frameId: string | number, server: string, tool: string): Step =>
  request(frameId, "mcpServer/elicitation/request", {
    threadId: THREAD,
    turnId: "t1",
    serverName: server,
    mode: "form",
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: "mcp_tool_call", tool_name: tool, tool_params: { id: 1 }, persist: ["session", "always"] },
    requestedSchema: { type: "object", properties: {} },
  });

const resolved = (requestId: string | number): Step => notice("serverRequest/resolved", { threadId: THREAD, requestId });

/**
 * A fake `codex app-server`. In its first turn it plays `script`, waiting for the client's reply to
 * a request where the script says so, and then completes the turn. A `turn/interrupt` ends the turn
 * as interrupted at once. It logs every request of the client and every reply it gets.
 */
async function fakeCodex(script: readonly Step[]): Promise<string> {
  const path = join(dir, "codex");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { agentMessageCompleted, turnCompleted, turnStarted } from ${JSON.stringify(FRAMES)};
const THREAD = ${JSON.stringify(THREAD)};
const log = (name, value) => appendFileSync(${JSON.stringify(dir)} + "/" + name, JSON.stringify(value) + "\\n");
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const script = ${JSON.stringify(script)};
const replies = new Map();
const waiters = new Map();
let wake;
let turns = 0;
async function play(turnId) {
  let interrupted = false;
  if (turns === 1) {
    for (const step of script) {
      if (step.out !== undefined) process.stdout.write(JSON.stringify(step.out) + "\\n");
      else if (step.ms !== undefined) await Bun.sleep(step.ms);
      else if (step.wait !== undefined) {
        const outcome = await Promise.race([
          replies.has(step.wait) ? Promise.resolve("reply") : new Promise((resolve) => waiters.set(step.wait, () => resolve("reply"))),
          new Promise((resolve) => { wake = () => resolve("interrupt"); }),
        ]);
        if (outcome === "interrupt") { interrupted = true; break; }
      } else if (step.waitInterrupt) {
        await new Promise((resolve) => { wake = resolve; });
        interrupted = true;
        break;
      }
    }
  }
  send(agentMessageCompleted(THREAD, turnId, "ok"));
  send(turnCompleted(THREAD, turnId, interrupted ? "interrupted" : "completed"));
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.method !== undefined) log("requests.log", { method: frame.method, params: frame.params });
    if (frame.method === "initialize") send({ id: frame.id, result: {} });
    else if (frame.method === "thread/start") send({ id: frame.id, result: { thread: { id: "${THREAD}" } } });
    else if (frame.method === "turn/start") {
      turns += 1;
      const turnId = "t" + turns;
      send({ id: frame.id, result: { turn: { id: turnId } } });
      send(turnStarted(THREAD, turnId));
      void play(turnId);
    } else if (frame.method === "turn/interrupt") {
      send({ id: frame.id, result: {} });
      wake?.();
    } else if (frame.method === undefined && frame.id !== undefined) {
      log("replies.log", frame);
      replies.set(frame.id, frame);
      waiters.get(frame.id)?.();
    }
  }
});
`,
  );
  await chmod(path, 0o755);
  return path;
}

interface Reply {
  readonly id: string | number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

const repliesOf = async (): Promise<Reply[]> =>
  (await readFile(join(dir, "replies.log"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Reply);

const replied = (count: number) => async () => (await repliesOf()).length >= count;

/** A handler that keeps what it was given, and answers with what the test says. */
function handler(answer: (request: ReverseRequest, nth: number) => Promise<Answer> | Answer): { handler: ReverseHandler; seen: ReverseRequest[] } {
  const seen: ReverseRequest[] = [];
  return {
    seen,
    handler: async (_session, given) => {
      seen.push(given);
      return await answer(given, seen.length);
    },
  };
}

/** A handler that waits until the harness stops waiting, then answers cancelled. */
function waitingHandler(): { handler: ReverseHandler; signal: () => AbortSignal | undefined } {
  let signal: AbortSignal | undefined;
  const { handler: given } = handler((asked) => {
    signal = asked.signal;
    return new Promise<Answer>((resolve) => asked.signal.addEventListener("abort", () => resolve({ cancelled: true })));
  });
  return { handler: given, signal: () => signal };
}

async function startedWith(reverse: ReverseHandler | undefined, script: readonly Step[]): Promise<{ side: CodexSessionControl; session: SessionId }> {
  const side = codexControl({ harness: "fake", binary: await fakeCodex(script), turnTimeoutMs: 10_000 });
  control = side;
  const { session } = await side.start({ prompt: promptFromText("go"), cwd: dir, ...(reverse === undefined ? {} : { reverse }) });
  return { side, session };
}

const options = (question: ReverseRequest["question"] | undefined) =>
  question !== undefined && "options" in question ? question.options.map((option) => [String(option.id), option.flavor]) : undefined;

test("a command approval is a permission with the command, and only the once-only options", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [command(7, { command: "ls -la", cwd: "/work", reason: "to look" }), { wait: 7 }]);
  await eventually(replied(1));

  expect(seen[0]?.question).toMatchObject({
    kind: "permission",
    title: "ls -la",
    detail: "to look\nin /work",
    subject: { tool: "commandExecution", kind: "execute", target: "/work\nls -la" },
  });
  expect(options(seen[0]?.question)).toEqual([
    ["accept", "allow_once"],
    ["decline", "reject_once"],
  ]);
  expect(seen[0]?.raw.method).toBe("item/commandExecution/requestApproval");
  expect(seen[0]?.raw.params).toMatchObject({ command: "ls -la", itemId: "call-1" });
  expect((await repliesOf())[0]).toMatchObject({ id: 7, result: { decision: "accept" } });
});

test("a decline goes back as decline, a cancelled answer as cancel", async () => {
  const { handler: given } = handler((_asked, nth) => (nth === 1 ? picks("decline") : { cancelled: true }));
  await startedWith(given, [command("a", { command: "rm x" }), { wait: "a" }, command("b", { command: "rm y" }), { wait: "b" }]);
  await eventually(replied(2));
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([{ decision: "decline" }, { decision: "cancel" }]);
});

test("Codex's own always and amendments are never sent: the proposals stay in the raw request", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [
    command("a", { command: "git status", proposedExecpolicyAmendment: ["git", "status"], networkApprovalContext: null }),
    { wait: "a" },
  ]);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "accept" });
  expect(seen[0]?.raw.params).toMatchObject({ proposedExecpolicyAmendment: ["git", "status"] });
});

test("a network approval is a request about the host", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [command("a", { command: null, networkApprovalContext: { host: "example.com", protocol: "https" } }), { wait: "a" }]);
  await eventually(replied(1));
  expect(seen[0]?.question).toMatchObject({
    title: "Network access: https://example.com",
    subject: { tool: "commandExecution", kind: "network", target: "https://example.com" },
  });
});

test("a file change approval is about the paths Codex announced for the item", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [
    fileChangeStarted("patch-1", ["/work/a.txt", "/work/b.txt"]),
    fileChange("p", { reason: "write access" }),
    { wait: "p" },
  ]);
  await eventually(replied(1));
  expect(seen[0]?.question).toMatchObject({
    kind: "permission",
    title: "Change files: /work/a.txt, /work/b.txt",
    detail: "write access",
    subject: { tool: "fileChange", kind: "edit", target: "/work/a.txt\n/work/b.txt" },
  });
  expect((await repliesOf())[0]?.result).toEqual({ decision: "accept" });
});

test("a file change nothing announced is told apart by its item", async () => {
  const { handler: given, seen } = handler(() => picks("decline"));
  await startedWith(given, [fileChange("p", { itemId: "patch-9" }), { wait: "p" }]);
  await eventually(replied(1));
  expect(seen[0]?.question).toMatchObject({ subject: { kind: "edit", target: "patch-9" } });
  expect((await repliesOf())[0]?.result).toEqual({ decision: "decline" });
});

test("extra permissions: allowed is granted for the turn, as asked; declined is granted nothing", async () => {
  const asked = { network: { enabled: true }, fileSystem: null };
  const { handler: given, seen } = handler((_request, nth) => (nth === 1 ? picks("accept") : picks("decline")));
  await startedWith(given, [permissionsRequest("a", asked, "needs the net"), { wait: "a" }, permissionsRequest("b", asked), { wait: "b" }]);
  await eventually(replied(2));
  expect(seen[0]?.question).toMatchObject({ kind: "permission", subject: { tool: "permissions", kind: "permissions", target: '{"network":{"enabled":true}}' } });
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([
    { permissions: { network: { enabled: true } }, scope: "turn" },
    { permissions: {}, scope: "turn" },
  ]);
});

test("a request that is not well formed is refused as a session with nobody to ask refuses it", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [permissionsRequest("a", "not a profile"), { wait: "a" }]);
  await eventually(replied(1));
  expect(seen).toEqual([]);
  expect((await repliesOf())[0]?.result).toEqual({ permissions: {}, scope: "turn" });
});

test("a handler that fails answers cancelled: the turn does not hang", async () => {
  const { handler: given } = handler(() => {
    throw new Error("boom");
  });
  const { side, session } = await startedWith(given, [command("a", { command: "ls" }), { wait: "a" }]);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "cancel" });
  await eventually(async () => (await side.state(session)) === "idle");
});

test("a session without a handler is still answered by the policy", async () => {
  await startedWith(undefined, [command("a", { command: "ls" }), { wait: "a" }, userInput("b", []), { wait: "b" }]);
  await eventually(replied(2));
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([{ decision: "decline" }, { answers: {} }]);
});

test("Codex's resolved notice aborts what it waits for, and the request is answered anyway", async () => {
  const { handler: given, signal } = waitingHandler();
  await startedWith(given, [command("a", { command: "sleep 99" }), resolved("a"), { wait: "a" }]);
  await eventually(() => signal()?.aborted === true);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "cancel" });
});

test("a resolved notice for another request leaves the waiting one alone", async () => {
  const { handler: given, signal } = waitingHandler();
  const { side, session } = await startedWith(given, [command("a", { command: "ls" }), resolved("other"), { waitInterrupt: true }]);
  await eventually(() => signal() !== undefined);
  await Bun.sleep(100);
  expect(signal()?.aborted).toBe(false);
  await side.interrupt(session);
  await eventually(() => signal()?.aborted === true);
});

test("an interrupt aborts what Codex waits for, and the request is answered cancelled", async () => {
  const { handler: given, signal } = waitingHandler();
  const { side, session } = await startedWith(given, [command("a", { command: "sleep 99" }), { wait: "a" }]);
  await eventually(() => signal() !== undefined);
  expect(signal()?.aborted).toBe(false);

  await side.interrupt(session);
  expect(signal()?.aborted).toBe(true);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "cancel" });
});

test("the end of the turn aborts what Codex was still waiting for", async () => {
  const { handler: given, signal } = waitingHandler();
  // Codex does not wait for the answer: it ends the turn with the request open.
  await startedWith(given, [command("a", { command: "ls" })]);
  await eventually(() => signal()?.aborted === true);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "cancel" });
});

test("the end of the process aborts what Codex waited for", async () => {
  const { handler: given, signal } = waitingHandler();
  const { side, session } = await startedWith(given, [command("a", { command: "ls" }), { waitInterrupt: true }]);
  await eventually(() => signal() !== undefined);
  await side.stop(session);
  expect(signal()?.aborted).toBe(true);
});

const colours = {
  id: "colour",
  header: "Colour",
  question: "Which colour?",
  isOther: true,
  isSecret: false,
  options: [
    { label: "red", description: "warm" },
    { label: "blue", description: "" },
  ],
};
const name = { id: "name", header: "Name", question: "Your name?", isOther: false, isSecret: false, options: null };

test("requestUserInput goes one question at a time: options are a choice, none is a text; labels and words come back by question id", async () => {
  const { handler: given, seen } = handler((asked) => (asked.question.kind === "choice" ? picks("option-2") : { text: "Pavel" }));
  await startedWith(given, [userInput(5, [colours, name]), { wait: 5 }]);
  await eventually(replied(1));

  expect(seen.map((asked) => asked.question)).toEqual([
    {
      kind: "choice",
      title: "Which colour?",
      detail: "Colour",
      options: [
        { id: id("option-1"), label: "red", description: "warm", flavor: "plain" },
        { id: id("option-2"), label: "blue", flavor: "plain" },
      ],
      allowOther: true,
    },
    { kind: "text", title: "Your name?", detail: "Name" },
  ]);
  expect(seen[0]?.raw.method).toBe("item/tool/requestUserInput");
  expect((await repliesOf())[0]?.result).toEqual({ answers: { colour: { answers: ["blue"] }, name: { answers: ["Pavel"] } } });
});

test("a question answered with other words returns the words", async () => {
  const { handler: given } = handler(() => ({ text: "green" }));
  await startedWith(given, [userInput(5, [colours]), { wait: 5 }]);
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ answers: { colour: { answers: ["green"] } } });
});

test("a question nobody answers ends the call with no answers, and the next is not asked", async () => {
  const { handler: given, seen } = handler(() => ({ cancelled: true }));
  await startedWith(given, [userInput(5, [colours, name]), { wait: 5 }]);
  await eventually(replied(1));
  expect(seen.length).toBe(1);
  expect((await repliesOf())[0]?.result).toEqual({ answers: {} });
});

test("the approval of an MCP tool is a permission under the tool's harness name; allow and decline go back as accept and decline", async () => {
  const { handler: given, seen } = handler((_asked, nth) => (nth === 1 ? picks("accept") : picks("decline")));
  await startedWith(given, [toolApproval("a", "niwa", "task_finish"), { wait: "a" }, toolApproval("b", "niwa", "task_finish"), { wait: "b" }]);
  await eventually(replied(2));
  expect(seen[0]?.question).toMatchObject({ kind: "permission", subject: { tool: "mcp__niwa__task_finish", kind: "mcp" } });
  expect(options(seen[0]?.question)).toEqual([
    ["accept", "allow_once"],
    ["decline", "reject_once"],
  ]);
  expect(seen[0]?.raw.method).toBe("mcpServer/elicitation/request");
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([
    { action: "accept", content: null, _meta: null },
    { action: "decline", content: null, _meta: null },
  ]);
});

test("a form of an MCP server is a form question, answered by its value; a cancelled answer is cancel", async () => {
  const form = (frameId: string): Step =>
    request(frameId, "mcpServer/elicitation/request", {
      threadId: THREAD,
      turnId: "t1",
      serverName: "x",
      mode: "form",
      message: "Which repo?",
      requestedSchema: { type: "object", properties: { repo: { type: "string", title: null } }, required: ["repo"] },
    });
  const { handler: given, seen } = handler((_asked, nth) => (nth === 1 ? { form: { repo: "niwa" } } : { cancelled: true }));
  await startedWith(given, [form("a"), { wait: "a" }, form("b"), { wait: "b" }]);
  await eventually(replied(2));
  expect(seen[0]?.question).toMatchObject({ kind: "form", title: "Which repo?" });
  expect((await repliesOf()).map((reply) => reply.result)).toEqual([
    { action: "accept", content: { repo: "niwa" }, _meta: null },
    { action: "cancel", content: null, _meta: null },
  ]);
});

test("an elicitation of a kind niwa cannot ask stays declined", async () => {
  const { handler: given, seen } = handler(() => picks("accept"));
  await startedWith(given, [
    request("a", "mcpServer/elicitation/request", { threadId: THREAD, turnId: "t1", serverName: "x", mode: "url", elicitationId: "e", message: "open", url: "https://x" }),
    { wait: "a" },
  ]);
  await eventually(replied(1));
  expect(seen).toEqual([]);
  expect((await repliesOf())[0]?.result).toEqual({ action: "decline", content: null, _meta: null });
});

// -- the whole way: sessions, requests, and the one who started the session ---------------------

const HARNESS = "codex-fake";

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("codex"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: CODEX_LAUNCH } },
};

async function stack(script: readonly Step[], niwaMcp?: { command: string; args: readonly string[] }): Promise<{ niwa: Host; records: StoredRecord[] }> {
  const side = codexControl({ harness: HARNESS, binary: await fakeCodex(script), turnTimeoutMs: 10_000 });
  control = side;
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control: side }], ...(niwaMcp === undefined ? {} : { niwaMcp }) }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since(seq(0))) records.push(record);
  })();
  closers.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return { niwa, records };
}

const call = <O>(niwa: Host, action: string, input: unknown): Promise<O> => niwa.call(action as ActionName, input) as Promise<O>;

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

async function nextRequest(niwa: Host, timeoutMs = 10_000, not?: string): Promise<OpenRequest> {
  let found: OpenRequest | undefined;
  await eventually(async () => {
    found = (await reverseRequests(niwa)).find((entry) => entry.id !== not);
    return found !== undefined;
  }, timeoutMs);
  if (found === undefined) throw new Error("no request");
  return found;
}

test("a command approval of a codex session is a request to the starter, and the answer goes back natively", async () => {
  const { niwa, records } = await stack([command("a", { command: "ls" }), { wait: "a" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const open = await nextRequest(niwa);
  expect(open.to).toEqual({ kind: "owner" });
  expect(open.input).toMatchObject({ kind: "permission", title: "ls" });
  expect(open.input.options?.map((option) => option.flavor)).toEqual(["allow_once", "reject_once", "allow_always"]);

  await call(niwa, "request.answer", { id: open.id, answer: { ids: ["accept"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "accept" });
  await eventually(() => records.some((entry) => entry.type === "session.reverse.answered"));
});

test("reject goes back as Codex's decline", async () => {
  const { niwa } = await stack([command("a", { command: "rm x" }), { wait: "a" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const open = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: open.id, answer: { ids: ["decline"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "decline" });
});

test("allow always: niwa answers the next matching approval with accept, never acceptForSession, and does not ask again", async () => {
  const { niwa, records } = await stack([command("a", { command: "ls" }), { wait: "a" }, command("b", { command: "ls" }), { wait: "b" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const open = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: open.id, answer: { ids: ["niwa.allow_always"] } });
  await eventually(replied(2));

  expect((await repliesOf()).map((reply) => reply.result)).toEqual([{ decision: "accept" }, { decision: "accept" }]);
  expect(records.filter((entry) => entry.type === "request.created").length).toBe(1);
  expect(records.filter((entry) => entry.type === "session.reverse.answered").map((entry) => (entry.data as { by: string }).by)).toEqual(["starter", "remembered"]);
});

test("allow always is for the same command only", async () => {
  const { niwa, records } = await stack([command("a", { command: "ls" }), { wait: "a" }, command("b", { command: "rm -rf /" }), { wait: "b" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const first = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["niwa.allow_always"] } });
  const second = await nextRequest(niwa, 10_000, first.id);
  expect(second.input.title).toBe("rm -rf /");
  expect(records.filter((entry) => entry.type === "request.created").length).toBe(2);
});

test("a tool the grant covers is allowed with no request", async () => {
  const { niwa, records } = await stack([command("a", { command: "ls" }), { wait: "a" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:commandExecution"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "accept" });
  expect(records.filter((entry) => entry.type === "request.created")).toEqual([]);
  expect(records.find((entry) => entry.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("a permissions request of a codex session is a request to the starter, granted for the turn once allowed", async () => {
  const { niwa } = await stack([permissionsRequest("a", { network: { enabled: true }, fileSystem: null }), { wait: "a" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  const open = await nextRequest(niwa);
  expect(open.input.kind).toBe("permission");
  await call(niwa, "request.answer", { id: open.id, answer: { ids: ["accept"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
});

test("a requestUserInput call of a codex session is a request per question to the starter", async () => {
  const { niwa } = await stack([userInput(5, [colours, name]), { wait: 5 }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const first = await nextRequest(niwa);
  expect(first.input).toMatchObject({ kind: "choice", title: "Which colour?" });
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["option-1"] } });

  const second = await nextRequest(niwa, 10_000, first.id);
  expect(second.input).toMatchObject({ kind: "text", title: "Your name?" });
  await call(niwa, "request.answer", { id: second.id, answer: { text: "Pavel" } });

  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ answers: { colour: { answers: ["red"] }, name: { answers: ["Pavel"] } } });
});

test("when Codex stops waiting, niwa's request is cancelled and closed", async () => {
  const { niwa, records } = await stack([command("a", { command: "sleep 99" }), { waitInterrupt: true }]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);

  await call(niwa, "session.interrupt", { session });
  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((entry) => entry.type === "request.cancelled"));
  await eventually(() => records.some((entry) => entry.type === "session.reverse.answered"));
  expect(records.find((entry) => entry.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toEqual({ decision: "cancel" });
});

test("a resolved notice from Codex closes niwa's request", async () => {
  const { niwa, records } = await stack([command("a", { command: "ls" }), { ms: 200 }, resolved("a"), { wait: "a" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);
  await eventually(() => records.some((entry) => entry.type === "request.cancelled"));
  expect(await reverseRequests(niwa)).toEqual([]);
});

// -- live --------------------------------------------------------------------------------------

test.skipIf(!live || Bun.which("codex") === null)(
  "the real Codex asks for approval in mode ask, and the answer given through request.answer lets it run the command",
  async () => {
    const home = await tempHome();
    const side = codexControl({ harness: HARNESS, turnTimeoutMs: 180_000 });
    const niwa = createNiwa({ home: home.path });
    niwa.use(requests({ bind: () => owner }));
    niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
    await niwa.serve();
    try {
      const cwd = join(dir, "work");
      await mkdir(cwd, { recursive: true });
      await call(niwa, "session.start", {
        harness: HARNESS,
        mode: "ask",
        cwd,
        prompt: "Run the shell command `echo hello > note.txt` in the current directory, then reply done. Request approval when the sandbox blocks it.",
      });
      const open = await nextRequest(niwa, 150_000);
      expect(open.input.kind).toBe("permission");
      const allow = open.input.options?.find((option) => option.flavor === "allow_once");
      expect(allow).toBeDefined();
      await call(niwa, "request.answer", { id: open.id, answer: { ids: [allow?.id] } });
      await eventually(async () => await Bun.file(join(cwd, "note.txt")).exists(), 150_000, "the file was not written after the approval was given");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  300_000,
);

test("an MCP tool a grant covers is allowed with no request; another is asked of the starter", async () => {
  const { niwa, records } = await stack([toolApproval("a", "github", "create_issue"), { wait: "a" }, toolApproval("b", "other", "do"), { wait: "b" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["tool:mcp__github__create_issue"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toMatchObject({ action: "accept" });
  const open = await nextRequest(niwa);
  expect(open.input.title).toContain("other");
  expect(records.filter((entry) => entry.type === "request.created").length).toBe(1);
  expect(records.find((entry) => entry.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});

test("a tool of niwa's own server is allowed by the grant of its session without asking", async () => {
  const { niwa, records } = await stack([toolApproval("a", "niwa", "task_finish"), { wait: "a" }], { command: "niwa", args: ["mcp"] });
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir, visible: { actions: ["task.finish"] } });
  await eventually(replied(1));
  expect((await repliesOf())[0]?.result).toMatchObject({ action: "accept" });
  expect(records.filter((entry) => entry.type === "request.created")).toEqual([]);
  expect(records.find((entry) => entry.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
});
