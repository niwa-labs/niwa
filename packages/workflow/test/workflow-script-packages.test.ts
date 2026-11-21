// A plugin outside niwa may give scripts a package of its own (`@niwa-labs/forge/flow`): it offers the package to
// the workflow module as one scripts import, and a stored copy finds it, is checked against it and runs with it as a
// script in niwa's tree does. Its manifest names it with its version, and a script process in a box may read it. A
// package nobody offers is not found by a stored copy.

import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SCRIPT_PACKAGE } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { nono } from "@niwa-labs/sandbox";
import { createNiwa, live, plugin, requests, tempDir, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { workflow, workflowCheck, workflowRegister, workflowStart, workflowWait } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const NAME = "@niwa-labs/shelf";

/** A folder under the user's home, removed with the homes: nono reads the temp area by default, so a box proves nothing there. */
function userDir(): { path: string; cleanup(): Promise<void> } {
  const path = mkdtempSync(join(homedir(), ".niwa-script-package-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** A package outside niwa's tree, as another repository's plugin would ship it, and a script folder that finds it. */
async function outside(at?: string): Promise<{ root: string; script: string }> {
  const base = realpathSync(at ?? (await tempDir("script-package")));
  const root = join(base, "src", "node_modules", "@niwa-labs", "shelf");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: NAME, version: "1.4.2", type: "module", exports: { ".": "./index.ts", "./flow": "./flow.ts" } }),
  );
  await writeFile(join(root, "index.ts"), "export const shelf = 'shelf';\n");
  await writeFile(join(root, "flow.ts"), "export function label(n: number): string {\n  return `shelf ${String(n)}`;\n}\n");
  const script = join(base, "src", "shelf.ts");
  await mkdir(join(base, "src"), { recursive: true });
  await writeFile(
    script,
    [
      'import { label } from "@niwa-labs/shelf/flow";',
      'export default workflow({ description: "Label with a package from outside niwa", output: z.string() }, async () => label(3));',
    ].join("\n"),
  );
  return { root, script };
}

/** The plugin that ships the package and offers it to scripts. */
const shelf = (root: string): Plugin => plugin("shelf", (api) => api.offer(SCRIPT_PACKAGE, { name: NAME, root }));

async function served(extra: Plugin[], box = false): Promise<{ host: Host; home: string }> {
  const temp = box ? userDir() : await tempHome();
  homes.push(temp);
  const host = createNiwa({ home: temp.path });
  host.use(requests(), timers([]), ...extra, workflow(box ? { box: true, sandbox: "nono" } : {}));
  await host.serve();
  hosts.push(host);
  return { host, home: realpathSync(temp.path) };
}

async function registerAndRun(host: Host, file: string): Promise<{ id: string; version: string; outcome: unknown }> {
  const { id, version } = await host.call(workflowRegister, { file });
  const { run } = await host.call(workflowStart, { id });
  const outcome = (await host.call(workflowWait, { run, timeoutMs: 30_000 })).outcome;
  return { id, version, outcome };
}

test("a stored script imports a package a plugin offers to scripts, and its manifest names it with its version", async () => {
  const { root, script } = await outside();
  const { host, home } = await served([shelf(root)]);
  expect((await host.call(workflowCheck, { file: script })).errors).toEqual([]);
  const { id, version, outcome } = await registerAndRun(host, script);
  expect(outcome).toEqual({ status: "done", result: "shelf 3" });
  const manifest = JSON.parse(readFileSync(join(home, "workflows", id, `${version}.json`), "utf8")) as { imports: Record<string, string | null> };
  expect(manifest.imports).toEqual({ "@niwa-labs/shelf/flow": "1.4.2" });
}, 60_000);

test("a stored copy does not find a package no plugin offers to scripts", async () => {
  const { script } = await outside();
  const { host } = await served([]);
  await expect(registerAndRun(host, script)).rejects.toThrow("Cannot find module '@niwa-labs/shelf/flow'");
}, 60_000);

test("an offer of a package that is not a niwa package at its folder is not given to scripts, and the host says why", async () => {
  const { root, script } = await outside();
  const said: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => void said.push(args.map(String).join(" ")));
  try {
    const wrongName = plugin("wrong", (api) => api.offer(SCRIPT_PACKAGE, { name: "left-pad", root }));
    const wrongRoot = plugin("elsewhere", (api) => api.offer(SCRIPT_PACKAGE, { name: "@niwa-labs/other", root }));
    const { host } = await served([wrongName, wrongRoot]);
    expect(said).toContain('niwa: the package "wrong" offers scripts is not given to them: "left-pad" is not a package of @niwa-labs');
    expect(said).toContain(`niwa: the package "elsewhere" offers scripts is not given to them: ${root} is not the folder of @niwa-labs/other`);
    await expect(registerAndRun(host, script)).rejects.toThrow("Cannot find module '@niwa-labs/shelf/flow'");
  } finally {
    error.mockRestore();
  }
}, 60_000);

const boxed = live && (await nono().available());

test.skipIf(!boxed)("a stored script that imports an offered package runs in a nono box", async () => {
  const place = userDir();
  homes.push(place);
  const { root, script } = await outside(place.path);
  const { host } = await served([shelf(root)], true);
  expect((await registerAndRun(host, script)).outcome).toEqual({ status: "done", result: "shelf 3" });
}, 60_000);
