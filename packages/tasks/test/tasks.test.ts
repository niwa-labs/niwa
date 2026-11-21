// The tasks module: a task is a contract and nothing else.
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. the tasks plugin, the messages plugin and the fake strategy are installed
//   2. a task is created: it returns at once, with the id of the task, and the
//      Assignment message goes to the responsible address
//   3. the fake strategy, which is the responsible party, accepts the task and
//      answers for the result
//   4. the result of the task arrives: "task.result" gives it at once
//   5. finishing a task twice is refused, and the first end stands
//   6. the trace from the record that woke the strategy joins the task, the
//      message and the result
//
// Only the public API is used: the entries of the packages.

import { expect, test } from "bun:test";

import { record, seq, strategy } from "@niwa-labs/core";
import type { Address, Caller, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { MessageSent } from "@niwa-labs/messages/records";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import {
  TaskCreated,
  TaskDone,
  TaskId,
  stateOf,
  taskActions,
  taskCreate,
  taskFacts,
  taskFail,
  taskFinish,
  taskIds,
  taskReport,
  taskResult,
  tasks,
} from "../src/index.ts";
import type { Strategy, TaskAnswer, TaskContract } from "../src/index.ts";
import { connect, connectAsOwner, createNiwa, messageSend, messages, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

/** The record that wakes the strategy: it asks for the work to be done on one task. */
const Work = record("tasks.work", z.object({ text: z.string(), task: TaskId }), { open: true });

/** The text of the work. */
const TEXT = "Move argument parsing into its own module.";

/** The address of the strategy: the responsible party of the task. */
const STRATEGY = strategy("fake");

/** The address that asks for the work. */
const ASKER = { kind: "owner" } as const;

/** The address the result is reported to. */
const REPORTER = { kind: "owner" } as const;

/** What the fake strategy was asked to do, and what it answered. */
interface Asked {
  readonly text: string;
  readonly answer: TaskAnswer;
}

/**
 * The fake strategy: the responsible party of the task.
 *
 * It accepts every task and answers with a fixed answer. It is a strategy, so the base does not
 * tell it how to work: it hands the task over and waits for the answer.
 */
function fakeStrategy(asked: Asked[]): Strategy {
  return {
    address: STRATEGY,
    accept: () => true,
    answer: async (task) => {
      const answer: TaskAnswer = { status: "result", result: `done: ${task.text}` };
      asked.push({ text: task.text, answer });
      return answer;
    },
  };
}

/** The strategy's own plugin speaks as the strategy; a client speaks as the strategy too. */
const bind: CallerBinding = (caller: Caller) =>
  caller.kind === "client" || (caller.kind === "handler" && caller.handler.startsWith("fake-strategy/"))
    ? STRATEGY
    : undefined;

/**
 * The plugin of the fake strategy.
 *
 * It reads the contract of the task out of the journal, accepts the task, and finishes it with
 * the answer of the strategy.
 */
function strategyPlugin(fake: Strategy) {
  return plugin("fake-strategy", (api) => {
    api.declare(Work);
    const facts = taskFacts(() => api.journal?.());
    const acts = taskActions(facts, taskIds(() => api.journal?.()), bind);
    api.on(Work, async (work, step) => {
      const contract = stateOf(facts(), work.task)?.contract;
      if (contract === undefined || !(await fake.accept(contract))) return;
      const answer = await fake.answer(contract);
      if (answer.status === "result") await step(acts.finish, { task: work.task, result: answer.result });
      else await step(acts.fail, { task: work.task, reason: answer.reason });
    });
  });
}

test("the tasks module: a task returns at once, the result arrives, finishing twice is refused, and the trace joins the task, the message and the result", async () => {
  const home = await tempHome();
  const asked: Asked[] = [];
  const fake = fakeStrategy(asked);

  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  niwa.use(strategyPlugin(fake));
  await niwa.serve();

  try {
    const client = await connectAsOwner(home.path);

    // The task is created and returns at once, with the id niwa issued.
    const created = await client.call(taskCreate, contractOf());
    const TASK_ID = created.id;
    expect(TASK_ID).toMatch(/^task-[0-9a-f]{6,8}$/);

    // The contract of the task is in the journal: that is how a responsible party
    // learns what it is responsible for.
    const taskRecords = await recordsOf(client, TaskCreated.name);
    expect(taskRecords).toHaveLength(1);
    const created0 = taskRecords[0];
    const contract = created0?.data as TaskContract;
    expect(contract.id).toBe(TASK_ID);
    expect(contract.kind).toBe("change");
    expect<string>(contract.description).toBe(DESCRIPTION);
    expect(contract.text).toBe(TEXT);
    expect(contract.responsible).toEqual(STRATEGY);
    expect(contract.askedBy).toEqual(ASKER);
    expect(contract.reportTo).toEqual(REPORTER);

    // The Assignment message went to the responsible address.
    const sent = await recordsOf(client, MessageSent.name);
    expect(sent).toHaveLength(1);
    const envelope = sent[0]?.data as {
      id: string;
      to: { kind: string; id: string };
      task?: string;
      body: { type: string; text: string; kind?: string };
    };
    expect(envelope.id).toMatch(/^msg-[0-9a-f]{6,8}$/);
    expect(envelope.to).toEqual({ kind: "strategy", id: "fake" });
    expect(envelope.task).toBe(TASK_ID);
    expect(envelope.body.type).toBe("assignment");
    expect(envelope.body.text).toBe(TEXT);

    // The strategy is the responsible party: it accepts the task and answers. Its
    // work depends on the task, so the whole chain hangs from the task.
    await client.emit(Work, { text: TEXT, task: TASK_ID }, { links: [created0?.id as never] });
    await eventually(() => asked.length === 1, 10_000, "the strategy should have been asked");
    expect(asked[0]?.text).toBe(TEXT);

    // The result arrives: the task is done, and the result is what it answered.
    const result = await client.call(taskResult, { task: TASK_ID });
    expect(result).toEqual({
      task: TASK_ID,
      outcome: { status: "result", result: `done: ${TEXT}` },
    });

    // Finishing the task again is refused: a task finishes once.
    let refused: unknown;
    try {
      await client.call(taskFinish, { task: TASK_ID, result: "something else" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("already done");

    // The first end stands: the result is still the one the strategy gave.
    const again = await client.call(taskResult, { task: TASK_ID });
    expect(again).toEqual(result);

    // The trace from the record that created the task joins the task, the message
    // and the result.
    expect(created0).toBeDefined();
    const traced = await client.trace(created0?.id as never);
    const types = traced.map((record) => record.type);
    expect(types).toContain(TaskCreated.name);
    expect(types).toContain(MessageSent.name);
    expect(types).toContain(TaskDone.name);

    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

/**
 * The records of one type, from the beginning of the journal.
 *
 * The subscription never ends by itself, so the reader takes the records it needs and stops.
 */
async function recordsOf(
  client: Awaited<ReturnType<typeof connect>>,
  type: RecordTypeName,
): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  const stream = client.records.since({ types: [type] }) as AsyncGenerator<StoredRecord>;
  for (let index = 0; index < 10; index += 1) {
    const next = await Promise.race([
      stream.next(),
      Bun.sleep(200).then(() => "timed out" as const),
    ]);
    if (next === "timed out" || next.done === true) break;
    found.push(next.value);
  }
  return found;
}

/** Wait for a condition, or say that it did not hold. */
async function eventually(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  message?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(message ?? "the condition was not met");
    await Bun.sleep(20);
  }
}

/** A host with the tasks module whose clients and handlers all speak as the strategy. */
async function withTasks(run: (client: Awaited<ReturnType<typeof connect>>, home: string) => Promise<void>) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  await niwa.serve();
  try {
    const client = await connectAsOwner(home.path);
    try {
      await run(client, home.path);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}

/** The few words that describe the work. */
const DESCRIPTION = "Move argument parsing";

const contractOf = (responsible: Address = STRATEGY) => ({
  kind: "change",
  description: DESCRIPTION,
  text: TEXT,
  askedBy: ASKER,
  responsible,
  reportTo: REPORTER,
});

test("only the responsible party reports and finishes, a task finishes once, and a task that does not exist is refused", async () => {
  await withTasks(async (client) => {
    const t1 = (await client.call(taskCreate, contractOf({ kind: "agent", id: "other" }))).id;
    await expect(client.call(taskReport, { task: t1, text: "hi" })).rejects.toThrow("only the responsible party");
    await expect(client.call(taskFinish, { task: t1, result: 1 })).rejects.toThrow("only the responsible party");
    await expect(client.call(taskFinish, { task: TaskId.parse("task-000000"), result: 1 })).rejects.toThrow("does not exist");

    const t2 = (await client.call(taskCreate, contractOf())).id;
    await client.call(taskReport, { task: t2, text: "half way" });
    // A finish needs a result and a failure needs a reason: a stale caller that still sends a reason to task.finish fails loudly.
    await expect(client.call("task.finish" as never, { task: t2 } as never)).rejects.toThrow("result");
    await expect(client.call("task.finish" as never, { task: t2, reason: "x" } as never)).rejects.toThrow("result");
    await expect(client.call("task.fail" as never, { task: t2 } as never)).rejects.toThrow("reason");
    await expect(client.call(taskFail, { task: t2, reason: "" })).rejects.toThrow("reason");
    await client.call(taskFail, { task: t2, reason: "broke" });
    await expect(client.call(taskReport, { task: t2, text: "late" })).rejects.toThrow("already done");
  });
}, 30_000);

test("task.result waits for a task that ends later, and loses no end that comes at once", async () => {
  await withTasks(async (client) => {
    const late = (await client.call(taskCreate, contractOf())).id;
    const waiting = client.call(taskResult, { task: late });
    await Bun.sleep(100);
    await client.call(taskFinish, { task: late, result: "ok" });
    expect(await waiting).toEqual({ task: late, outcome: { status: "result", result: "ok" } });

    // The end arrives while the result is being asked for: neither order may hang.
    for (let index = 0; index < 15; index += 1) {
      const id = (await client.call(taskCreate, contractOf())).id;
      const both = await Promise.all([
        client.call(taskResult, { task: id }),
        client.call(taskFinish, { task: id, result: index }),
      ]);
      expect(both[0]).toEqual({ task: id, outcome: { status: "result", result: index } });
    }
  });
}, 30_000);

test("the state of a task is read from the journal: a new host knows it", async () => {
  const home = await tempHome();
  try {
    let kept: TaskId | undefined;
    for (const first of [true, false]) {
      const niwa = createNiwa({ home: home.path });
      niwa.use(messages({ bind }));
      niwa.use(tasks({ messages: { bind } }));
      await niwa.serve();
      const client = await connectAsOwner(home.path);
      try {
        if (first) {
          kept = (await client.call(taskCreate, contractOf())).id;
          await client.call(taskFinish, { task: kept, result: 7 });
        } else if (kept !== undefined) {
          expect(await client.call(taskResult, { task: kept })).toEqual({
            task: kept,
            outcome: { status: "result", result: 7 },
          });
          await expect(client.call(taskFinish, { task: kept, result: 8 })).rejects.toThrow("already done");
        }
      } finally {
        await client.close().catch(() => {});
        await niwa.close().catch(() => {});
      }
    }
  } finally {
    await home.cleanup();
  }
}, 30_000);

// Where a task says to report, that is where the updates and the end go.
//
// The scenarios run in one process, against a real host on a temporary home:
//
//   1. a task is created with reportTo = owner: the Assignment goes to the responsible address
//   2. the responsible party reports: the Update goes to the owner
//   3. the task is finished: the Result goes to the owner
//   4. the two messages to the owner come in that order, and both carry the task id
//   5. a task that ends in a failure reports the failure, and a result that is not
//      text is carried along as it is
//   6. an invocation left unfinished is run again by the next host: the message is
//      the same fact, so it is not sent twice

/** The messages the journal holds, in the order they were written. */
async function sentTo(
  home: string,
  to: { kind: string; id?: string },
): Promise<Array<{ task?: string; body: { type: string; text: string; data?: unknown } }>> {
  const client = await connectAsOwner(home);
  try {
    const records = await client.records.read({ types: [MessageSent.name] });
    return records
      .map(
        (record) =>
          record.data as {
            to: { kind: string; id?: string };
            task?: string;
            body: { type: string; text: string; data?: unknown };
          },
      )
      .filter((message) => message.to.kind === to.kind && message.to.id === to.id)
      .map((message) => ({ task: message.task, body: message.body }));
  } finally {
    await client.close().catch(() => {});
  }
}

test("mt-2: the updates and the end of a task go to where it says to report", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  await niwa.serve();

  try {
    const client = await connectAsOwner(home.path);
    const reported = (await client.call(taskCreate, contractOf())).id;
    await client.call(taskReport, { task: reported, text: "half way" });
    await client.call(taskFinish, { task: reported, result: "done" });

    // The two messages to the owner: the Update first, the Result after it.
    await eventually(
      async () => (await sentTo(home.path, { kind: "owner" })).length >= 2,
      10_000,
      "the owner should have been told about the task",
    );
    const toOwner = await sentTo(home.path, { kind: "owner" });
    expect(toOwner.map((message) => message.body.type)).toEqual(["update", "result"]);
    expect(toOwner[0]?.body.text).toBe("half way");
    expect(toOwner[1]?.body.text).toBe("done");
    // Both carry the task they are about.
    expect(toOwner.map((message) => message.task)).toEqual([reported, reported]);

    // The Assignment still goes to the responsible address, not to the reporter.
    const toStrategy = await sentTo(home.path, { kind: "strategy", id: "fake" });
    expect(toStrategy.map((message) => message.body.type)).toEqual(["assignment"]);

    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("mt-2: a task that ends in a failure reports the failure", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  await niwa.serve();

  try {
    const client = await connectAsOwner(home.path);
    const failed = (await client.call(taskCreate, contractOf())).id;
    await client.call(taskFail, { task: failed, reason: "it broke" });

    await eventually(
      async () => (await sentTo(home.path, { kind: "owner" })).length >= 1,
      10_000,
      "the owner should have been told the task failed",
    );
    const toOwner = await sentTo(home.path, { kind: "owner" });
    expect(toOwner[0]?.body.type).toBe("failure");
    expect(toOwner[0]?.body.text).toBe("it broke");

    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("mt-2: a result that is not text is carried along as it is", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  await niwa.serve();

  try {
    const client = await connectAsOwner(home.path);
    const structured = (await client.call(taskCreate, contractOf())).id;
    await client.call(taskFinish, { task: structured, result: { files: 2 } });

    await eventually(
      async () => (await sentTo(home.path, { kind: "owner" })).length >= 1,
      10_000,
      "the owner should have been told how the task ended",
    );
    const toOwner = await sentTo(home.path, { kind: "owner" });
    expect(toOwner[0]?.body.type).toBe("result");
    // The result is carried as it is, and the text says what it is.
    expect(toOwner[0]?.body.data).toEqual({ files: 2 });

    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("mt-2: a replay after a restart sends nothing twice", async () => {
  const home = await tempHome();
  // The guard holds the message of the first host inside its step: the invocation of
  // the handler stays unfinished, so the second host runs it again.
  let holding = true;
  let entered = 0;
  const held = new Promise<void>(() => {});
  const guard = (): Plugin =>
    plugin("report-guard", (api) => {
      api.guard(messageSend(), async (input) => {
        if (input.body.type !== "update") return;
        entered += 1;
        if (holding) await held;
      });
    });

  const first = createNiwa({ home: home.path });
  first.use(messages({ bind }));
  first.use(tasks({ messages: { bind } }));
  first.use(guard());
  await first.serve();

  try {
    const client = await connectAsOwner(home.path);
    const again = (await client.call(taskCreate, contractOf())).id;
    await client.call(taskReport, { task: again, text: "half way" });

    // The handler of the report is at its step, waiting for the guard.
    await eventually(() => entered >= 1, 10_000, "the handler should have reached its step");
    await client.close().catch(() => {});
    await first.close().catch(() => {});

    // The second host reads the same journal and runs the unfinished invocation
    // again: the message is the same fact, so it is not written twice.
    holding = false;
    const second = createNiwa({ home: home.path });
    second.use(messages({ bind }));
    second.use(tasks({ messages: { bind } }));
    second.use(guard());
    await second.serve();
    try {
      // The handler ran again: the step was reached a second time.
      await eventually(() => entered >= 2, 10_000, "the handler should have run again");
      const client2 = await connectAsOwner(home.path);
      await client2.call(taskFinish, { task: again, result: "done" });
      await eventually(
        async () => (await sentTo(home.path, { kind: "owner" })).length >= 2,
        10_000,
        "the owner should have been told how the task ended",
      );
      await client2.close().catch(() => {});

      // The owner heard about the update once and about the end once.
      const toOwner = await sentTo(home.path, { kind: "owner" });
      expect(toOwner.map((message) => message.body.type)).toEqual(["update", "result"]);
      expect(toOwner[0]?.body.text).toBe("half way");
      expect(toOwner[1]?.body.text).toBe("done");
      // The Assignment went to the responsible address once, as before.
      const toStrategy = await sentTo(home.path, { kind: "strategy", id: "fake" });
      expect(toStrategy.map((message) => message.body.type)).toEqual(["assignment"]);
    } finally {
      await second.close().catch(() => {});
    }
  } finally {
    await first.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
