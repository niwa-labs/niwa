// The tasks module and the messages module compose: a task that says to report to a session
// address has its updates and its end delivered into that session, once each, as text.
//
// Only the public API is used.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import type { Caller } from "@niwa-labs/core";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
} from "@niwa-labs/harness";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import { messages } from "@niwa-labs/messages";
import type { CallerBinding } from "@niwa-labs/plugin";
import { sessions } from "@niwa-labs/sessions";
import { taskCreate, taskFinish, taskReport, tasks } from "@niwa-labs/tasks";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";

/** The harness the fake control side serves. */
const HARNESS = "fake-harness";

/** The session the task reports to. */
const SESSION = "session-1";

/**
 * The fake control side.
 *
 * It records what it was sent, and it can be made to block: a send that never returns is a
 * call that was cut off, which is what the restart is about.
 */
class FakeControl implements SessionControl {
  /** The texts that were sent into the session, in order. */
  readonly sent: string[] = [];
  /** How many times a send was begun, blocked or not. */
  entered = 0;
  /** Whether a send blocks instead of answering. */
  block = false;

  async start(): Promise<{ session: SessionId }> {
    return { session: sessionId(harnessId(HARNESS), SESSION) };
  }

  async resume(): Promise<void> {}

  async send(_id: SessionId, message: string): Promise<DeliveryReceipt> {
    this.entered += 1;
    this.sent.push(message);
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

const REPORT_TO = { kind: "session", harness: HARNESS, id: SESSION } as const;
const RESPONSIBLE = { kind: "strategy", id: "fake" } as const;

/** Clients speak as the responsible party; handlers stand for nobody. */
const bind: CallerBinding = (caller: Caller) => (caller.kind === "client" ? RESPONSIBLE : undefined);

test("a task that reports to a session has its updates and its end delivered into the session", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  niwa.use(sessions({ harnesses: [{ instance: installation(), control }] }));
  await niwa.serve();

  try {
    const client = await connectAsOwner(home.path);
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: "Do it",
      text: "do it",
      askedBy: { kind: "owner" },
      responsible: RESPONSIBLE,
      reportTo: REPORT_TO,
    });
    await client.call(taskReport, { task: id, text: "half way" });
    await client.call(taskFinish, { task: id, result: "done" });

    await eventually(() => control.sent.length === 2, 10_000, "the update and the end should reach the session");
    await Bun.sleep(200);
    expect(control.sent.length).toBe(2);
    expect(control.sent[0]).toContain("From: strategy fake");
    expect(control.sent[0]).toContain("Kind: update");
    expect(control.sent[0]).toContain(`Task: ${id}`);
    expect(control.sent[0]).toContain("half way");
    expect(control.sent[1]).toContain("Kind: result");
    expect(control.sent[1]).toContain("done");
    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
