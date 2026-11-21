// A replay does nothing twice, and a script edited mid-run is noticed.
//
// A resume starts another invocation of the run and replays the script from the top: the requests
// that are not calls (emit, ask, sleep, now, random) answer from what the earlier start recorded,
// as the calls do. The file of the script is pinned by its hash, so a run entered again over an
// edited file pauses for a revision. A label is the name of one call, kept apart from the records
// the run writes itself.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { connect, createNiwa, requests, counter, eventually, tempHome, testClock, ownerTokenOf, timers, WfNote, stub } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";
import { z } from "zod";


const START = 1_700_000_000_000;
const MINUTE = 60_000;
const NOTE = 'const Note = record("note", z.object({ text: z.string() })); ';

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

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

const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read(seq(0));
const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] =>
  records.filter((row) => row.type === type);
const count = async (niwa: Host, type: string): Promise<number> => ofType(await recordsOf(niwa), type).length;

const Started = z.object({ run: z.string() });
const Paused = z.object({ reason: z.string() });
const Finished = z.object({ outcome: z.object({ result: z.unknown() }) });

/** Write the script into the home. */
async function write(home: string, source: string): Promise<string> {
  const file = join(home, "script.js");
  await writeFile(file, source);
  return file;
}

async function start(niwa: Host, file: string): Promise<string> {
  return Started.parse(await niwa.call("workflow.start" as ActionName, { file } as never)).run;
}

const resultsOf = async (niwa: Host): Promise<unknown[]> =>
  ofType(await recordsOf(niwa), "workflow.run.finished").map((row) => Finished.parse(row.data).outcome.result);

const reasonsOf = async (niwa: Host): Promise<string[]> =>
  ofType(await recordsOf(niwa), "workflow.run.paused").map((row) => Paused.parse(row.data).reason);

test("a resume does not emit, ask or sleep again, and reads the same now and random", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  const owner = await connect({ home: home.path, id: "owner:replay", token: ownerTokenOf(home.path) });
  try {
    const file = await write(
      home.path,
      `${NOTE}export default workflow({ name: "demo", emits: [Note], output: z.json() }, async () => {
         const at = await now();
         const dice = await random();
         await emit(Note, { text: "once" });
         await sleep("1m");
         const answer = await ask.confirm("Go on?");
         return { at, dice, answer };
       });`,
    );
    const run = await start(niwa, file);
    await eventually(async () => (await count(niwa, "timer.sleep.requested")) === 1, 10_000, "the sleep should be armed");
    await clock.advance(MINUTE);
    await eventually(async () => (await count(niwa, "request.created")) === 1, 10_000, "the owner should be asked");
    const id = (ofType(await recordsOf(niwa), "request.created")[0]?.data as { id: string }).id;
    await owner.call("request.answer" as ActionName, { id, answer: { ids: ["yes"] } } as never);
    await eventually(async () => (await resultsOf(niwa)).length === 1, 10_000, "the first run should finish");

    // Much later, the run is resumed: the whole script is replayed, and nothing is done again.
    await clock.advance(30 * MINUTE);
    await niwa.call("workflow.resume" as ActionName, { run } as never);
    await eventually(async () => (await resultsOf(niwa)).length === 2, 10_000, "the replay should finish by itself");

    const [first, second] = await resultsOf(niwa);
    expect(second).toEqual(first);
    expect((first as { at: number }).at).toBe(START);
    expect(await count(niwa, "wf.demo.note")).toBe(1);
    expect(await count(niwa, "timer.sleep.requested")).toBe(1);
    expect(await count(niwa, "request.created")).toBe(1);
  } finally {
    await owner.close().catch(() => {});
  }
}, 30_000);

test("a script edited while its run was away pauses the run for a revision, and a resume revises it", async () => {
  const home = await tempHome();
  homes.push(home);
  const first = await hostOn(home.path, testClock(START));
  const file = await write(home.path, `export default workflow({ output: z.string() }, async () => { await sleep("5m"); return "old"; });`);
  const run = await start(first, file);
  await eventually(async () => (await count(first, "timer.sleep.requested")) === 1, 10_000, "the sleep should be armed");
  await first.close();

  // The file is edited while the host is down; the new host finds the run again.
  await writeFile(file, `export default workflow({ output: z.string() }, async () => { await sleep("5m"); return "new"; });`);
  const clock = testClock(START + MINUTE);
  const second = await hostOn(home.path, clock);
  await eventually(async () => (await reasonsOf(second)).length === 1, 10_000, "the run should pause");
  expect((await reasonsOf(second))[0]).toContain("edited");
  await clock.advance(10 * MINUTE);
  await Bun.sleep(300);
  expect(await resultsOf(second)).toEqual([]);

  // The owner resumes it: the edit is a revision, and the sleep goes on from its own moment.
  await second.call("workflow.resume" as ActionName, { run } as never);
  await eventually(async () => (await resultsOf(second)).length === 1, 10_000, "the revised run should finish");
  expect(await resultsOf(second)).toEqual(["new"]);
}, 30_000);

test("an emit recorded under a key with other data is shown, not written again", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const file = await write(
    home.path,
    `${NOTE}export default workflow({ name: "demo", emits: [Note], output: z.string() }, async () => { await emit(Note, { text: "old" }, { label: "note" }); return "ok"; });`,
  );
  const run = await start(niwa, file);
  await eventually(async () => (await resultsOf(niwa)).length === 1, 10_000, "the run should finish");

  await writeFile(file, `${NOTE}export default workflow({ name: "demo", emits: [Note], output: z.string() }, async () => { await emit(Note, { text: "new" }, { label: "note" }); return "ok"; });`);
  await niwa.call("workflow.resume" as ActionName, { run } as never);
  await eventually(async () => (await reasonsOf(niwa)).length === 1, 10_000, "the run should pause on the emit");
  expect((await reasonsOf(niwa))[0]).toContain("label:note");
  expect(await count(niwa, "wf.demo.note")).toBe(1);
}, 30_000);

test("a label is not the name of a record the run writes itself", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const file = await write(
    home.path,
    `${NOTE}export default workflow({ name: "demo", emits: [Note], output: z.string() }, async () => {
       await emit(Note, { text: "x" }, { label: "finished" });
       await emit(Note, { text: "y" }, { label: "started" });
       return "ok";
     });`,
  );
  await start(niwa, file);
  await eventually(async () => (await resultsOf(niwa)).length === 1, 10_000, "the run should finish");
  expect(await resultsOf(niwa)).toEqual(["ok"]);
  expect(await count(niwa, "wf.demo.note")).toBe(2);
}, 30_000);

test("a label used twice in a run is refused, and the second call does not run", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const file = await write(
    home.path,
    `export default workflow({}, async () => {
       for (const name of ["a", "b"]) await niwa.stub.create({ name }, { label: "make" });
     });`,
  );
  await start(niwa, file);
  await eventually(async () => (await reasonsOf(niwa)).length === 1, 10_000, "the run should pause");
  expect((await reasonsOf(niwa))[0]).toContain('the label "make" is used twice');
  expect(counter(home.path, "w1.create").count()).toBe(1);
}, 30_000);

test("a label that holds the mark of a call's own steps is refused", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const file = await write(
    home.path,
    `export default workflow({}, async () => { await niwa.stub.create({ name: "a" }, { label: "make~auth" }); });`,
  );
  await start(niwa, file);
  await eventually(async () => (await reasonsOf(niwa)).length === 1, 10_000, "the run should pause");
  expect((await reasonsOf(niwa))[0]).toContain('holds "~"');
  expect(counter(home.path, "w1.create").count()).toBe(0);
}, 30_000);
