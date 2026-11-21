// Built-in workflows: a plugin offers a script it ships, and the workflow module
// registers and installs it when the host starts. A restart finds the same ids and makes nothing again, a changed file
// is a new version of the same workflow, a built-in no longer offered is uninstalled, and the owner neither registers a
// file under a built-in nor uninstalls one. A plugin offers the timers it needs, and a point nobody reads refuses to serve.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, TIMER_OFFER, plugin } from "@niwa-labs/plugin";
import { createNiwa, timer, timerList, timers, eventually, tempDir, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowGet, workflowInstallationGet, workflowInstallationList, workflowList, workflowRegister, workflowUninstall } from "../src/index.ts";
import { z } from "zod";

const Go = record("shipper.go", z.object({ n: z.number() }));

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A plugin that ships the built-in `answer` from a file, or nothing. */
function shipper(file: string | undefined) {
  return plugin("shipper", (api) => {
    api.declare(Go);
    if (file !== undefined) api.offer(BUILTIN_WORKFLOW, { name: "answer", file, description: "Answer every go", triggers: [Go] });
  });
}

/** The script of the built-in, answering `text`. */
function script(file: string, text: string): void {
  writeFileSync(file, `export default workflow({ on: ["shipper.go"], output: z.string() }, async () => ${JSON.stringify(text)});\n`);
}

async function served(home: string, file: string | undefined): Promise<Host> {
  const host = createNiwa({ home });
  host.use(shipper(file), workflow());
  await host.serve();
  hosts.push(host);
  return host;
}

async function stop(host: Host): Promise<void> {
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> => (await host.records.read(seq(0))).filter((row) => row.type === type);

/** Wait until the built-ins stand as asked: one installation of the built-in, or none. */
async function settled(host: Host, installed: number): Promise<void> {
  await eventually(async () => (await host.call(workflowInstallationList, {})).items.length === installed, 20_000, "the built-ins did not settle");
}

async function results(host: Host): Promise<unknown[]> {
  return (await ofType(host, "workflow.run.finished")).map((row) => (row.data as { outcome: { result?: unknown } }).outcome.result);
}

test("a built-in is registered and installed at start, marked with its plugin, and runs on its records", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join((await tempDir("builtin")), "answer.ts");
  script(file, "v1");
  const host = await served(home.path, file);
  await settled(host, 1);

  const [listed] = (await host.call(workflowList, {})).items;
  expect(listed?.builtin).toEqual({ plugin: "shipper", name: "answer" });
  expect(String(listed?.description)).toBe("Answer every go");
  const got = await host.call(workflowGet, { id: listed?.id ?? "" });
  expect(got.builtin).toEqual({ plugin: "shipper", name: "answer" });
  // The code is kept under the home: the run is of the copy, not of the file the plugin ships.
  expect(got.versions[0]?.stored).toContain(`/workflows/${String(listed?.id)}/`);
  const [installation] = (await host.call(workflowInstallationList, {})).items;
  expect(installation?.builtin).toEqual({ plugin: "shipper", name: "answer" });
  expect(installation?.workflow).toBe(listed?.id);
  expect((await host.call(workflowInstallationGet, { id: installation?.id ?? "" })).builtin).toEqual({ plugin: "shipper", name: "answer" });
  expect(installation?.file).not.toBe(file);

  await host.emit(Go, { n: 1 });
  await eventually(async () => (await results(host)).length === 1, 20_000, "the built-in did not run");
  expect(await results(host)).toEqual(["v1"]);
}, 60_000);

test("a restart finds the same ids and writes nothing; a changed file is a new version of the same workflow; one no longer offered is uninstalled", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join((await tempDir("builtin")), "answer.ts");
  script(file, "v1");

  const first = await served(home.path, file);
  await settled(first, 1);
  const [wf] = (await first.call(workflowList, {})).items;
  const [sub] = (await first.call(workflowInstallationList, {})).items;
  await stop(first);

  // The same file: the same workflow, the same installation, and not a record more.
  const again = await served(home.path, file);
  await Bun.sleep(300);
  expect((await again.call(workflowList, {})).items.map((one) => String(one.id))).toEqual([String(wf?.id)]);
  expect((await again.call(workflowInstallationList, {})).items.map((one) => String(one.id))).toEqual([String(sub?.id)]);
  expect(await ofType(again, "workflow.builtins.wanted")).toHaveLength(1);
  expect(await ofType(again, "workflow.registered")).toHaveLength(1);
  expect(await ofType(again, "workflow.subscription.installed")).toHaveLength(1);
  await stop(again);

  // A new build ships another script: a new version of the same workflow, installed in place of the old one.
  script(file, "v2");
  const changed = await served(home.path, file);
  await eventually(async () => (await ofType(changed, "workflow.subscription.installed")).length === 2, 20_000, "the new version was not installed");
  await settled(changed, 1);
  const [newWf] = (await changed.call(workflowList, {})).items;
  expect(newWf?.id).toBe(wf?.id);
  expect(newWf?.versions).toBe(2);
  expect(newWf?.version).not.toBe(wf?.version);
  const [newSub] = (await changed.call(workflowInstallationList, {})).items;
  expect(newSub?.id).not.toBe(sub?.id);
  expect(newSub?.builtin).toEqual({ plugin: "shipper", name: "answer" });
  await changed.emit(Go, { n: 1 });
  await eventually(async () => (await results(changed)).length === 1, 20_000, "the new version did not run");
  expect(await results(changed)).toEqual(["v2"]);
  await stop(changed);

  // The plugin offers it no more: it is uninstalled, and its registration stays with its runs.
  const removed = await served(home.path, undefined);
  await settled(removed, 0);
  expect((await removed.call(workflowList, {})).items.map((one) => String(one.id))).toEqual([String(wf?.id)]);
  const ends = await ofType(removed, "workflow.subscription.uninstalled");
  expect(ends.at(-1)?.data).toMatchObject({ installation: newSub?.id, reason: "its plugin no longer offers it" });
}, 90_000);

test("a file is not registered under a built-in, and a built-in is not uninstalled by hand", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join((await tempDir("builtin")), "answer.ts");
  script(file, "v1");
  const host = await served(home.path, file);
  await settled(host, 1);
  const [wf] = (await host.call(workflowList, {})).items;
  const [sub] = (await host.call(workflowInstallationList, {})).items;

  const other = join((await tempDir("mine")), "mine.ts");
  writeFileSync(other, `export default workflow({ description: "Mine, not the plugin's", output: z.string() }, async () => "mine");\n`);
  await expect(host.call(workflowRegister, { file: other, id: wf?.id ?? "" })).rejects.toThrow(/built-in "answer" of the plugin "shipper"/);
  await expect(host.call(workflowUninstall, { id: sub?.id ?? "" })).rejects.toThrow(/Turn it off with the option of the plugin/);
  // The same file as a workflow of its own is the owner's.
  const own = await host.call(workflowRegister, { file: other });
  expect(own.id).not.toBe(wf?.id);
  expect((await host.call(workflowGet, { id: own.id })).builtin).toBeUndefined();
}, 60_000);

test("the sync is the workflow module's own: a caller cannot install a built-in", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = await served(home.path, undefined);
  await expect(
    host.call("workflow.builtin.sync" as never, { plugin: "shipper", name: "forged", file: "/nowhere.ts", description: "Forged", version: "0".repeat(64) } as never),
  ).rejects.toThrow(/only the workflow module/);
}, 30_000);

test("a plugin installed after the workflow module that offers a built-in is refused: it would never be installed", () => {
  const host = createNiwa({ home: "/tmp/never-served" });
  host.use(workflow());
  expect(() => host.use(shipper("/nowhere.ts"))).toThrow(/install "shipper" before "workflow"/);
});

test("a built-in offered on a host without the workflow module refuses to serve", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(shipper("/nowhere.ts"));
  await expect(host.serve()).rejects.toMatchObject({ code: "MissingReader", plugin: "shipper", point: "workflow.builtin", reader: "workflow" });
  await host.close();
}, 30_000);

test("a plugin offers the timers it needs; the timers schedule them beside the listed ones, in any order", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(
    timers([timer.daily("21:00", { id: "listed" })]),
    plugin("needs-a-timer", (api) => api.offer(TIMER_OFFER, timer.every(60_000, { id: "offered", description: "Offered by a plugin" }))),
  );
  await host.serve();
  hosts.push(host);
  const listed = (await host.call(timerList, {})).timers.map((one) => [String(one.name), String(one.description)]);
  expect(listed).toEqual([
    ["listed", "daily 21:00"],
    ["offered", "Offered by a plugin"],
  ]);
}, 30_000);
