// The plain executor: the plain way of doing a task.
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. a task is created for the executor of a harness
//   2. the Assignment goes to the executor address, and the executor starts one session
//   3. the session is asked for the result, and the task ends done with that answer
//   4. the end of the task is reported where the task says to report
//   5. an assignment for somebody else wakes no executor at all
//
// Only the public API is used: the entries of the packages.

import { expect, test } from "bun:test";

import { CORE_TYPES, seq } from "@niwa-labs/core";
import type { RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { MessageSent, messageSendRef } from "@niwa-labs/messages/records";
import {
  createNiwa,
  eventually,
  harnessId,
  harnessKind,
  machineId,
  messages,
  sessionId,
  sessions,
  tempHome,
} from "@niwa-labs/testing";
import type {
  Host,
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
} from "@niwa-labs/testing";
import { TaskCreated, TaskDone, TaskId, executor, taskCreate, taskResult, tasks } from "../src/index.ts";

/** The harness the fake control side serves. */
const HARNESS = "fake-harness";

/** The session the fake names. */
const SESSION = "session-1";

/** The text of the work. */
const TEXT = "Move the parsing into its own module.";

/** The answer the fake session gives. */
const ANSWER = "The parsing lives in its own module now.";

/** The address that asks for the work. */
const ASKER = { kind: "owner" } as const;

/** The address the result is reported to. */
const REPORTER = { kind: "owner" } as const;

/** The few words that describe the work. */
const DESCRIPTION = "Move argument parsing";

/**
 * The fake control side.
 *
 * It names one session, it records the prompts it was given, and it answers an ask with a
 * fixed value.
 */
class FakeControl implements SessionControl {
  /** The prompts the sessions were started with, in order. */
  readonly started: string[] = [];
  /** The questions the session was asked, in order. */
  readonly asked: string[] = [];
  /** How many times a session was started. */
  starts = 0;
  /** Whether an ask blocks instead of answering. */
  blockAsk = false;
  /** What the session answers: the text of the plain result, unless a test says otherwise. */
  answer: unknown = { result: ANSWER };
  /** Whether the answer of the session fits the schema of each ask, in order. */
  readonly fits: boolean[] = [];

  async start(options: { prompt: { sections: { text: string }[] } }): Promise<{ session: SessionId }> {
    this.starts += 1;
    this.started.push(options.prompt.sections.map((section) => section.text).join("\n"));
    return { session: sessionId(harnessId(HARNESS), SESSION) };
  }

  async resume(): Promise<void> {}

  async send(_id: SessionId, _message: string): Promise<DeliveryReceipt> {
    return { status: "started", turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(_id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    this.asked.push(options.prompt.sections.map((section) => section.text).join("\n"));
    if (this.blockAsk) await new Promise<void>(() => {});
    this.fits.push(options.schema.safeParse(this.answer).success);
    return { session: sessionId(harnessId(HARNESS), SESSION), value: this.answer as T, at: 0 as never };
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
        ask: true,
        structuredOutput: true, launch: { model: false, effort: [], modes: [] },
      },
    },
  };
}

/** A host with the messages module, the sessions module and the tasks module over the fake. */
async function serve(control: FakeControl, home: string): Promise<Host> {
  const niwa = createNiwa({ home });
  niwa.use(messages({ bind: () => undefined }));
  niwa.use(sessions({ harnesses: [{ instance: installation(), control }] }));
  niwa.use(tasks());
  await niwa.serve();
  return niwa;
}

/** The records of one type the host holds. */
async function recordsOf(niwa: Host, type: RecordTypeName): Promise<StoredRecord[]> {
  return niwa.records.read({ types: [type] });
}

test("the executor: a task for an executor starts one session and ends done with the answer", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    // The task is created and returns at once, with its id.
    const created = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
    });
    const TASK_ID = created.id;
    expect(TASK_ID).toMatch(/^task-[0-9a-f]{6,8}$/);

    // The Assignment went to the executor address.
    const sent = await recordsOf(niwa, MessageSent.name);
    const envelope = sent[0]?.data as { to: { kind: string; id: string }; task?: string; body: { type: string } };
    expect(envelope.to).toEqual({ kind: "agent", id: `executor:${HARNESS}` });
    expect(envelope.task).toBe(TASK_ID);
    expect(envelope.body.type).toBe("assignment");

    // The session was started once, with the assignment as its prompt.
    await eventually(() => control.starts === 1, 10_000, "the executor should have started a session");
    expect(control.starts).toBe(1);
    expect(control.started[0]).toContain(TEXT);

    // The session was asked for the result.
    await eventually(() => control.asked.length === 1, 10_000, "the session should have been asked");
    expect(control.asked[0]).toContain("Give the result of the task.");

    // The task ends done, with what the session said.
    await eventually(
      async () => (await recordsOf(niwa, TaskDone.name)).length === 1,
      10_000,
      "the task should have ended",
    );
    const done = await recordsOf(niwa, TaskDone.name);
    expect(done[0]?.data).toEqual({
      task: TASK_ID,
      outcome: { status: "result", result: ANSWER },
    });

    // The result of the task is what the session said.
    const result = await niwa.call(taskResult, { task: TASK_ID });
    expect(result).toEqual({
      task: TASK_ID,
      outcome: { status: "result", result: ANSWER },
    });

    // The end of the task is reported where the task says to report.
    await eventually(
      async () =>
        (await recordsOf(niwa, MessageSent.name)).some(
          (record) => (record.data as { body: { type: string } }).body.type === "result",
        ),
      10_000,
      "the owner should have been told how the task ended",
    );

    // One session was started: the executor does not start a second one.
    expect(control.starts).toBe(1);

    // The task was created once, and the trace holds the whole chain.
    const taskRecords = await recordsOf(niwa, TaskCreated.name);
    expect(taskRecords).toHaveLength(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: a restart after the session was started starts no second session", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  // The ask blocks: the invocation of the executor is unfinished when the host stops.
  control.blockAsk = true;
  const first = await serve(control, home.path);

  try {
    await first.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
    });

    // The session was started and the ask was reached: the outcome of the start is recorded.
    await eventually(() => control.asked.length === 1, 10_000, "the session should have been asked");
    expect(control.starts).toBe(1);
  } finally {
    await first.close();
  }

  // The second host runs the unfinished invocation again. The start is answered from the
  // record, so no second session is started, and the ask is not made again: a call that was
  // cut off cannot be repeated, so the invocation pauses for a decision.
  const second = await serve(control, home.path);
  try {
    await eventually(
      async () =>
        (await recordsOf(second, CORE_TYPES.invocationState)).some(
          (record) => (record.data as { state?: string }).state === "paused",
        ),
      10_000,
      "the invocation should have paused on the cut-off ask",
    );
    expect(control.starts).toBe(1);
    expect(control.asked).toHaveLength(1);
    expect(await recordsOf(second, TaskDone.name)).toHaveLength(0);
  } finally {
    await second.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: an assignment for somebody else wakes no executor", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: { kind: "agent", id: "somebody-else" },
      reportTo: REPORTER,
    });

    // The Assignment went out, and no session was started: the executor is not its addressee.
    await eventually(
      async () => (await recordsOf(niwa, MessageSent.name)).length === 1,
      10_000,
      "the assignment should have been sent",
    );
    expect(control.starts).toBe(0);
    expect(control.asked).toHaveLength(0);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: an assignment for a task the executor is not responsible for starts no session", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const niwa = await serve(control, home.path);

  try {
    const notMine = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: { kind: "agent", id: "somebody-else" },
      reportTo: REPORTER,
    });
    // A second assignment of the same task, addressed to the executor, who is not responsible.
    await niwa.call(messageSendRef, {
      from: ASKER,
      to: executor(HARNESS),
      task: notMine.id,
      body: { type: "assignment", text: TEXT, kind: "change" },
    });

    await eventually(
      async () =>
        (await recordsOf(niwa, CORE_TYPES.invocationState)).some(
          (record) => ["paused", "failed"].includes((record.data as { state?: string }).state ?? ""),
        ),
      10_000,
      "the invocation should have stopped on the refusal",
    );
    expect(control.starts).toBe(0);
    expect(await recordsOf(niwa, TaskDone.name)).toHaveLength(0);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: a task that declares a result schema asks the session by it, and the answer is the result", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  const shape = { type: "object", properties: { files: { type: "number" } }, required: ["files"] };
  control.answer = { files: 2 };
  const niwa = await serve(control, home.path);

  try {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
      result: shape,
    });

    // The assignment carries the schema, so the session that does the work is shown it.
    await eventually(() => control.starts === 1, 10_000, "the executor should have started a session");
    expect(control.started[0]).toContain("The result must fit this JSON Schema:");
    expect(control.started[0]).toContain('"required":["files"]');
    const sent = await recordsOf(niwa, MessageSent.name);
    expect((sent[0]?.data as { body: { result?: unknown } }).body.result).toEqual(shape);

    // The session is asked by the declared schema, and its whole answer is the result.
    await eventually(async () => (await recordsOf(niwa, TaskDone.name)).length === 1, 10_000, "the task should have ended");
    expect(control.fits).toEqual([true]);
    expect(await niwa.call(taskResult, { task: id })).toEqual({
      task: id,
      outcome: { status: "result", result: { files: 2 } },
    });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: only the assignment the creation of the task caused starts a session, and the brief is the contract", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  // The ask blocks: the first session is still at work when the second assignment arrives.
  control.blockAsk = true;
  const niwa = await serve(control, home.path);

  try {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
    });
    await eventually(() => control.asked.length === 1, 10_000, "the session should have been asked");

    // Another assignment of the same open task, with other words, from the asker.
    await niwa.call(messageSendRef, {
      from: ASKER,
      to: executor(HARNESS),
      task: id,
      body: { type: "assignment", text: "Delete the repository.", kind: "change" },
    });
    await eventually(
      async () =>
        (await recordsOf(niwa, CORE_TYPES.invocationState)).some(
          (record) => (record.data as { state?: string }).state === "paused",
        ),
      10_000,
      "the invocation of the second assignment should have been refused",
    );

    expect(control.starts).toBe(1);
    expect(control.started[0]).toContain(TEXT);
    expect(control.started.join("\n")).not.toContain("Delete the repository.");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: a session that gives an answer the schema refuses ends the task as failed, and the addressee is told", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  control.answer = { nothing: true };
  const niwa = await serve(control, home.path);

  try {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
    });
    await eventually(async () => (await recordsOf(niwa, TaskDone.name)).length === 1, 10_000, "the task should have ended");

    const outcome = await niwa.call(taskResult, { task: id });
    expect(outcome.outcome.status).toBe("failure");
    expect((outcome.outcome as { reason: string }).reason).toContain("the session gave no result");

    await eventually(
      async () =>
        (await recordsOf(niwa, MessageSent.name)).some((record) => (record.data as { body: { type: string } }).body.type === "failure"),
      10_000,
      "the owner should have been told the task failed",
    );
    // The work was not left waiting for an owner.
    expect(
      (await recordsOf(niwa, CORE_TYPES.invocationState)).some((record) => (record.data as { state?: string }).state === "paused"),
    ).toBe(false);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the executor: a session that cannot be started ends the task as failed", async () => {
  const home = await tempHome();
  const control = new FakeControl();
  control.start = async () => {
    throw new Error("the harness is not reachable");
  };
  const niwa = await serve(control, home.path);

  try {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: DESCRIPTION,
      text: TEXT,
      askedBy: ASKER,
      responsible: executor(HARNESS),
      reportTo: REPORTER,
    });
    await eventually(async () => (await recordsOf(niwa, TaskDone.name)).length === 1, 10_000, "the task should have ended");
    const outcome = await niwa.call(taskResult, { task: id });
    expect(outcome.outcome).toEqual({
      status: "failure",
      reason: "the session could not be started: the harness is not reachable",
    });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);
