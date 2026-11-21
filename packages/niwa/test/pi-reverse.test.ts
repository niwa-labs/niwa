/**
 * Reverse requests of pi's RPC mode.
 *
 * pi has no permission requests of its own: what a gate extension asks, it asks through the
 * dialogs of the extension protocol (`select`, `confirm`, `input`, `editor`), and those are the
 * questions niwa routes. A fake pi sends such dialogs in a run and records the answers it gets
 * back. Some tests hand the control side a handler; the others run the whole way, through the
 * sessions and requests modules, to the one who started the session.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { OptionIdSchema, seq, owner } from "@niwa-labs/core";
import type { ActionName, Answer, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, promptFromText } from "@niwa-labs/harness";
import type { Harness, ReverseHandler, ReverseRequest, SessionControl } from "@niwa-labs/harness";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempDir, tempHome, live } from "@niwa-labs/testing";

import { PI_LAUNCH, PiControl } from "@niwa-labs/harness-pi";

let dir = "";
let control: PiControl | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await tempDir("pi-reverse");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

const picks = (...texts: string[]): Answer => ({ ids: texts.map((text) => OptionIdSchema.parse(text)) });

/** What the fake pi does in its first run, in order. */
type DialogStep = { readonly out: unknown };
type Step = DialogStep | { readonly wait: string } | { readonly waitAbort: true } | { readonly ms: number };

const select = (id: string, title: string, options: unknown, extra: object = {}): DialogStep => ({
  out: { type: "extension_ui_request", id, method: "select", title, options, ...extra },
});
const confirm = (id: string, title: string, message?: string): DialogStep => ({
  out: { type: "extension_ui_request", id, method: "confirm", title, ...(message === undefined ? {} : { message }) },
});
const input = (id: string, title: string, placeholder?: string): DialogStep => ({
  out: { type: "extension_ui_request", id, method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
});
const editor = (id: string, title: string, prefill?: string): DialogStep => ({
  out: { type: "extension_ui_request", id, method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
});

/**
 * A fake `pi --mode rpc`. In its first run it plays `script`, waiting for the client's response to
 * a dialog where the script says so, and then ends the run. An `abort` ends the run at once. With
 * `second` it plays that script in its second run. With `early` it asks a dialog before it names
 * its session. It logs every `extension_ui_response`.
 */
async function fakePi(script: readonly Step[], early?: DialogStep, second: readonly Step[] = []): Promise<string> {
  const path = join(dir, "pi");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = (value) => appendFileSync(${JSON.stringify(dir)} + "/replies.log", JSON.stringify(value) + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const scripts = [${JSON.stringify(script)}, ${JSON.stringify(second)}];
const early = ${JSON.stringify(early?.out ?? null)};
const replies = new Map();
const waiters = new Map();
let abortWake;
let runs = 0;
async function play() {
  runs += 1;
  out({ type: "agent_start" });
  for (const step of scripts[runs - 1] ?? []) {
    if (step.out !== undefined) out(step.out);
    else if (step.ms !== undefined) await Bun.sleep(step.ms);
    else if (step.wait !== undefined) {
      await (replies.has(step.wait) ? Promise.resolve() : new Promise((resolve) => waiters.set(step.wait, resolve)));
    } else if (step.waitAbort) {
      await new Promise((resolve) => { abortWake = resolve; });
      break;
    }
  }
  out({ type: "agent_end", messages: [], willRetry: false });
}
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.type === "get_state") {
      if (early !== null) out(early);
      out({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: "pi-s1" } });
    } else if (frame.type === "prompt") {
      out({ type: "response", id: frame.id, command: "prompt", success: true });
      void play();
    } else if (frame.type === "abort") {
      out({ type: "response", id: frame.id, command: "abort", success: true });
      abortWake?.();
    } else if (frame.type === "extension_ui_response") {
      log(frame);
      replies.set(frame.id, frame);
      waiters.get(frame.id)?.();
    }
  }
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

interface Reply {
  readonly type: string;
  readonly id: string;
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: boolean;
}

const repliesOf = async (): Promise<Reply[]> =>
  (await readFile(join(dir, "replies.log"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Reply);

const repliesCount = async (count: number): Promise<void> => eventually(async () => (await repliesOf()).length >= count);

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

const waitsForAbort = (request: ReverseRequest): Promise<Answer> =>
  new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));

async function startedWith(reverse: ReverseHandler | undefined, script: readonly Step[], early?: DialogStep, second?: readonly Step[]) {
  const side = new PiControl({ harness: "pi-fake", binary: await fakePi(script, early, second), mode: "full" });
  control = side;
  const { session } = await side.start({ prompt: promptFromText("go"), cwd: dir, ...(reverse === undefined ? {} : { reverse }) });
  return { side, session };
}

test("a select is a choice with synthesized option ids, and the picked option goes back as pi's own string", async () => {
  const { handler: given, seen } = handler(() => picks("option-2"));
  await startedWith(given, [select("d1", "Allow rm -rf?", ["Allow", "Block"]), { wait: "d1" }]);
  await repliesCount(1);

  expect<unknown>(seen[0]?.question).toEqual({
    kind: "choice",
    title: "Allow rm -rf?",
    options: [
      { id: "option-1", label: "Allow", flavor: "plain" },
      { id: "option-2", label: "Block", flavor: "plain" },
    ],
    allowOther: false,
  });
  // The request is kept whole.
  expect(seen[0]?.raw).toMatchObject({ method: "select", params: { type: "extension_ui_request", id: "d1", options: ["Allow", "Block"] } });
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "d1", value: "Block" }]);
});

test("a confirm is a yes or no: yes is confirmed true, no is confirmed false, and the message is the detail", async () => {
  const { handler: given, seen } = handler((_request, nth) => picks(nth === 1 ? "option-1" : "option-2"));
  await startedWith(given, [confirm("c1", "Clear session?", "All messages will be lost."), { wait: "c1" }, confirm("c2", "Sure?"), { wait: "c2" }]);
  await repliesCount(2);

  expect(seen[0]?.question).toMatchObject({ kind: "confirm", title: "Clear session?", detail: "All messages will be lost." });
  expect(seen[0]?.question.kind === "confirm" && seen[0].question.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  expect(seen[1]?.question.kind === "confirm" && "detail" in seen[1].question).toBe(false);
  expect(await repliesOf()).toEqual([
    { type: "extension_ui_response", id: "c1", confirmed: true },
    { type: "extension_ui_response", id: "c2", confirmed: false },
  ]);
});

test("an input and an editor are free texts; what pi suggests is the detail, and the text goes back as the value", async () => {
  const { handler: given, seen } = handler((_request, nth) => ({ text: nth === 1 ? "main" : "Line 1\nLine 2 edited" }));
  await startedWith(given, [input("i1", "Branch?", "name..."), { wait: "i1" }, editor("e1", "Edit", "Line 1\nLine 2"), { wait: "e1" }]);
  await repliesCount(2);

  expect<unknown>(seen.map((request) => request.question)).toEqual([
    { kind: "text", title: "Branch?", detail: "name..." },
    { kind: "text", title: "Edit", detail: "Line 1\nLine 2" },
  ]);
  expect(await repliesOf()).toEqual([
    { type: "extension_ui_response", id: "i1", value: "main" },
    { type: "extension_ui_response", id: "e1", value: "Line 1\nLine 2 edited" },
  ]);
});

test("a cancelled answer, and a handler that fails, cancel the dialog: the run does not hang", async () => {
  const { handler: given } = handler((_request, nth) => {
    if (nth === 2) throw new Error("boom");
    return { cancelled: true };
  });
  await startedWith(given, [confirm("c1", "One?"), { wait: "c1" }, select("s1", "Two?", ["a"]), { wait: "s1" }]);
  await repliesCount(2);
  expect(await repliesOf()).toEqual([
    { type: "extension_ui_response", id: "c1", cancelled: true },
    { type: "extension_ui_response", id: "s1", cancelled: true },
  ]);
});

test("a select with nothing to choose from is cancelled without a question", async () => {
  const { handler: given, seen } = handler(() => picks("option-1"));
  await startedWith(given, [select("s1", "Pick", []), { wait: "s1" }]);
  await repliesCount(1);
  expect(seen).toEqual([]);
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "s1", cancelled: true }]);
});

test("the notices of pi are not questions", async () => {
  const { handler: given, seen } = handler(() => picks("option-1"));
  await startedWith(given, [
    { out: { type: "extension_ui_request", id: "n1", method: "notify", message: "hello" } },
    { out: { type: "extension_ui_request", id: "n2", method: "setStatus", statusKey: "k", statusText: "t" } },
    confirm("c1", "Go?"),
    { wait: "c1" },
  ]);
  await repliesCount(1);
  expect(seen.length).toBe(1);
});

test("a dialog pi asks before it has named its session waits for the name", async () => {
  const { handler: given, seen } = handler(() => picks("option-1"));
  await startedWith(given, [], confirm("early", "At start?"));
  await repliesCount(1);
  expect(seen[0]?.question).toMatchObject({ kind: "confirm", title: "At start?" });
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "early", confirmed: true }]);
});

test("an interrupt aborts the question and cancels the dialog", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return waitsForAbort(request);
  });
  const { side, session } = await startedWith(given, [select("d1", "Allow?", ["Allow", "Block"]), { waitAbort: true }]);
  await eventually(() => aborted !== undefined);
  expect(aborted?.aborted).toBe(false);

  await side.interrupt(session);
  expect(aborted?.aborted).toBe(true);
  await repliesCount(1);
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
  // The dialog is let go of before pi is told to abort, and it is answered once.
  const wire = side.frames.map((frame) => frame.type);
  expect(wire.indexOf("extension_ui_response")).toBeLessThan(wire.indexOf("abort"));
  expect(wire.filter((type) => type === "extension_ui_response").length).toBe(1);
});

test("pi's own timeout of a dialog aborts the question: nobody waits for the answer, and none is sent", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return waitsForAbort(request);
  });
  const { side } = await startedWith(given, [select("d1", "Quick?", ["Yes", "No"], { timeout: 150 }), { ms: 400 }]);
  await eventually(() => aborted?.aborted === true);
  await Bun.sleep(100);
  expect(side.frames.some((frame) => frame.type === "extension_ui_response")).toBe(false);
});

test("the end of pi's process aborts the question that was open", async () => {
  let aborted: AbortSignal | undefined;
  const { handler: given } = handler((request) => {
    aborted = request.signal;
    return waitsForAbort(request);
  });
  const { side, session } = await startedWith(given, [confirm("c1", "Go?"), { waitAbort: true }]);
  await eventually(() => aborted !== undefined);
  await side.stop(session);
  expect(aborted?.aborted).toBe(true);
});

test("a session started with no place for its dialogs has them declined; a resume names one from then on", async () => {
  const given = handler(() => picks("option-2"));
  const { side, session } = await startedWith(undefined, [confirm("c1", "One?"), { wait: "c1" }], undefined, [confirm("c2", "Two?"), { wait: "c2" }]);
  await repliesCount(1);
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "c1", cancelled: true }]);
  expect(given.seen).toEqual([]);

  await side.resume(session, { reverse: given.handler, prompt: promptFromText("again") });
  await repliesCount(2);
  expect(given.seen.length).toBe(1);
  expect((await repliesOf())[1]).toEqual({ type: "extension_ui_response", id: "c2", confirmed: false });
});

// -- the whole way: sessions, requests, and the one who started the session ---------------------

const HARNESS = "pi-fake";

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("pi"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: false, structuredOutput: false, launch: PI_LAUNCH } },
};

async function stack(script: readonly Step[]): Promise<{ niwa: Host; records: StoredRecord[]; side: SessionControl }> {
  const side = new PiControl({ harness: HARNESS, binary: await fakePi(script), mode: "full" });
  control = side;
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since(seq(0))) records.push(record);
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

test("a dialog of a pi session is a request to the starter, never answered by niwa, and the answer goes back natively", async () => {
  const { niwa, records } = await stack([select("d1", "Allow `rm x`?", ["Allow", "Block"]), { wait: "d1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const request = await nextRequest(niwa);
  expect(request.to).toEqual({ kind: "owner" });
  expect(request.input).toMatchObject({ kind: "choice", title: "Allow `rm x`?" });
  expect(request.input.options?.map((option) => option.label)).toEqual(["Allow", "Block"]);

  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["option-1"] } });
  await repliesCount(1);
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "d1", value: "Allow" }]);
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "starter" });
  expect(records.find((record) => record.type === "session.reverse.asked")?.data).toMatchObject({ raw: { method: "select" } });
});

test("a confirm and an input are requests too; a wrong option id is refused and the question stays open", async () => {
  const { niwa } = await stack([confirm("c1", "Go on?"), { wait: "c1" }, input("i1", "Name?"), { wait: "i1" }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });

  const first = await nextRequest(niwa);
  expect(first.input).toMatchObject({ kind: "confirm", title: "Go on?" });
  await expect(call(niwa, "request.answer", { id: first.id, answer: { ids: ["nope"] } })).rejects.toBeDefined();
  expect((await reverseRequests(niwa)).map((request) => request.id)).toEqual([first.id]);
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["option-2"] } });

  let second: OpenRequest | undefined;
  await eventually(async () => {
    second = (await reverseRequests(niwa))[0];
    return second !== undefined && second.id !== first.id;
  });
  expect(second?.input).toMatchObject({ kind: "text", title: "Name?" });
  await call(niwa, "request.answer", { id: second?.id, answer: { text: "rin" } });
  await repliesCount(2);
  expect(await repliesOf()).toEqual([
    { type: "extension_ui_response", id: "c1", confirmed: false },
    { type: "extension_ui_response", id: "i1", value: "rin" },
  ]);
});

test("when pi stops waiting (the run is interrupted), niwa's request is cancelled and closed", async () => {
  const { niwa, records } = await stack([select("d1", "Allow?", ["Allow", "Block"]), { waitAbort: true }]);
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);

  await call(niwa, "session.interrupt", { session });
  await eventually(async () => (await reverseRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
  expect(await repliesOf()).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
});

test("when pi's own timeout runs out, niwa's request is closed", async () => {
  const { niwa, records } = await stack([select("d1", "Quick?", ["Yes", "No"], { timeout: 200 }), { ms: 500 }]);
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", cwd: dir });
  await nextRequest(niwa);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  expect(await reverseRequests(niwa)).toEqual([]);
});

// -- live --------------------------------------------------------------------------------------

/** Whether a pi that runs is installed: a `pi` on the PATH that cannot even print its version is not one. */
const piRuns = live && Bun.which("pi") !== null && Bun.spawnSync(["pi", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/**
 * An extension with a command that asks a dialog and writes the answer to a file. A command is run
 * by pi itself, with no model, so the test needs no provider.
 */
const GATE = `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("gate", {
    description: "asks, then writes the choice",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Allow the gate?", ["Allow", "Block"]);
      writeFileSync(process.env.GATE_OUT, String(choice));
    },
  });
}
`;

test.skipIf(!piRuns)(
  "the real pi asks a dialog of an extension, and the answer given through request.answer reaches the extension",
  async () => {
    const agent = join(dir, "agent");
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(join(agent, "extensions", "gate.ts"), GATE);
    const out = join(dir, "gate.txt");
    const side = new PiControl({ harness: HARNESS, mode: "full", cwd: dir, env: { PI_CODING_AGENT_DIR: agent, GATE_OUT: out } });
    control = side;
    const home = await tempHome();
    const niwa = createNiwa({ home: home.path });
    niwa.use(requests({ bind: () => owner }));
    niwa.use(sessions({ harnesses: [{ instance: installation, control: side }] }));
    await niwa.serve();
    try {
      const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, cwd: dir, prompt: "" });
      // pi answers a command's prompt when the command is done, so the send waits for the dialog.
      void call(niwa, "session.send", { session, message: "/gate" }).catch(() => undefined);
      const request = await nextRequest(niwa, 60_000);
      expect(request.input).toMatchObject({ kind: "choice", title: "Allow the gate?" });
      const block = request.input.options?.find((option) => option.label === "Block");
      expect(block).toBeDefined();
      await call(niwa, "request.answer", { id: request.id, answer: { ids: [block?.id] } });
      await eventually(async () => (await readFile(out, "utf8").catch(() => "")) === "Block", 60_000, "the extension did not get the answer");
    } finally {
      await side.dispose();
      await niwa.close();
      await home.cleanup();
    }
  },
  120_000,
);
