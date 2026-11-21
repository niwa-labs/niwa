// The script libraries ship with the workflow module: a script that imports `@niwa-labs/flow`,
// `@niwa-labs/flow-code` or `@niwa-labs/flow-eval` by name is checked, stored and run like one
// that imports zod. The copy of a registered version finds them through the link to the packages
// niwa runs with, its manifest names them with their versions, and a script process in a box may
// read them.

import { afterEach, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { nono } from "@niwa-labs/sandbox";
import { createNiwa, live, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { readableRoots } from "../src/installation.ts";
import { workflow, workflowRegister, workflowStart, workflowWait } from "../src/index.ts";

const LIBRARIES = ["flow", "flow-code", "flow-eval"] as const;

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const SCRIPT = [
  'import { map } from "@niwa-labs/flow";',
  'import { selfTestVerdict } from "@niwa-labs/flow-code";',
  'import { blindSet } from "@niwa-labs/flow-eval";',
  'export default workflow({ description: "Use each flow library", output: z.json() }, async (): Promise<any> => {',
  '  const doubled = await map("double", [1, 2, 3], { key: (n) => "n" + String(n) }, async (n) => n * 2);',
  '  const blind = await blindSet("blind", { one: 1, two: 2 });',
  "  return {",
  "    doubled: doubled.map((one) => (one.ok ? one.value : null)),",
  '    verdict: selfTestVerdict([{ status: "pass" }]),',
  "    revealed: Object.keys(blind.labeled).map((label) => blind.reveal(label)).sort(),",
  "  };",
  "});",
].join("\n");

/** Register the script from a folder that finds packages where a script in niwa's tree does, and run it. */
async function registerAndRun(box: boolean): Promise<{ home: string; id: string; version: string; outcome: unknown }> {
  const temp = await tempHome();
  homes.push(temp);
  const host = createNiwa({ home: temp.path });
  host.use(requests(), timers([]), workflow(box ? { box: true, sandbox: "nono" } : {}));
  await host.serve();
  hosts.push(host);
  const home = realpathSync(temp.path);
  const src = join(home, "src");
  await mkdir(src, { recursive: true });
  await symlink(realpathSync(join(import.meta.dir, "..", "node_modules")), join(src, "node_modules"), "dir");
  await writeFile(join(src, "libraries.ts"), SCRIPT);
  const { id, version } = await host.call(workflowRegister, { file: join(src, "libraries.ts") });
  const { run } = await host.call(workflowStart, { id });
  const outcome = (await host.call(workflowWait, { run, timeoutMs: 30_000 })).outcome;
  return { home, id, version, outcome };
}

test("a stored script imports the script libraries by name, and its manifest names them with their versions", async () => {
  const { home, id, version, outcome } = await registerAndRun(false);
  expect(outcome).toEqual({ status: "done", result: { doubled: [2, 4, 6], verdict: "PASS", revealed: ["one", "two"] } });
  const manifest = JSON.parse(readFileSync(join(home, "workflows", id, `${version}.json`), "utf8")) as { imports: Record<string, string | null> };
  expect(manifest.imports).toEqual({ "@niwa-labs/flow": "0.0.0", "@niwa-labs/flow-code": "0.0.0", "@niwa-labs/flow-eval": "0.0.0" });
}, 60_000);

test("a script process in a box may read the script libraries", () => {
  const roots = readableRoots();
  for (const name of LIBRARIES) expect(roots).toContain(realpathSync(join(import.meta.dir, "..", "..", name)));
});

const boxed = live && (await nono().available());

test.skipIf(!boxed)("a stored script that imports the script libraries runs in a nono box", async () => {
  const { outcome } = await registerAndRun(true);
  expect(outcome).toEqual({ status: "done", result: { doubled: [2, 4, 6], verdict: "PASS", revealed: ["one", "two"] } });
}, 60_000);
