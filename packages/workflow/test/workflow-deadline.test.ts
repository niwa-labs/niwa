// The deadline of a run: `limits.deadline` bounds the whole script. When it comes the run pauses
// with a choice of extend or cancel; nothing new is entered until the owner extends it, and a run
// it starts takes no later deadline than its own.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { createNiwa, requests, eventually, tempHome, testClock, timers, WfNote, stub } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const NOTE = 'const Note = record("note", z.object({ text: z.string() })); ';

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ niwa: Host; clock: TestClock; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const niwa = createNiwa({ home: home.path, clock });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(stub(home.path));
  niwa.use(workflow({ emits: [WfNote] }));
  await niwa.serve();
  hosts.push(niwa);
  return { niwa, clock, home: home.path };
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input as never) as Promise<O>;
const ofType = async (niwa: Host, type: string): Promise<StoredRecord[]> => (await niwa.records.read()).filter((row) => row.type === type);
const notes = async (niwa: Host): Promise<string[]> => (await ofType(niwa, "wf.demo.note")).map((row) => (row.data as { text: string }).text);

const SCRIPT = `${NOTE}export default workflow({ name: "demo", emits: [Note], output: z.json() }, async () => {
  await emit(Note, { text: "first" });
  await sleep("10m");
  await emit(Note, { text: "second" });
  return "done";
});`;

async function started(niwa: Host, home: string, limits?: unknown): Promise<string> {
  const file = join(home, "script.js");
  await writeFile(file, SCRIPT);
  const { run } = await call<{ run: string }>(niwa, "workflow.start", { file, ...(limits === undefined ? {} : { limits }) });
  await eventually(async () => (await ofType(niwa, "timer.sleep.requested")).length === 1, 10_000, "the sleep should be armed");
  return run;
}

type Status = { state: string; reason?: string; choices?: string[]; manualPause?: { kind?: string } };

test("a run that reaches its deadline pauses with extend or cancel, enters nothing new, and goes on once extended", async () => {
  const { niwa, clock, home } = await served();
  const run = await started(niwa, home, { deadline: 5 * MINUTE });

  await clock.advance(5 * MINUTE);
  const paused = await call<Status>(niwa, "workflow.wait", { run, timeoutMs: 1 });
  expect(paused).toMatchObject({ state: "paused", choices: ["extend", "cancel"], manualPause: { kind: "deadline" } });
  expect(paused.reason).toContain("deadline");
  // The list of runs says how the pause is answered.
  const { runs } = await call<{ runs: string[] }>(niwa, "workflow.runs", {});
  expect(runs.find((line) => line.startsWith(run.slice(0, 8)) || line.includes("paused"))).toContain("niwa workflow.extend --run");
  // A plain continue does not get past a deadline: only more time does.
  const pause = (await ofType(niwa, "workflow.run.pause-requested")).at(-1)!;
  await expect(call(niwa, "workflow.continue", { run, pause: String(pause.id) })).rejects.toThrow(/workflow.extend/);

  // The sleep ends, and the script is held before its next step.
  await clock.advance(5 * MINUTE);
  await Bun.sleep(300);
  expect(await notes(niwa)).toEqual(["first"]);

  await call(niwa, "workflow.extend", { run, by: 10 * MINUTE });
  await eventually(async () => (await ofType(niwa, "workflow.run.finished")).length === 1, 10_000, "the run should finish once extended");
  expect(await notes(niwa)).toEqual(["first", "second"]);
  expect((await ofType(niwa, "workflow.run.deadline-extended")).map((row) => row.data)).toEqual([{ run, deadline: START + 20 * MINUTE }]);
}, 30_000);

test("a run with no deadline does not pause on the clock", async () => {
  const { niwa, clock, home } = await served();
  const run = await started(niwa, home);
  await clock.advance(10 * MINUTE);
  await eventually(async () => (await ofType(niwa, "workflow.run.finished")).length === 1, 10_000, "the run should finish");
  expect(await ofType(niwa, "workflow.run.pause-requested")).toEqual([]);
  expect((await call<Status>(niwa, "workflow.wait", { run, timeoutMs: 1 })).state).toBe("finished");
});

test("a run that finished before its deadline is not paused when the deadline comes", async () => {
  const { niwa, clock, home } = await served();
  await started(niwa, home, { deadline: 30 * MINUTE });
  await clock.advance(10 * MINUTE);
  await eventually(async () => (await ofType(niwa, "workflow.run.finished")).length === 1, 10_000, "the run should finish");
  await clock.advance(30 * MINUTE);
  expect(await ofType(niwa, "workflow.run.pause-requested")).toEqual([]);
});
