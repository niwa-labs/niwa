// Reverse requests through the sessions module.
//
// A fake control side keeps the handler it was given at the start and calls it the way an adapter
// does: a question and the raw request of its harness. The tests look at what the starter is asked,
// what is answered without asking, and what the journal says.

import { afterEach, expect, test } from "bun:test";

import { OptionIdSchema, owner, seq } from "@niwa-labs/core";
import type { ActionName, Answer, Question, StoredRecord } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  ReverseHandler,
  SessionControl,
  SessionId,
  SessionState,
  StartedSession,
  StartOptions,
} from "@niwa-labs/harness";
import { createNiwa, eventually, requests, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { sessions } from "../src/index.ts";

const HARNESS = "fake-harness";

const id = (text: string) => OptionIdSchema.parse(text);
/** An answer that picks options. */
const picks = (...texts: string[]): Answer => ({ ids: texts.map(id) });

/** A control side that names a session and keeps the handler of its reverse requests. */
class ReverseControl implements SessionControl {
  handler: ReverseHandler | undefined;
  id: SessionId | undefined;
  /** The servers the session was started with. */
  servers: StartOptions["servers"];

  async start(options: StartOptions): Promise<StartedSession> {
    this.handler = options.reverse;
    this.servers = options.servers;
    this.id = sessionId(harnessId(HARNESS), "session-1");
    return { session: this.id };
  }

  async resume(): Promise<void> {}

  async send(): Promise<DeliveryReceipt> {
    return { status: "started", turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, _options: AskOptions<T>): Promise<AskAnswer<T>> {
    throw new Error(`not asked: ${id.native}`);
  }

  async *life(): AsyncIterable<LifeEvent> {
    await new Promise<void>(() => {});
  }

  async state(): Promise<SessionState> {
    return "idle";
  }

  /** What an adapter does: hand the handler a question and the raw request, and wait for the answer. */
  async reverse(question: Question, signal: AbortSignal = new AbortController().signal): Promise<Answer> {
    if (this.handler === undefined || this.id === undefined) throw new Error("no session was started");
    return await this.handler(this.id, { question, raw: { method: "fake/request", params: { question } }, signal });
  }
}

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: false, launch: { model: false, effort: [], modes: [] }, tools: { niwaOnly: true, allow: true } } },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function serve(
  control: ReverseControl,
  existing?: string,
  niwaMcp?: { command: string; args: readonly string[] },
): Promise<{ niwa: Host; records: StoredRecord[]; home: string }> {
  const fresh = existing === undefined ? await tempHome() : undefined;
  const homePath = existing ?? fresh?.path ?? "";
  const niwa = createNiwa({ home: homePath });
  niwa.use(requests({ bind: () => owner }));
  niwa.use(sessions({ harnesses: [{ instance: installation, control }], ...(niwaMcp === undefined ? {} : { niwaMcp }) }));
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const record of niwa.records.since(seq(0))) records.push(record);
  })();
  open.push(async () => {
    await niwa.close();
    await fresh?.cleanup();
  });
  return { niwa, records, home: homePath };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

interface OpenRequest {
  id: string;
  question: string;
  to: { kind: string };
  input: Question;
  answer?: Record<string, unknown>;
}

async function openRequests(niwa: Host): Promise<OpenRequest[]> {
  const { requests: all } = await call<{ requests: OpenRequest[] }>(niwa, "request.open", {});
  return all.filter((entry) => entry.question === "session.reverse");
}

async function nextRequest(niwa: Host): Promise<OpenRequest> {
  let found: OpenRequest | undefined;
  await eventually(async () => {
    found = (await openRequests(niwa))[0];
    return found !== undefined;
  });
  if (found === undefined) throw new Error("no request");
  return found;
}

const permission = (target: string, tool?: string): Question => ({
  kind: "permission",
  title: `run ${target}`,
  options: [
    { id: id("allow"), label: "Allow", flavor: "allow_once" },
    { id: id("reject"), label: "Reject", flavor: "reject_once" },
  ],
  subject: { ...(tool === undefined ? {} : { tool }), kind: "execute", target },
});

const typesOf = (records: StoredRecord[]): string[] => records.map((record) => record.type).filter((type) => type.startsWith("session.reverse"));

async function started(niwa: Host, visible?: { actions: string[] }): Promise<void> {
  await call(niwa, "session.start", { harness: HARNESS, prompt: "go", ...(visible === undefined ? {} : { visible }) });
}

test("a permission the grant does not cover is a request to the starter, and the answer goes back as it was picked", async () => {
  const control = new ReverseControl();
  const { niwa, records } = await serve(control);
  await started(niwa);

  const answered = control.reverse(permission("ls", "Bash"));
  const request = await nextRequest(niwa);

  expect(request.to).toEqual({ kind: "owner" });
  expect(request.input.kind).toBe("permission");
  // The starter may allow it for the rest of the session, though the harness offered no such thing.
  expect(request.input.kind === "permission" && request.input.options.map((option) => option.flavor)).toEqual([
    "allow_once",
    "reject_once",
    "allow_always",
  ]);

  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow"] } });
  expect(await answered).toEqual(picks("allow"));

  await eventually(() => typesOf(records).includes("session.reverse.answered"));
  const asked = records.find((record) => record.type === "session.reverse.asked");
  expect(asked?.data).toMatchObject({ route: "starter", raw: { method: "fake/request" } });
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "starter", answer: { ids: ["allow"] } });
});

test("rejecting answers the harness's once-only reject", async () => {
  const control = new ReverseControl();
  const { niwa } = await serve(control);
  await started(niwa);

  const answered = control.reverse(permission("rm x"));
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["reject"] } });
  expect(await answered).toEqual(picks("reject"));
});

test("an answer outside the options of the question is refused and the question stays open", async () => {
  const control = new ReverseControl();
  const { niwa } = await serve(control);
  await started(niwa);

  const answered = control.reverse(permission("ls"));
  const request = await nextRequest(niwa);
  await expect(call(niwa, "request.answer", { id: request.id, answer: { ids: ["nonsense"] } })).rejects.toThrow();
  expect((await openRequests(niwa)).length).toBe(1);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow"] } });
  await answered;
});

test("a tool the session's grant covers is allowed without a request", async () => {
  const control = new ReverseControl();
  const { niwa, records } = await serve(control);
  await started(niwa, { actions: ["tool:Bash"] });

  expect(await control.reverse(permission("ls", "Bash"))).toEqual(picks("allow"));
  expect(await openRequests(niwa)).toEqual([]);
  await eventually(() => typesOf(records).includes("session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });
  expect(records.find((record) => record.type === "session.reverse.asked")?.data).toMatchObject({ route: "grant" });
});

test("a tool of niwa's own server is allowed by the grant of a session that was given the server; a tool of another server is asked", async () => {
  const control = new ReverseControl();
  const { niwa, records } = await serve(control, undefined, { command: "niwa", args: ["mcp"] });
  await started(niwa, { actions: ["task.create"] });
  const server = control.servers?.[0]?.name ?? "";
  expect(server).not.toBe("");

  expect(await control.reverse(permission("{}", `mcp__${server}__task_create`))).toEqual(picks("allow"));
  expect(await openRequests(niwa)).toEqual([]);
  await eventually(() => typesOf(records).includes("session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "grant" });

  const other = control.reverse(permission("{}", "mcp__github__create_issue"));
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["reject"] } });
  expect(await other).toEqual(picks("reject"));
});

test("a session that was given no niwa server is asked about a tool that carries the name of one", async () => {
  const control = new ReverseControl();
  const { niwa } = await serve(control, undefined, { command: "niwa", args: ["mcp"] });
  await started(niwa);
  expect(control.servers).toBeUndefined();

  const answered = control.reverse(permission("{}", "mcp__niwa__task_create"));
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["allow"] } });
  expect(await answered).toEqual(picks("allow"));
});

test("allow always is remembered by niwa: the next matching request is allowed once, with no new request", async () => {
  const control = new ReverseControl();
  const { niwa, records } = await serve(control);
  await started(niwa);

  const first = control.reverse(permission("ls -la"));
  const request = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: request.id, answer: { ids: ["niwa.allow_always"] } });
  // The harness is never given its own "always": it is told to allow this once.
  expect(await first).toEqual(picks("allow"));

  expect(await control.reverse(permission("ls -la"))).toEqual(picks("allow"));
  expect(await openRequests(niwa)).toEqual([]);
  expect(records.filter((record) => record.type === "request.created").length).toBe(1);
  await eventually(() => records.some((record) => record.type === "session.reverse.answered" && (record.data as { by: string }).by === "remembered"));

  // Another target is another request.
  const other = control.reverse(permission("rm -rf /"));
  const second = await nextRequest(niwa);
  await call(niwa, "request.answer", { id: second.id, answer: { ids: ["reject"] } });
  expect(await other).toEqual(picks("reject"));
});

test("when the harness stops waiting the niwa request is cancelled and the record says so", async () => {
  const control = new ReverseControl();
  const { niwa, records } = await serve(control);
  await started(niwa);

  const gone = new AbortController();
  const answered = control.reverse(permission("sleep 100"), gone.signal);
  await nextRequest(niwa);
  gone.abort();

  expect(await answered).toEqual({ cancelled: true });
  await eventually(async () => (await openRequests(niwa)).length === 0);
  await eventually(() => records.some((record) => record.type === "request.cancelled"));
  await eventually(() => records.some((record) => record.type === "session.reverse.answered"));
  expect(records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled", answer: { cancelled: true } });
});

test("a question is a request to the starter and a text may be given instead of an option when the question allows it", async () => {
  const control = new ReverseControl();
  const { niwa } = await serve(control);
  await started(niwa);

  const question: Question = {
    kind: "choice",
    title: "Which library?",
    options: [
      { id: id("option-1"), label: "date-fns", flavor: "plain" },
      { id: id("option-2"), label: "dayjs", flavor: "plain" },
    ],
    allowOther: true,
  };
  const answered = control.reverse(question);
  const request = await nextRequest(niwa);
  await expect(call(niwa, "request.answer", { id: request.id, answer: { ids: ["option-1", "option-2"] } })).rejects.toThrow();
  await call(niwa, "request.answer", { id: request.id, answer: { text: "luxon" } });
  expect(await answered).toEqual({ text: "luxon" });
});

test("a question that does not allow other refuses a free text, and a form takes a value of its own schema", async () => {
  const control = new ReverseControl();
  const { niwa } = await serve(control);
  await started(niwa);

  const closed = control.reverse({ kind: "confirm", title: "Go?", options: [{ id: id("yes"), label: "Yes", flavor: "plain" }, { id: id("no"), label: "No", flavor: "plain" }], allowOther: false });
  const first = await nextRequest(niwa);
  await expect(call(niwa, "request.answer", { id: first.id, answer: { text: "maybe" } })).rejects.toThrow();
  await call(niwa, "request.answer", { id: first.id, answer: { ids: ["no"] } });
  expect(await closed).toEqual(picks("no"));

  const form = control.reverse({
    kind: "form",
    title: "Deploy",
    schema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
  });
  const second = await nextRequest(niwa);
  await expect(call(niwa, "request.answer", { id: second.id, answer: { form: {} } })).rejects.toThrow();
  await call(niwa, "request.answer", { id: second.id, answer: { form: { env: "staging" } } });
  expect(await form).toEqual({ form: { env: "staging" } });
});

test("a question left open when the host stopped is closed when the host serves again: nobody waits for it", async () => {
  const control = new ReverseControl();
  const first = await serve(control);
  await started(first.niwa);
  void control.reverse(permission("sleep 99")).catch(() => {});
  await nextRequest(first.niwa);
  await first.niwa.close();

  const second = await serve(new ReverseControl(), first.home);
  await eventually(async () => (await openRequests(second.niwa)).length === 0);
  await eventually(() => second.records.some((record) => record.type === "request.cancelled"));
  await eventually(() => second.records.some((record) => record.type === "session.reverse.answered"));
  expect(second.records.find((record) => record.type === "session.reverse.answered")?.data).toMatchObject({ by: "cancelled" });
});
