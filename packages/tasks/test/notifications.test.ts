// What a task says to the address it reports to: the updates first, the end after them, and an end
// that is too large for a message is kept as an artifact the message points at.

import { expect, test } from "bun:test";

import { ARTIFACT_THRESHOLD, RECORD_DATA_LIMIT } from "@niwa-labs/core";
import type { Address, Caller, RecordTypeName } from "@niwa-labs/core";
import { MessageSent } from "@niwa-labs/messages/records";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, messageSend, messages, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { taskCreate, taskFail, taskFinish, taskReport, taskResult, tasks } from "../src/index.ts";

const WORKER: Address = { kind: "agent", id: "worker" };
const OWNER: Address = { kind: "owner" };

/** Clients speak as the worker, which is responsible for the tasks; the host stands for nobody. */
const bind: CallerBinding = (caller: Caller) => (caller.kind === "client" ? WORKER : undefined);

const input = (text = "Move it.") => ({
  kind: "change",
  description: "Move argument parsing",
  text,
  askedBy: OWNER,
  responsible: WORKER,
  reportTo: OWNER,
});

/** A host with the tasks module, and a client that speaks as the worker. */
async function served(
  extra: ReadonlyArray<ReturnType<typeof plugin>>,
  run: (host: Host, worker: Awaited<ReturnType<typeof connectAsOwner>>) => Promise<void>,
) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  for (const each of extra) niwa.use(each);
  await niwa.serve();
  const worker = await connectAsOwner(home.path, "worker");
  try {
    await run(niwa, worker);
  } finally {
    await worker.close().catch(() => {});
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}

/** The messages to the owner, in the order they were written. */
async function toOwner(niwa: Host) {
  const rows = await niwa.records.read({ types: [MessageSent.name as RecordTypeName] });
  return rows.map((row) => row.data as { to: Address; task?: string; body: { type: string; text: string; data?: unknown } }).filter((message) => message.to.kind === "owner");
}

async function eventually(fn: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

test("the end of a task is reported after its updates, even when the last update is delivered late", async () => {
  // The delivery of an update is held until the test lets it go: the end is written meanwhile.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered = 0;
  const slow = plugin("slow-updates", (api) => {
    api.guard(messageSend(), async (message) => {
      if (message.body.type !== "update") return;
      entered += 1;
      await held;
    });
  });

  await served([slow], async (niwa, worker) => {
    const { id } = await niwa.call(taskCreate, input());
    await worker.call(taskReport, { task: id, text: "half way" });
    await eventually(() => entered >= 1, "the delivery of the update should have started");
    await worker.call(taskFinish, { task: id, result: "done" });

    // The end is written and the update is still on its way: the end waits for it.
    await Bun.sleep(300);
    expect((await toOwner(niwa)).map((message) => message.body.type)).toEqual([]);

    release();
    await eventually(async () => (await toOwner(niwa)).length >= 2, "the owner should have been told both");
    expect((await toOwner(niwa)).map((message) => message.body.type)).toEqual(["update", "result"]);
  });
}, 30_000);

test("an end that waits for a late update holds no end of another task", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered = 0;
  const slow = plugin("slow-updates", (api) => {
    api.guard(messageSend(), async (message) => {
      if (message.body.type !== "update") return;
      entered += 1;
      await held;
    });
  });

  await served([slow], async (niwa, worker) => {
    const slowTask = (await niwa.call(taskCreate, input("slow"))).id;
    await worker.call(taskReport, { task: slowTask, text: "half way" });
    await eventually(() => entered >= 1, "the delivery of the update should have started");
    await worker.call(taskFinish, { task: slowTask, result: "slow done" });

    const quick = (await niwa.call(taskCreate, input("quick"))).id;
    await worker.call(taskFinish, { task: quick, result: "quick done" });
    await eventually(async () => (await toOwner(niwa)).some((message) => message.body.text === "quick done"), "the other task should have been reported");
    expect((await toOwner(niwa)).map((message) => message.body.text)).toEqual(["quick done"]);

    release();
    await eventually(async () => (await toOwner(niwa)).length >= 3, "the slow task should be reported too");
    expect((await toOwner(niwa)).filter((message) => message.task === slowTask).map((message) => message.body.type)).toEqual(["update", "result"]);
  });
}, 30_000);

test("a result too large for a message is kept as an artifact, and the end of the next task is still reported", async () => {
  await served([], async (niwa, worker) => {
    const big = "x".repeat(150 * 1024);
    const first = (await niwa.call(taskCreate, input("big"))).id;
    await worker.call(taskFinish, { task: first, result: big });
    const second = (await niwa.call(taskCreate, input("small"))).id;
    await worker.call(taskFinish, { task: second, result: "small done" });

    await eventually(async () => (await toOwner(niwa)).length >= 2, "both ends should have been reported");
    const messages = await toOwner(niwa);
    const [bigMessage, smallMessage] = messages;
    expect(smallMessage?.body.text).toBe("small done");

    // The message holds a short text and the reference, not the result twice.
    expect(bigMessage?.body.type).toBe("result");
    expect(Buffer.byteLength(JSON.stringify(bigMessage))).toBeLessThan(ARTIFACT_THRESHOLD);
    const kept = (bigMessage?.body.data as { artifact: { digest: string; size: number } }).artifact;
    expect(Buffer.from(niwa.artifacts.read(kept)).toString()).toBe(JSON.stringify(big));

    // The whole result is still what the task gives.
    expect(await niwa.call(taskResult, { task: first })).toEqual({ task: first, outcome: { status: "result", result: big } });
  });
}, 30_000);

test("a failure whose reason is too large for a message is kept as an artifact too", async () => {
  await served([], async (niwa, worker) => {
    const reason = "e".repeat(100 * 1024);
    const { id } = await niwa.call(taskCreate, input());
    await worker.call(taskFail, { task: id, reason });
    await eventually(async () => (await toOwner(niwa)).length >= 1, "the failure should have been reported");
    const [message] = await toOwner(niwa);
    expect(message?.body.type).toBe("failure");
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(ARTIFACT_THRESHOLD);
    const kept = (message?.body.data as { artifact: { digest: string } }).artifact;
    expect(Buffer.from(niwa.artifacts.read(kept)).toString()).toBe(reason);
  });
}, 30_000);

test("an end that no record could hold is refused before anything is written, and the task stays open", async () => {
  await served([], async (niwa, worker) => {
    const { id } = await niwa.call(taskCreate, input());
    await expect(worker.call(taskFinish, { task: id, result: "y".repeat(RECORD_DATA_LIMIT) })).rejects.toThrow("more than a record holds");
    await worker.call(taskFinish, { task: id, result: "fits" });
    expect(await niwa.call(taskResult, { task: id })).toEqual({ task: id, outcome: { status: "result", result: "fits" } });
  });
}, 30_000);
