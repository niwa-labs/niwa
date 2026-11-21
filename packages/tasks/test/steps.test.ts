// What a handler of another module sees of the tasks module through a step: a refusal it can catch
// and correct, and a result it waits for as an invocation that is waiting, holding nothing in memory.

import { expect, test } from "bun:test";

import { CORE_TYPES, record } from "@niwa-labs/core";
import type { Address, Caller } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, messages, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { z } from "zod";

import { TaskId, TaskRefusal, TaskWaiters, taskCreate, taskFinish, taskResult, tasks } from "../src/index.ts";

const WORKER: Address = { kind: "agent", id: "worker" };
const OWNER: Address = { kind: "owner" };

const SOMEBODY: Address = { kind: "agent", id: "somebody" };

/** A handler of the plugin "worker" speaks as the worker; a client speaks as somebody else. */
const bind: CallerBinding = (caller: Caller) => {
  if (caller.kind === "handler" && caller.handler.startsWith("worker/")) return WORKER;
  return caller.kind === "client" ? SOMEBODY : undefined;
};

/** The record that wakes the worker: a task for it to do. */
const Job = record("worker.job", z.object({ task: TaskId }), { open: true });
/** What the worker saw. */
const Saw = record("worker.saw", z.object({ task: TaskId, note: z.string() }), { open: true });

const shape = { type: "object", properties: { files: { type: "number" } }, required: ["files"] };

async function served(worker: ReturnType<typeof plugin>, run: (niwa: Host, home: string) => Promise<void>) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  niwa.use(worker);
  await niwa.serve();
  try {
    await run(niwa, home.path);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}

async function eventually(fn: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

const states = async (niwa: Host) =>
  (await niwa.records.read({ types: [CORE_TYPES.invocationState] })).map((row) => (row.data as { state: string }).state);

test("a result that does not fit is a refusal the handler catches and corrects, and the handler goes on", async () => {
  const corrector = plugin("worker", (api) => {
    api.declare(Job, Saw);
    api.on(Job, async (job, step) => {
      try {
        await step(taskFinish, { task: job.task, result: { files: "two" } });
      } catch (error) {
        if (!(error instanceof TaskRefusal) || error.code !== "result-invalid") throw error;
        await step.emit(Saw, { task: job.task, note: error.code });
        await step(taskFinish, { task: job.task, result: { files: 2 } });
      }
    });
  });

  await served(corrector, async (niwa, home) => {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: "Move argument parsing",
      text: "Move it.",
      askedBy: OWNER,
      responsible: WORKER,
      reportTo: OWNER,
      result: shape,
    });
    const client = await connectAsOwner(home);
    try {
      await client.emit(Job, { task: id });
      await eventually(async () => (await niwa.records.read({ types: ["worker.saw" as never] })).length === 1, "the refusal should have been caught");
      expect(await niwa.call(taskResult, { task: id })).toEqual({ task: id, outcome: { status: "result", result: { files: 2 } } });
      // The refusal paused nothing: the handler ran to its end.
      expect(await states(niwa)).not.toContain("paused");
    } finally {
      await client.close().catch(() => {});
    }
  });
}, 30_000);

test("a handler that asks for the result of an open task waits as an invocation, and goes on when the task ends", async () => {
  const waiter = plugin("worker", (api) => {
    api.declare(Job, Saw);
    api.on(Job, async (job, step) => {
      const got = await step(taskResult, { task: job.task });
      await step.emit(Saw, { task: job.task, note: got.outcome.status });
    });
  });

  await served(waiter, async (niwa, home) => {
    const { id } = await niwa.call(taskCreate, {
      kind: "change",
      description: "Move argument parsing",
      text: "Move it.",
      askedBy: OWNER,
      responsible: SOMEBODY,
      reportTo: OWNER,
    });
    const client = await connectAsOwner(home);
    try {
      await client.emit(Job, { task: id });
      // The invocation is waiting for the end of the task: it is not a step that runs in memory.
      await eventually(async () => (await states(niwa)).includes("waiting"), "the invocation should be waiting");
      await Bun.sleep(200);
      expect((await states(niwa)).at(-1)).toBe("waiting");

      await client.call(taskFinish, { task: id, result: "done" });
      await eventually(async () => (await niwa.records.read({ types: ["worker.saw" as never] })).length === 1, "the handler should have gone on");
      expect((await niwa.records.read({ types: ["worker.saw" as never] })).map((row) => (row.data as { note: string }).note)).toEqual(["result"]);
    } finally {
      await client.close().catch(() => {});
    }
  });
}, 30_000);

test("the callers that wait for a task in memory leave nothing behind, whether the task ended or not", () => {
  const waiters = new TaskWaiters();
  const ended = waiters.watch("task-aaaaaa");
  expect(waiters.size).toBe(1);
  // The caller read the state, found the task done and stopped waiting.
  ended.stop();
  expect(waiters.size).toBe(0);

  const first = waiters.watch("task-bbbbbb");
  const second = waiters.watch("task-bbbbbb");
  first.stop();
  expect(waiters.size).toBe(1);
  second.stop();
  expect(waiters.size).toBe(0);
});
