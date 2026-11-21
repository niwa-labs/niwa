// examples/13-workflow-client.ts runs on a host: the task is made, the script waits for its end
// or for the timeout, asks the owner, and sleeps.

import { afterEach, expect, test } from "bun:test";

import { seq, owner } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connect, createNiwa, messages, requests, tasks, timers, eventually, tempHome, testClock, ownerTokenOf, connectAsOwner } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const EXAMPLE = new URL("../examples/13-workflow-client.ts", import.meta.url).pathname;

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** The workflow speaks as the owner, in its handlers and in the runs of its scripts; the client "builder" is the agent the task is given to. */
const bind: CallerBinding = (caller) => {
  if (caller.kind === "handler" && caller.handler.startsWith("workflow/")) return owner;
  if (caller.kind === "client" && caller.principal?.kind === "run") return owner;
  if (caller.kind === "client" && caller.id.startsWith("builder")) return { kind: "agent", id: "builder" };
  return undefined;
};

async function hostOn(path: string, clock: TestClock): Promise<Host> {
  const niwa = createNiwa({ home: path, clock });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  niwa.use(workflow({ root: process.cwd() }));
  await niwa.serve();
  hosts.push(niwa);
  return niwa;
}

const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read();
const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] =>
  records.filter((row) => row.type === type);
const resultOf = async (niwa: Host): Promise<unknown> =>
  (ofType(await recordsOf(niwa), "workflow.run.finished")[0]?.data as { outcome?: { result?: unknown } } | undefined)?.outcome?.result;
const hasFinished = async (niwa: Host): Promise<boolean> =>
  ofType(await recordsOf(niwa), "workflow.run.finished").length > 0;

test("the task ends in time: the script sleeps and finishes", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  await niwa.call("workflow.start" as ActionName, { file: EXAMPLE } as never);
  await eventually(async () => ofType(await recordsOf(niwa), "task.created").length === 1, 10_000);
  const task = (ofType(await recordsOf(niwa), "task.created")[0]?.data as { id: string }).id;
  // A wait sees only the records written after it began, and its timeout is armed once it has: a task that
  // is finished before the script waits is never seen, and the script waits for ever.
  await eventually(
    async () => ofType(await recordsOf(niwa), "timer.sleep.requested").length === 1,
    10_000,
    "the script should wait for the task",
  );
  const builder = await connectAsOwner(home.path, "builder");
  await builder.call("task.finish" as ActionName, { task, result: "ok" } as never);
  await builder.close();
  await eventually(
    async () => ofType(await recordsOf(niwa), "timer.sleep.requested").length === 2,
    10_000,
    "the script should sleep after the task",
  );
  await clock.advance(5 * MINUTE);
  await eventually(() => hasFinished(niwa), 10_000, "the run should finish");
  expect(await resultOf(niwa)).toEqual({ status: "done: result", task });
}, 30_000);

test("the task is slow and the owner says no: the script gives up", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  const owner = await connect({ home: home.path, id: "owner:example", token: ownerTokenOf(home.path) });
  try {
    await niwa.call("workflow.start" as ActionName, { file: EXAMPLE } as never);
    await eventually(async () => ofType(await recordsOf(niwa), "timer.sleep.requested").length === 1, 10_000);
    await clock.advance(30 * MINUTE);
    await eventually(async () => ofType(await recordsOf(niwa), "request.created").length === 1, 10_000);
    const id = (ofType(await recordsOf(niwa), "request.created")[0]?.data as { id: string }).id;
    await owner.call("request.answer" as ActionName, { id, answer: { ids: ["no"] } } as never);
    await eventually(() => hasFinished(niwa), 10_000, "the run should finish");
    expect(await resultOf(niwa)).toEqual({ status: "gave up" });
  } finally {
    await owner.close().catch(() => {});
  }
}, 30_000);
