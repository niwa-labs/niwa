// A script imports the query builders and the helpers a plugin gives scripts by the name of the
// plugin's package: `@niwa-labs/tasks/records`, `@niwa-labs/history/flow`. A stored copy finds
// them where it finds niwa's packages, and a script process in a box may read them.

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { readableRoots } from "../src/installation.ts";
import { workflow, workflowCheck, workflowRegister, workflowStart, workflowWait } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const SCRIPT = [
  'import { taskDone } from "@niwa-labs/tasks/records";',
  'import { sessionEnded } from "@niwa-labs/history/records";',
  'import { untilSessionEnded } from "@niwa-labs/history/flow";',
  'export default workflow({ description: "Name the end of a task and of a session", output: z.json() }, async (): Promise<any> => {',
  '  const task = taskDone("task-3fa9c2");',
  "  return { task: [task.types[0].name, task.filter], builders: [typeof sessionEnded, typeof untilSessionEnded] };",
  "});",
].join("\n");

test("a stored script imports the query builders and helpers of tasks and history by name", async () => {
  const temp = await tempHome();
  homes.push(temp);
  const host = createNiwa({ home: temp.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  const src = join(realpathSync(temp.path), "src");
  await mkdir(src, { recursive: true });
  await symlink(realpathSync(join(import.meta.dir, "..", "node_modules")), join(src, "node_modules"), "dir");
  const file = join(src, "ends.ts");
  await writeFile(file, SCRIPT);
  expect((await host.call(workflowCheck, { file })).errors).toEqual([]);
  const { id } = await host.call(workflowRegister, { file });
  const { run } = await host.call(workflowStart, { id });
  const outcome = (await host.call(workflowWait, { run, timeoutMs: 30_000 })).outcome;
  expect(outcome).toEqual({
    status: "done",
    result: { task: ["task.done", { task: "task-3fa9c2" }], builders: ["function", "function"] },
  });
}, 60_000);

test("a script process in a box may read the tasks and history packages", () => {
  const roots = readableRoots();
  for (const name of ["tasks", "history"]) expect(roots).toContain(realpathSync(join(import.meta.dir, "..", "..", name)));
});
