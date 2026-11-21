// A run belongs to a directory, the project it was started for, and keeps it.
//
//   1. a start that names a directory records it: the run list and the inspection show it
//   2. a resume starts the run again and the run keeps its directory
//   3. a start that names none has none, and a relative path is refused
//   4. the run list has one entry per run, in the order the runs began

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa, eventually, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowInspect, workflowResume, workflowRuns, workflowStart, workflowWait } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function setup(): Promise<{ niwa: Host; file: string }> {
  const home = await tempHome();
  homes.push(home);
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(workflow());
  await niwa.serve();
  hosts.push(niwa);
  const file = join(home.path, "plain.js");
  await writeFile(file, `export default workflow({ output: z.string() }, async () => { await now({ label: "tick" }); return "done"; });`);
  return { niwa, file };
}

test("a run records the directory it was started for and keeps it through a resume", async () => {
  const { niwa, file } = await setup();
  const { run } = await niwa.call(workflowStart, { file, directory: "/work/project-a", label: "plain" });
  await niwa.call(workflowWait, { run, timeoutMs: 10_000 });

  const { entries } = await niwa.call(workflowRuns, {});
  expect(entries).toMatchObject([{ run, name: "plain", state: "finished", directory: "/work/project-a" }]);
  expect((await niwa.call(workflowInspect, { run })).origin.directory).toBe("/work/project-a");

  await niwa.call(workflowResume, { run });
  await eventually(
    async () => (await niwa.call(workflowInspect, { run })).origin.requestedAt !== undefined,
    10_000,
    "the resumed run should be asked for",
  );
  await niwa.call(workflowWait, { run, timeoutMs: 10_000 });
  expect((await niwa.call(workflowRuns, {})).entries).toMatchObject([{ run, directory: "/work/project-a" }]);
  expect((await niwa.call(workflowInspect, { run })).origin.directory).toBe("/work/project-a");
}, 30_000);

test("a start that names no directory has none, and a relative one is refused", async () => {
  const { niwa, file } = await setup();
  await expect(niwa.call(workflowStart, { file, directory: "relative/dir" })).rejects.toThrow(/absolute path/);

  const first = await niwa.call(workflowStart, { file, directory: "/work/a" });
  await niwa.call(workflowWait, { run: first.run, timeoutMs: 10_000 });
  const second = await niwa.call(workflowStart, { file });
  await niwa.call(workflowWait, { run: second.run, timeoutMs: 10_000 });

  const { entries, runs } = await niwa.call(workflowRuns, {});
  expect(entries.map((entry) => entry.run)).toEqual([first.run, second.run]);
  expect(runs).toHaveLength(2);
  expect(entries[0]?.directory).toBe("/work/a");
  expect(entries[1]?.directory).toBeUndefined();
  expect((await niwa.call(workflowInspect, { run: second.run })).origin.directory).toBeUndefined();
}, 30_000);
