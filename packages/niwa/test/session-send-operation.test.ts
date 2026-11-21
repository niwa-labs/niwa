// A send given an operation id: a retry with the same id answers what became of the message and
// sends it again only when it was never sent; another message under the same id is a conflict.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { InputNotSent, InputPossiblySent, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { AskAnswer, DeliveryReceipt, Harness, LifeEvent, SessionControl, SessionId, SessionState, StartedSession } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";
import { tempHome } from "@niwa-labs/testing";

const HARNESS = "fake-send";

/** A control side whose sends fail as they are told to, in order, then succeed. */
class ScriptedSend implements SessionControl {
  readonly sent: string[] = [];
  constructor(readonly failures: Array<"unsent" | "possibly" | "plain">) {}

  async start(): Promise<StartedSession> {
    return { session: sessionId(harnessId(HARNESS), "native-1") };
  }
  async resume(): Promise<void> {}
  async send(id: SessionId, message: string): Promise<DeliveryReceipt> {
    const failure = this.failures.shift();
    if (failure === "unsent") throw new InputNotSent(id.harness, "send", "the process was not running");
    this.sent.push(message);
    if (failure === "possibly") throw new InputPossiblySent(id.harness, "send", "the connection closed before the answer");
    if (failure === "plain") throw new Error("something broke after the write");
    return { status: "started", turn: this.sent.length };
  }
  async interrupt(): Promise<void> {}
  async ask<T>(): Promise<AskAnswer<T>> {
    throw new Error("not asked");
  }
  async *life(): AsyncIterable<LifeEvent> {}
  async state(): Promise<SessionState> {
    return "idle";
  }
}

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: false, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } } },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function serve(control: SessionControl, home?: string): Promise<{ niwa: Host; home: string; stop: () => Promise<void>; records: () => Promise<StoredRecord[]> }> {
  const fresh = home === undefined ? await tempHome() : undefined;
  const path = home ?? fresh!.path;
  const niwa = createNiwa({ home: path });
  niwa.use(sessions({ harnesses: [{ instance: installation, control }] }));
  await niwa.serve();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await niwa.close();
  };
  open.push(async () => {
    await stop();
    await fresh?.cleanup();
  });
  return { niwa, home: path, stop, records: () => niwa.records.read() };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;

async function started(niwa: Host): Promise<string> {
  const { session } = await call<{ session: string }>(niwa, "session.start", { harness: HARNESS, prompt: "" });
  return session;
}

test("a retry of an accepted send answers its receipt and sends nothing", async () => {
  const control = new ScriptedSend([]);
  const { niwa } = await serve(control);
  const session = await started(niwa);
  const first = await call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session, message: "go", operation: "op-1" });
  const again = await call<{ receipt: DeliveryReceipt }>(niwa, "session.send", { session, message: "go", operation: "op-1" });
  expect(again).toEqual(first);
  expect(control.sent).toEqual(["go"]);
});

test("a send that was never sent is sent again under the same id", async () => {
  const control = new ScriptedSend(["unsent"]);
  const { niwa } = await serve(control);
  const session = await started(niwa);
  await expect(call(niwa, "session.send", { session, message: "go", operation: "op-1" })).rejects.toMatchObject({ code: "InputNotSent" });
  await call(niwa, "session.send", { session, message: "go", operation: "op-1" });
  expect(control.sent).toEqual(["go"]);
});

test("a send that may have gone is never sent again, nor is one whose failure the side did not name", async () => {
  for (const failure of ["possibly", "plain"] as const) {
    const control = new ScriptedSend([failure]);
    const { niwa } = await serve(control);
    const session = await started(niwa);
    await expect(call(niwa, "session.send", { session, message: "go", operation: "op-1" })).rejects.toMatchObject({ code: "InputPossiblySent" });
    await expect(call(niwa, "session.send", { session, message: "go", operation: "op-1" })).rejects.toMatchObject({ code: "InputPossiblySent" });
    expect(control.sent).toEqual(["go"]);
  }
});

test("another message under an id already used is a conflict, and nothing is sent", async () => {
  const control = new ScriptedSend([]);
  const { niwa } = await serve(control);
  const session = await started(niwa);
  await call(niwa, "session.send", { session, message: "go", operation: "op-1" });
  await expect(call(niwa, "session.send", { session, message: "stop", operation: "op-1" })).rejects.toMatchObject({ code: "operation-conflict" });
  expect(control.sent).toEqual(["go"]);
});

test("a send cut off between its record and its outcome is taken for possibly sent after a restart", async () => {
  const first = await serve(new ScriptedSend([]));
  const session = await started(first.niwa);
  await first.stop();
  // The next host stops while the send is on its way: the record of the send is there, its outcome is not.
  const hang = new (class extends ScriptedSend {
    override async send(): Promise<DeliveryReceipt> {
      this.sent.push("go");
      return await new Promise<DeliveryReceipt>(() => {});
    }
  })([]);
  const second = await serve(hang, first.home);
  void call(second.niwa, "session.send", { session, message: "go", operation: "op-1" }).catch(() => undefined);
  for (let waited = 0; hang.sent.length === 0 && waited < 5_000; waited += 20) await Bun.sleep(20);
  await second.stop();

  const third = new ScriptedSend([]);
  const after = await serve(third, first.home);
  await expect(call(after.niwa, "session.send", { session, message: "go", operation: "op-1" })).rejects.toMatchObject({ code: "InputPossiblySent" });
  expect(third.sent).toEqual([]);
  // A send without an operation id is sent as it always was.
  await call(after.niwa, "session.send", { session, message: "go" });
  expect(third.sent).toEqual(["go"]);
});

/** A control side whose start delivers its prompt as the first turn, as a harness that names the session with it does. */
class FirstTurn extends ScriptedSend {
  starts = 0;
  override async start(options?: { prompt: { sections: { text: string }[] } }): Promise<StartedSession> {
    this.starts += 1;
    const text = options?.prompt.sections.map((section) => section.text).join("") ?? "";
    return { session: sessionId(harnessId(HARNESS), `native-${String(this.starts)}`), ...(text === "" ? {} : { first: { status: "started", turn: 1 } }) };
  }
}

const ofType = (records: readonly StoredRecord[], type: string) => records.filter((row) => row.type === type).map((row) => row.data);

test("the first prompt of a start is recorded under the operation of the start with what became of it", async () => {
  const control = new FirstTurn([]);
  const { niwa, records } = await serve(control);
  const started = await call<{ session: string; ref: string; operation: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go", operation: "start-1" });
  expect(started.operation).toBe("start-1");
  const all = await records();
  expect(ofType(all, "session.input.sending")).toEqual([{ session: started.ref, operation: "start-1", digest: expect.any(String) }]);
  expect(ofType(all, "session.input.settled")).toEqual([{ session: started.ref, operation: "start-1", outcome: { status: "accepted", receipt: { status: "started", turn: 1 } } }]);

  // Without one, the operation is the start's own.
  const other = await call<{ ref: string; operation: string }>(niwa, "session.start", { harness: HARNESS, prompt: "again" });
  expect(other.operation.length).toBeGreaterThan(0);
  expect(ofType(await records(), "session.input.settled")).toContainEqual({ session: other.ref, operation: other.operation, outcome: { status: "accepted", receipt: { status: "started", turn: 1 } } });
});

test("a start retried under its operation answers the session it made, and another prompt under it is a conflict", async () => {
  const control = new FirstTurn([]);
  const { niwa } = await serve(control);
  const first = await call<{ session: string; ref: string; receipt: DeliveryReceipt }>(niwa, "session.start", { harness: HARNESS, prompt: "go", operation: "start-1" });
  const again = await call<{ session: string; ref: string; receipt: DeliveryReceipt }>(niwa, "session.start", { harness: HARNESS, prompt: "go", operation: "start-1" });
  expect(again).toEqual(first);
  expect(control.starts).toBe(1);
  await expect(call(niwa, "session.start", { harness: HARNESS, prompt: "stop", operation: "start-1" })).rejects.toMatchObject({ code: "operation-conflict" });
  expect(control.starts).toBe(1);
});
