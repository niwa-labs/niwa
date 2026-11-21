// What a handler of another module sees of the tasks module through a step: a refusal it can catch
// and correct.

import { expect, test } from "bun:test";

import { CORE_TYPES, record } from "@niwa-labs/core";
import type { Address, Caller } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, messages, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { z } from "zod";

import { TaskId, TaskRefusal, taskCreate, taskFinish, taskResult, tasks } from "../src/index.ts";

const WORKER: Address = { kind: "agent", id: "worker" };
const OWNER: Address = { kind: "owner" };

/** A handler of the plugin "worker" speaks as the worker, which is responsible for the tasks. */
const bind: CallerBinding = (caller: Caller) => (caller.kind === "handler" && caller.handler.startsWith("worker/") ? WORKER : undefined);

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

