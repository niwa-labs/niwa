// A cancelled or expired `ask` is answered from the journal on a resume.
//
// The first start threw `AskCancelled` or `AskExpired` at the script; a replay throws the same
// error again and puts no new question to the owner.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { RequestCreated, requestCancel } from "@niwa-labs/requests/records";
import { connect, createNiwa, requests, eventually, tempHome, testClock, ownerTokenOf, timers } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";
import { workflow, workflowCancel, workflowInspect, workflowResume, workflowStart } from "../src/index.ts";
import { z } from "zod";


const START = 1_700_000_000_000;
const MINUTE = 60_000;

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
  niwa.use(workflow());
  await niwa.serve();
  hosts.push(niwa);
  return niwa;
}

const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read();
const count = async (niwa: Host, type: string): Promise<number> => (await recordsOf(niwa)).filter((row) => row.type === type).length;
const Finished = z.object({ outcome: z.object({ result: z.unknown() }) });
const results = async (niwa: Host): Promise<unknown[]> =>
  (await recordsOf(niwa)).filter((row) => row.type === "workflow.run.finished").map((row) => Finished.parse(row.data).outcome.result);

/** The script asks once, with a timeout when it is given one, and returns the name of the error it caught. */
async function script(home: string, options: string): Promise<string> {
  const file = join(home, "script.js");
  await writeFile(
    file,
    `export default workflow({ output: z.string() }, async () => {
       try { return await ask.confirm("Go on?"${options}); } catch (error) { return error.name; }
     });`,
  );
  return file;
}

/** Run the script until the owner is asked, end the request, and let the run finish. */
async function firstStart(niwa: Host, file: string, end: () => Promise<void>): Promise<string> {
  const started = await niwa.call(workflowStart, { file });
  await eventually(async () => (await count(niwa, "request.created")) === 1, 10_000, "the owner should be asked");
  await end();
  await eventually(async () => (await results(niwa)).length === 1, 10_000, "the first start should finish");
  return started.run;
}

test("a resume after a cancelled ask throws the same error at the script and asks nothing", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const owner = await connect({ home: home.path, id: "owner:ask-cancel", token: ownerTokenOf(home.path) });
  try {
    const run = await firstStart(niwa, await script(home.path, ""), async () => {
      const created = (await recordsOf(niwa)).find((row) => row.type === "request.created");
      await owner.call(requestCancel, { id: RequestCreated.schema.parse(created?.data).id });
    });
    await niwa.call(workflowResume, { run });
    await eventually(async () => (await results(niwa)).length === 2, 10_000, "the replay should finish by itself");
    expect(await results(niwa)).toEqual(["AskCancelled", "AskCancelled"]);
    expect(await count(niwa, "request.created")).toBe(1);
    expect((await niwa.call(workflowInspect, { run })).steps).toMatchObject([
      { action: "request.ask", prompt: "Go on?", endedAt: expect.any(String), status: "cancelled" },
    ]);
  } finally {
    await owner.close().catch(() => {});
  }
}, 30_000);

test("a resume after an expired ask throws the same error at the script and asks nothing", async () => {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = await hostOn(home.path, clock);
  const run = await firstStart(niwa, await script(home.path, `, { timeout: "1m" }`), async () => {
    await clock.advance(2 * MINUTE);
  });
  await niwa.call(workflowResume, { run });
  await eventually(async () => (await results(niwa)).length === 2, 10_000, "the replay should finish by itself");
  expect(await results(niwa)).toEqual(["AskExpired", "AskExpired"]);
  expect(await count(niwa, "request.created")).toBe(1);
  expect((await niwa.call(workflowInspect, { run })).steps).toMatchObject([
    { action: "request.ask", prompt: "Go on?", endedAt: expect.any(String), status: "failed" },
  ]);
}, 30_000);

test("an ask cancelled and not caught waits for a revision or a cancel: a retry would get the same cancel", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const owner = await connect({ home: home.path, id: "owner:ask-uncaught", token: ownerTokenOf(home.path) });
  try {
    const file = join(home.path, "uncaught.js");
    await writeFile(file, `export default workflow({ output: z.boolean() }, async () => ask.confirm("Go on?", { label: "go" }));`);
    const { run } = await niwa.call(workflowStart, { file });
    await eventually(async () => (await count(niwa, "request.created")) === 1, 10_000, "the owner should be asked");
    const created = (await recordsOf(niwa)).find((row) => row.type === "request.created");
    await owner.call(requestCancel, { id: RequestCreated.schema.parse(created?.data).id });
    await eventually(async () => (await niwa.call(workflowInspect, { run })).status.state === "paused", 10_000, "the run should pause");
    const inspected = await niwa.call(workflowInspect, { run });
    // Only cancel: the replay throws AskCancelled again, so there is nothing to retry or skip.
    expect(inspected.status).toMatchObject({ state: "paused", choices: ["cancel"] });
    expect(inspected.status.reason).toContain("AskCancelled");
    expect(inspected.status.reason).not.toContain("handler error");
    expect(inspected.steps).toMatchObject([{ action: "request.ask", status: "cancelled" }]);
    await expect(niwa.call(workflowResume, { run, choice: "retry" })).rejects.toThrow();
    // The cancel ends it, and nothing is left waiting.
    await niwa.call(workflowCancel, { run });
    await eventually(async () => (await niwa.call(workflowInspect, { run })).status.state === "finished", 10_000, "the run should end");
    expect((await niwa.call(workflowInspect, { run })).status).toMatchObject({ state: "finished", outcome: { status: "cancelled" }, requests: [] });
  } finally {
    await owner.close().catch(() => {});
  }
}, 30_000);

test("a script error outside any step offers retry and cancel, not skip, and refuses a skip", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = await hostOn(home.path, testClock(START));
  const file = join(home.path, "boom.js");
  await writeFile(file, `export default workflow({}, async () => { throw new Error("boom"); });`);
  const { run } = await niwa.call(workflowStart, { file });
  await eventually(async () => (await niwa.call(workflowInspect, { run })).status.state === "paused", 10_000, "the run should pause");
  expect((await niwa.call(workflowInspect, { run })).status).toMatchObject({ state: "paused", reason: "boom", choices: ["retry", "cancel"] });
  await expect(niwa.call(workflowResume, { run, choice: "skip" })).rejects.toThrow(/does not offer skip/);
}, 30_000);
