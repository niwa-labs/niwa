// The code of a registered workflow is kept in the home: `workflow.register` copies the source closure of the version
// under `<home>/workflows/<wf-id>/<version>/`, and the version runs, installs and resumes from that copy, so the file
// it was registered from may be edited or deleted.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, requests, eventually, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowGet, workflowRegister, workflowResume, workflowStart, workflowWait } from "../src/index.ts";
import { z } from "zod";

import { versionOf } from "../src/registry.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

/** Whether `gate.pass` fails: a run that calls it while it does pauses. */
let shut = false;
const gate = action("gate.pass", {
  description: "Pass the gate, or fail while it is shut.",
  input: z.object({}),
  output: z.object({ passed: z.boolean() }),
  recovery: "repeat",
  effect: "write",
  run: () => {
    if (shut) throw new Error("the gate is shut");
    return { passed: true };
  },
});

async function served(): Promise<{ host: Host; home: string; src: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("gate", (api) => api.action(gate)), workflow());
  await host.serve();
  hosts.push(host);
  const src = join(home.path, "src");
  // The host knows its home with the links resolved, and keeps the code there.
  await mkdir(join(src, "flows"), { recursive: true });
  await mkdir(join(src, "lib"), { recursive: true });
  return { host, home: realpathSync(home.path), src };
}

/** A script in `flows/` that imports a helper from `../lib/`, and returns its label. */
async function labelled(src: string, label: string): Promise<string> {
  await writeFile(join(src, "lib", "label.ts"), `export const label = ${JSON.stringify(label)};\n`);
  const file = join(src, "flows", "label.ts");
  await writeFile(
    file,
    [
      'import { label } from "../lib/label.ts";',
      "export default workflow({",
      '  description: "Answer the label",',
      "  output: z.string(),",
      "}, async () => label);",
    ].join("\n"),
  );
  return file;
}

const run = async (host: Host, id: string): Promise<unknown> => {
  const { run: started } = await host.call(workflowStart, { id });
  return (await host.call(workflowWait, { run: started, timeoutMs: 20_000 })).outcome;
};

test("register copies the source closure into the home, laid out as it was, and get shows where", async () => {
  const { host, home, src } = await served();
  const file = await labelled(src, "one");
  const { id, version } = await host.call(workflowRegister, { file });

  const dir = join(home, "workflows", id, version);
  expect(readFileSync(join(dir, "flows", "label.ts"), "utf8")).toBe(readFileSync(file, "utf8"));
  expect(readFileSync(join(dir, "lib", "label.ts"), "utf8")).toBe('export const label = "one";\n');
  // The copy is the version: the same files at the same places relative to the entry.
  expect(versionOf(join(dir, "flows", "label.ts"))).toBe(version);
  expect(JSON.parse(readFileSync(join(home, "workflows", id, `${version}.json`), "utf8"))).toEqual({ entry: "flows/label.ts", from: file });

  const got = await host.call(workflowGet, { id });
  expect(got.versions).toMatchObject([{ version, file, stored: join(dir, "flows", "label.ts") }]);

  // The same version again is the same copy, not written again.
  await host.call(workflowRegister, { file, id });
  expect((await host.call(workflowGet, { id })).versions.map((one) => one.stored)).toEqual([join(dir, "flows", "label.ts")]);
}, 60_000);

test("a registered workflow runs from its copy after the file it was registered from is edited or deleted", async () => {
  const { host, src } = await served();
  const file = await labelled(src, "one");
  const { id } = await host.call(workflowRegister, { file });

  await writeFile(join(src, "lib", "label.ts"), 'export const label = "edited";\n');
  expect(await run(host, id)).toEqual({ status: "done", result: "one" });

  await rm(src, { recursive: true });
  expect(await run(host, id)).toEqual({ status: "done", result: "one" });
}, 60_000);

test("two versions are kept side by side, and a start runs the latest one", async () => {
  const { host, home, src } = await served();
  const first = await host.call(workflowRegister, { file: await labelled(src, "one") });
  const second = await host.call(workflowRegister, { file: await labelled(src, "two"), id: first.id });
  expect(second.version).not.toBe(first.version);

  const stored = (await host.call(workflowGet, { id: first.id })).versions.map((one) => one.stored);
  expect(stored).toEqual([join(home, "workflows", first.id, first.version, "flows", "label.ts"), join(home, "workflows", first.id, second.version, "flows", "label.ts")]);
  for (const entry of stored) expect(existsSync(entry ?? "")).toBe(true);
  expect(readFileSync(join(home, "workflows", first.id, first.version, "lib", "label.ts"), "utf8")).toContain('"one"');
  expect(readFileSync(join(home, "workflows", first.id, second.version, "lib", "label.ts"), "utf8")).toContain('"two"');

  await rm(src, { recursive: true });
  expect(await run(host, first.id)).toEqual({ status: "done", result: "two" });
}, 60_000);

test("a paused run of an older version resumes on its own copy, after a new version and with the original deleted", async () => {
  const { host, src } = await served();
  const file = join(src, "flows", "gated.ts");
  const gated = (label: string): string =>
    [
      "export default workflow({",
      '  description: "Pass the gate and answer the label",',
      '  uses: ["gate.pass"],',
      "  output: z.string(),",
      "}, async () => {",
      '  await call("gate.pass", {}, { label: "gate" });',
      `  return ${JSON.stringify(label)};`,
      "});",
    ].join("\n");
  await writeFile(file, gated("old"));
  const { id, version } = await host.call(workflowRegister, { file });

  shut = true;
  try {
    const { run: started } = await host.call(workflowStart, { id });
    expect((await host.call(workflowWait, { run: started, timeoutMs: 20_000 })).state).toBe("paused");

    await writeFile(file, gated("new"));
    const newer = await host.call(workflowRegister, { file, id });
    expect(newer.version).not.toBe(version);
    await rm(src, { recursive: true });

    shut = false;
    await host.call(workflowResume, { run: started });
    await eventually(async () => (await host.call(workflowWait, { run: started, timeoutMs: 1_000 })).state === "finished", 20_000);
    expect((await host.call(workflowWait, { run: started, timeoutMs: 1_000 })).outcome).toEqual({ status: "done", result: "old" });
    // A new start runs the new version.
    expect(await run(host, id)).toEqual({ status: "done", result: "new" });
  } finally {
    shut = false;
  }
}, 90_000);

test("a copy finds what the script takes from niwa: its globals, the types of the script package and the packages niwa runs with", async () => {
  const { host, home, src } = await served();
  // The original sits where zod is found, as a script in niwa's own tree does: a package it imports is found from the copy too.
  await symlink(realpathSync(join(import.meta.dir, "..", "node_modules")), join(src, "node_modules"), "dir");
  const file = join(src, "flows", "packages.ts");
  await writeFile(
    file,
    [
      'import type { ScriptApi } from "@niwa-labs/script";',
      'import { z as zod } from "zod";',
      "const answer: ScriptApi[\"z\"] = z;",
      "export default workflow({",
      '  description: "Parse with an imported zod",',
      "  output: z.string(),",
      "}, async () => `${String(answer === z)}:${zod.string().parse(\"ok\")}`);",
    ].join("\n"),
  );
  const { id } = await host.call(workflowRegister, { file });
  expect(realpathSync(join(home, "workflows", "node_modules"))).toBe(realpathSync(join(import.meta.dir, "..", "node_modules")));

  await rm(src, { recursive: true });
  expect(await run(host, id)).toEqual({ status: "done", result: "true:ok" });
}, 60_000);
