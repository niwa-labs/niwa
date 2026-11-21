// The rest of the script API: sleep, wait with a
// timeout, ask, emit, read, now and random. The host is in this process and its clock is the
// clock of the test, so a sleep is watched and not waited for.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { connect, createNiwa, requests, timers, eventually, tempHome, testClock, ownerTokenOf, WfNote, stub } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


const START = 1_700_000_000_000;
const MINUTE = 60_000;

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A host on a home, with the modules a script uses and a clock of the test's. */
async function hostOn(path: string, clock: TestClock): Promise<Host> {
  const niwa = createNiwa({ home: path, clock });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(stub(path));
  niwa.use(workflow({ emits: [WfNote] }));
  await niwa.serve();
  hosts.push(niwa);
  return niwa;
}

const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read();
const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] =>
  records.filter((row) => row.type === type);

/** Write a script into the home and start a run of it. */
async function run(niwa: Host, home: string, source: string): Promise<void> {
  const file = join(home, "script.js");
  await writeFile(file, source);
  await niwa.call("workflow.start" as ActionName, { file } as never);
}

const finishedOf = async (niwa: Host): Promise<unknown> =>
  (ofType(await recordsOf(niwa), "workflow.run.finished")[0]?.data as { outcome?: { result?: unknown } } | undefined)?.outcome?.result;

const hasFinished = async (niwa: Host): Promise<boolean> =>
  ofType(await recordsOf(niwa), "workflow.run.finished").length > 0;

const armed = async (niwa: Host, count = 1): Promise<boolean> =>
  ofType(await recordsOf(niwa), "timer.sleep.requested").length >= count;

test("W1b sleep records its wake-up moment on the first pass; a restart does not sleep again from the start", async () => {
  const home = await tempHome();
  homes.push(home);
  const first = await hostOn(home.path, testClock(START));
  await run(first, home.path, `export default workflow({ output: z.string() }, async () => { await sleep("5m"); return "up"; });`);
  await eventually(() => armed(first), 10_000, "the sleep should be armed");
  const request = ofType(await recordsOf(first), "timer.sleep.requested")[0]?.data as { at: number };
  expect(request.at).toBe(START + 5 * MINUTE);
  await first.close();

  // The new host comes up two minutes later: the script is replayed from the top, and the sleep
  // that began at the start of the run ends at its own moment, three minutes from now.
  const clock = testClock(START + 2 * MINUTE);
  const second = await hostOn(home.path, clock);
  await eventually(
    async () => (await recordsOf(second)).some((row) => row.type === "niwa.invocation.state"),
    10_000,
  );
  await clock.advance(3 * MINUTE - 1);
  expect(await hasFinished(second)).toBe(false);
  await clock.advance(1);
  await eventually(() => hasFinished(second), 10_000, "the run should wake");
  expect(await finishedOf(second)).toBe("up");
  const records = await recordsOf(second);
  expect(ofType(records, "timer.sleep.requested")).toHaveLength(1);
  expect(ofType(records, "timer.slept")).toHaveLength(1);
}, 30_000);

test("wait gives the data of the record, or {timedOut: true} at the end of the timeout", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  await run(
    niwa,
    home.path,
    `export default workflow({ output: z.json() }, async () => {
       return await wait("stub.finished", { filter: { id: "never" }, timeout: "10m" });
     });`,
  );
  await eventually(() => armed(niwa), 10_000, "the timeout should be armed");
  await clock.advance(10 * MINUTE);
  await eventually(() => hasFinished(niwa), 10_000, "the run should end by the timeout");
  expect(await finishedOf(niwa)).toEqual({ timedOut: true });
}, 30_000);

test("the wake of another sleep does not end a wait; the record does", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  await run(
    niwa,
    home.path,
    `export default workflow({ output: z.json() }, async () => {
       return await parallel([
         () => wait("stub.finished", { filter: { id: "x" }, timeout: "10m" }),
         async () => { await sleep("1m"); return "slept"; },
       ]);
     });`,
  );
  await eventually(() => armed(niwa, 2), 10_000, "both wakes should be armed");
  await clock.advance(MINUTE);
  await eventually(
    async () => ofType(await recordsOf(niwa), "timer.slept").length === 1,
    10_000,
    "the sleep should wake",
  );
  // Give the invocation the time it would need to end wrongly.
  await Bun.sleep(300);
  expect(await hasFinished(niwa)).toBe(false);
  // A record of the type that is not the one asked for does not end it either.
  await niwa.call("stub.finish" as ActionName, { id: "y" } as never);
  await niwa.call("stub.finish" as ActionName, { id: "x" } as never);
  await eventually(() => hasFinished(niwa), 10_000, "the record should end the wait");
  expect(await finishedOf(niwa)).toEqual([{ id: "x" }, "slept"]);
}, 30_000);

test("ask: no answer within the timeout is an error the script catches, not a false answer", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  await run(
    niwa,
    home.path,
    `export default workflow({ output: z.string() }, async () => {
       try { return await ask.confirm("Keep waiting?", { timeout: "10m" }); } catch (error) { return error.name; }
     });`,
  );
  await eventually(
    async () => ofType(await recordsOf(niwa), "request.created").length === 1,
    10_000,
    "the owner should be asked",
  );
  await clock.advance(10 * MINUTE);
  await eventually(() => hasFinished(niwa), 10_000, "the ask should end by the timeout");
  expect(await finishedOf(niwa)).toBe("AskExpired");
}, 30_000);

test("ask: the answer of the owner is the value", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const owner = await connect({ home: home.path, id: "owner:w1", token: ownerTokenOf(home.path) });
  try {
    await run(
      niwa,
      home.path,
      `export default workflow({ output: z.json() }, async () => {
         return await ask.confirm("Keep waiting?", { timeout: "10m" });
       });`,
    );
    await eventually(
      async () => ofType(await recordsOf(niwa), "request.created").length === 1,
      10_000,
      "the owner should be asked",
    );
    const id = (ofType(await recordsOf(niwa), "request.created")[0]?.data as { id: string }).id;
    await owner.call("request.answer" as ActionName, { id, answer: { ids: ["yes"] } } as never);
    await eventually(() => hasFinished(niwa), 10_000, "the answer should end the ask");
    expect(await finishedOf(niwa)).toBe(true);
  } finally {
    await owner.close().catch(() => {});
  }
}, 30_000);

test("call, emit, read, now and random", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  await niwa.call("stub.bump" as ActionName, {} as never);
  await run(
    niwa,
    home.path,
    `
     const Note = record("note", z.object({ text: z.string() }));
     export default workflow({ name: "demo", emits: [Note], output: z.json() }, async () => {
       const group = typeof (await niwa.stub);
       const made = await call("stub.create", { name: "x" });
       await niwa.stub.finish({ id: made.id });
       await emit(Note, { text: "hello" });
       const state = await read.state("stub");
       const records = await read.records({ types: ["stub.finished"] });
       return { group, made, state, finished: records.map((r) => r.data), at: await now(), dice: await random() };
     });`,
  );
  await eventually(() => hasFinished(niwa), 10_000, "the run should finish");
  const result = (await finishedOf(niwa)) as Record<string, unknown>;
  expect(result.group).toBe("function");
  expect(result.made).toEqual({ id: "t-x" });
  expect(result.state).toEqual({ count: 1 });
  expect(result.finished).toEqual([{ id: "t-x" }]);
  expect(result.at).toBe(START);
  expect(typeof result.dice).toBe("number");
  expect(ofType(await recordsOf(niwa), "wf.demo.note")).toHaveLength(1);
}, 30_000);

test("emit refuses what is not a record the script lists: a type by name is not one", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  await run(niwa, home.path, `export default workflow({ name: "demo" }, async () => { const write = emit; await write("stub.finished", { id: "z" }); });`);
  await eventually(
    async () => ofType(await recordsOf(niwa), "workflow.run.paused").length === 1,
    10_000,
    "the run should pause on the refusal",
  );
  const paused = ofType(await recordsOf(niwa), "workflow.run.paused")[0]?.data as { reason: string };
  expect(paused.reason).toContain("lists in workflow({ emits })");
  expect(ofType(await recordsOf(niwa), "stub.finished")).toHaveLength(0);
}, 30_000);
