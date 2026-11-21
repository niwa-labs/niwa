// The delivery of a message to a session: the envelope is unfolded into text, and the text
// goes into the session.
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. a message to a session reaches the session, once, as the text of the envelope
//   2. the receipt is recorded on the message
//   3. a message to another address reaches no session at all
//   4. a host that is closed while the send is in flight, and started again, does not
//      send the message a second time
//
// Only the public API is used: the entries of core, messages and sessions, and testing.

import { expect, test } from "bun:test";

import { CORE_TYPES, seq } from "@niwa-labs/core";
import type { RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { createNiwa, eventually, harnessId, harnessKind, machineId, sessionId, sessions, tempHome } from "@niwa-labs/testing";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  Host,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
  StartOptions,
} from "@niwa-labs/testing";

import { MessageDelivered, MessageSent, messageReceive, messageSend, messages } from "../src/index.ts";

/** The harness the fake control side serves. */
const HARNESS = "fake-harness";

/** The session the message goes to. */
const SESSION = "session-1";

/** The text of the message. */
const TEXT = "Move the parsing into its own module.";

/**
 * The fake control side.
 *
 * It records what it was sent, and it can be made to block: a send that never returns is a
 * call that was cut off, which is what the restart is about.
 */
class FakeControl implements SessionControl {
  /** The texts that were sent into the session, in order. */
  readonly sent: string[] = [];
  /** The sessions the texts were sent to, in order. */
  readonly sentTo: SessionId[] = [];
  /** How many times a send was begun, blocked or not. */
  entered = 0;
  /** Whether a send blocks instead of answering. */
  block = false;

  async start(): Promise<{ session: SessionId }> {
    return { session: sessionId(harnessId(HARNESS), SESSION) };
  }

  async resume(): Promise<void> {}

  async send(id: SessionId, message: string): Promise<DeliveryReceipt> {
    this.entered += 1;
    this.sent.push(message);
    this.sentTo.push(id);
    if (this.block) await new Promise<void>(() => {});
    return { status: "started", turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(_id: SessionId, _options: AskOptions<T>): Promise<AskAnswer<T>> {
    throw new Error("the fake control side does not ask");
  }

  async *life(): AsyncIterable<LifeEvent> {
    // The signs of life are not what this test is about.
  }

  async state(): Promise<SessionState> {
    return "idle";
  }
}

/** The installation the fake control side serves. */
function installation(): Harness {
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
        interrupt: false,
        ask: false,
        structuredOutput: false, launch: { model: false, effort: [], modes: [] },
      },
    },
  };
}

/** A host with the messages module and the sessions module over the fake. */
async function serve(control: FakeControl, home: string): Promise<Host> {
  const niwa = createNiwa({ home });
  niwa.use(messages({ bind: () => undefined }));
  niwa.use(sessions({ harnesses: [{ instance: installation(), control }] }));
  await niwa.serve();
  return niwa;
}

/** The records of one type the host holds. */
async function recordsOf(niwa: Host, type: RecordTypeName): Promise<StoredRecord[]> {
  return niwa.records.read({ types: [type] });
}

/** A message to the session of the fake. */
function toSession() {
  return {
    from: { kind: "agent" as const, id: "rin" },
    to: { kind: "session" as const, harness: HARNESS, id: SESSION },
    body: { type: "assignment" as const, text: TEXT },
  };
}

test("a message to a session is delivered as text, and the receipt is recorded on the message", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    await niwa.call(messageSend(), toSession());

    // The session got the text of the envelope, once.
    await eventually(() => control.sent.length === 1, 5_000, "the message should reach the session");
    const text = control.sent[0] ?? "";
    expect(text).toContain("From: agent rin");
    expect(text).toContain(`To: session ${HARNESS}/${SESSION}`);
    expect(text).toContain("Kind: assignment");
    expect(text).toContain(TEXT);
    expect(control.entered).toBe(1);

    // The receipt is on the message.
    await eventually(
      async () => (await recordsOf(niwa, MessageDelivered.name)).length === 1,
      5_000,
      "the delivery should be recorded",
    );
    const delivered = await recordsOf(niwa, MessageDelivered.name);
    const data = delivered[0]?.data as { message: { id: string }; receipt: DeliveryReceipt };
    expect(data.receipt).toEqual({ status: "started", turn: 1 });
    expect(data.message.id.length).toBeGreaterThan(0);

    // A message to another address reaches no session.
    await niwa.call(messageSend(), {
      from: { kind: "agent", id: "rin" },
      to: { kind: "agent", id: "executor" },
      body: { type: "update", text: "no session here" },
    });
    await eventually(
      async () => (await recordsOf(niwa, MessageSent.name)).length === 2,
      5_000,
      "the second message should be sent",
    );
    expect(control.sent.length).toBe(1);
    expect(control.entered).toBe(1);

    // Only the message to the session woke the delivery handler.
    const admitted = await recordsOf(niwa, CORE_TYPES.invocationAdmitted);
    expect(admitted.length).toBe(1);
    expect((admitted[0]?.data as { handler: string }).handler).toBe("messages/message.sent:session");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a message that came in from outside for a session is delivered once, and its receipt is recorded", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    await niwa.call(messageReceive(), { ...toSession(), from: { kind: "client", id: "outsider" } });

    await eventually(() => control.sent.length === 1, 5_000, "the message should reach the session");
    expect(control.sent[0]).toContain("From: client outsider");
    expect(control.sent[0]).toContain(TEXT);
    await eventually(
      async () => (await recordsOf(niwa, MessageDelivered.name)).length === 1,
      5_000,
      "the delivery should be recorded",
    );
    expect(control.entered).toBe(1);
    expect(control.sent.length).toBe(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a host that is closed while the send is in flight does not send the message again", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  control.block = true;
  const first = await serve(control, home.path);

  try {
    await first.call(messageSend(), toSession());
    // The send is begun and never answers: the call is cut off.
    await eventually(() => control.entered === 1, 5_000, "the send should be begun");
    expect(control.sent.length).toBe(1);
  } finally {
    await first.close();
  }

  // The second host replays the unfinished invocation. The call was cut off and cannot be
  // made again, so the session is not sent the message twice.
  const second = await serve(control, home.path);
  try {
    await eventually(
      async () =>
        (await recordsOf(second, CORE_TYPES.invocationState)).some(
          (record) => (record.data as { state?: string }).state === "paused",
        ),
      5_000,
      "the replay of the cut-off call should pause the invocation",
    );
    expect(control.entered).toBe(1);
    expect(control.sent.length).toBe(1);
  } finally {
    await second.close();
    await home.cleanup();
  }
});

test("a delivery that was cut off is not made again when its paused step is retried", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  control.block = true;
  const first = await serve(control, home.path);

  try {
    await first.call(messageSend(), toSession());
    await eventually(() => control.entered === 1, 5_000, "the send should be begun");
  } finally {
    await first.close();
  }

  // The replay pauses the cut-off step; the owner decides to try it again.
  const second = await serve(control, home.path);
  try {
    const paused = async (): Promise<StoredRecord[]> =>
      (await recordsOf(second, CORE_TYPES.invocationState)).filter((record) => (record.data as { state?: string }).state === "paused");
    await eventually(async () => (await paused()).length === 1, 5_000, "the replay should pause the invocation");
    const invocation = (((await paused())[0]?.data ?? {}) as { invocation?: string }).invocation ?? "";
    control.block = false;
    await second.call("niwa.invocation.resolve" as never, { invocation, choice: "retry" } as never);

    // The sessions module knows the send by the message, so it says the outcome is not known
    // instead of sending the text into the session a second time.
    await eventually(async () => (await paused()).length === 2, 5_000, "the retry should pause again");
    expect(control.entered).toBe(1);
    expect(control.sent.length).toBe(1);
  } finally {
    await second.close();
    await home.cleanup();
  }
});

test("a message to a session whose harness has whitespace is refused, and any other address reaches exactly the session it names", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    // Joined and split again, this pair would name the harness "fake" and a native id "harness session-1".
    const split = { ...toSession(), to: { kind: "session" as const, harness: "fake harness", id: SESSION } };
    await expect(niwa.call(messageSend(), split)).rejects.toThrow();
    expect(await recordsOf(niwa, MessageSent.name)).toEqual([]);

    // A native id may hold whitespace: it comes back as it was given.
    const spaced = { ...toSession(), to: { kind: "session" as const, harness: HARNESS, id: "team west 1234" } };
    await niwa.call(messageSend(), spaced);
    await eventually(() => control.entered === 1, 5_000, "the message should reach the session");
    expect(control.sentTo).toEqual([{ harness: HARNESS, native: "team west 1234" }]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
