// Registered workflows: `workflow.register` issues `wf-…` and adds versions (the hash of the source closure),
// `workflow.list` / `workflow.get` find them again, a start by id answers `run-…`, every registered workflow is
// the action `flow.<id>`, and a change of contract marks the workflows that call it broken.

import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { StoredRecord } from "@niwa-labs/core";
import { inputOf } from "@niwa-labs/cli";
import { requests } from "@niwa-labs/requests";
import { eventually, tempHome } from "@niwa-labs/testing";
import { timers } from "@niwa-labs/timer";
import {
  RunRequested,
  workflow,
  workflowGet,
  workflowInstall,
  workflowList,
  workflowRegister,
  workflowStart,
  workflowUninstall,
  workflowWait,
} from "@niwa-labs/workflow";
import { z } from "zod";

import { catalogOf } from "@niwa-labs/mcp";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const Ping = record("ping.sent", z.object({ id: z.string() }));

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("ping", (api) => api.declare(Ping)), workflow({ triggers: [Ping] }));
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, lines.join("\n"));
  return file;
}

const recordsOf = async (host: Host, type: string): Promise<StoredRecord[]> =>
  (await host.records.read(seq(0))).filter((row) => row.type === type);

const Double = (output: string, body: string): string[] => [
  'import { factor } from "./factor.ts";',
  "export default workflow({",
  '  description: "Double a number",',
  "  input: z.object({ n: z.number() }),",
  `  output: ${output},`,
  "}, async ({ n }) => {",
  `  ${body}`,
  "});",
];

test("register issues wf-…, a new version under the id, the same version again changes nothing, and list and get find it", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "factor.ts"), "export const factor = 2;\n");
  const file = await scriptIn(home, "double.ts", Double("z.object({ n: z.number() })", "return { n: n * factor };"));

  const first = await host.call(workflowRegister, { file });
  expect(first).toMatchObject({ description: "Double a number", added: true, rechecked: [] });
  expect(first.id).toMatch(/^wf-[0-9a-z]{6,8}$/);
  expect(first.version).toMatch(/^[0-9a-f]{64}$/);

  expect(await host.call(workflowRegister, { file, id: first.id })).toMatchObject({ id: first.id, version: first.version, added: false });

  // An edit of a local file the script imports is a new version of the same workflow.
  await writeFile(join(home, "factor.ts"), "export const factor = 3;\n");
  const second = await host.call(workflowRegister, { file, id: first.id });
  expect(second).toMatchObject({ id: first.id, added: true });
  expect(second.version).not.toBe(first.version);

  // Without an id the same script is another workflow.
  const other = await host.call(workflowRegister, { file });
  expect(other.id).not.toBe(first.id);

  const { items } = await host.call(workflowList, {});
  expect(items).toEqual([
    expect.objectContaining({ id: first.id, description: "Double a number", version: second.version, versions: 2, broken: false, installations: [] }),
    expect.objectContaining({ id: other.id, versions: 1 }),
  ]);
  const got = await host.call(workflowGet, { id: first.id.slice(-4) });
  expect(got.id).toBe(first.id);
  expect(got.versions.map((one) => one.version)).toEqual([first.version, second.version]);
  expect(got.versions[1]).toMatchObject({ input: { type: "object", required: ["n"] }, output: { type: "object" } });
}, 60_000);

test("a workflow is registered with a description: a script that says none is refused", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "bare.ts", ["export default workflow({ output: z.number() }, async () => 1);"]);
  await expect(host.call(workflowRegister, { file })).rejects.toThrow(/description/);
}, 60_000);

test("a start by id runs the latest version and answers run-…; the start records the workflow and version", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "factor.ts"), "export const factor = 2;\n");
  const file = await scriptIn(home, "double.ts", Double("z.object({ n: z.number() })", "return { n: n * factor };"));
  const { id, version } = await host.call(workflowRegister, { file });

  const started = await host.call(workflowStart, { id, args: { n: 4 }, wait: true, timeoutMs: 20_000 });
  expect(started.run).toMatch(/^run-[0-9a-z]{6,8}$/);
  expect(started.outcome).toEqual({ status: "done", result: { n: 8 } });
  const requested = RunRequested.schema.parse((await recordsOf(host, RunRequested.name)).at(-1)?.data);
  expect(requested).toMatchObject({ run: started.run, workflow: id, version });

  await expect(host.call(workflowStart, { id, file })).rejects.toThrow(/one of the two/);
  await expect(host.call(workflowStart, {})).rejects.toThrow(/one of the two/);
  // The file is edited after its registration: the registered version runs on, from the copy niwa keeps.
  await writeFile(join(home, "factor.ts"), "export const factor = 5;\n");
  expect((await host.call(workflowStart, { id, args: { n: 1 }, wait: true, timeoutMs: 20_000 })).outcome).toEqual({ status: "done", result: { n: 2 } });
}, 60_000);

test("a registered workflow is the action flow.<id>: described with its schemas, called by a client and by another script", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "factor.ts"), "export const factor = 2;\n");
  const file = await scriptIn(home, "double.ts", Double("z.object({ n: z.number() })", "return { n: n * factor };"));
  const { id } = await host.call(workflowRegister, { file });
  const flow = actionName(`flow.${id}`);

  const described = (await host.describe()).actions.find((one) => one.name === flow);
  expect(described).toMatchObject({ input: { type: "object", required: ["n"] }, output: { type: "object" } });
  expect(described?.description).toContain("Double a number");
  if (described === undefined) throw new Error("flow is not described");
  // The command line reads its flags from the schema, and MCP lists it as a tool with the same input.
  expect(inputOf(described, ["--n", "3"])).toEqual({ n: 3 });
  const tool = catalogOf(await host.describe()).tools.find((one) => one.name === `flow_${id.replace("-", "_")}`);
  expect(tool?.inputSchema).toMatchObject({ type: "object", required: ["n"] });

  expect(await host.call(flow, { n: 5 })).toEqual({ n: 10 });
  await expect(host.call(flow, { n: "five" })).rejects.toThrow();

  const caller = await scriptIn(home, "caller.ts", [
    "export default workflow({",
    '  description: "Double twice",',
    "  input: z.object({ n: z.number() }),",
    "  output: z.number(),",
    `  uses: ["flow.${id}"],`,
    "}, async ({ n }) => {",
    `  const once = await niwa.flow[${JSON.stringify(id)}]({ n });`,
    `  const twice = await niwa.flow[${JSON.stringify(id)}]({ n: once.n });`,
    "  return twice.n;",
    "});",
  ]);
  const registered = await host.call(workflowRegister, { file: caller });
  const run = await host.call(workflowStart, { id: registered.id, args: { n: 3 }, wait: true, timeoutMs: 30_000 });
  expect(run.outcome).toEqual({ status: "done", result: 12 });
}, 90_000);

test("a change of contract checks the callers again: a caller that no longer passes is broken and does not start, and a fix mends it", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "factor.ts"), "export const factor = 2;\n");
  const file = await scriptIn(home, "double.ts", Double("z.object({ n: z.number() })", "return { n: n * factor };"));
  const callee = await host.call(workflowRegister, { file });
  const caller = await scriptIn(home, "caller.ts", [
    "export default workflow({",
    '  description: "Double once",',
    "  input: z.object({ n: z.number() }),",
    "  output: z.number(),",
    `  uses: ["flow.${callee.id}"],`,
    "}, async ({ n }) => {",
    `  return (await niwa.flow[${JSON.stringify(callee.id)}]({ n })).n;`,
    "});",
  ]);
  const dependent = await host.call(workflowRegister, { file: caller });
  // The caller is checked again from the copy niwa keeps: its file may be gone.
  await rm(caller);

  // The output loses the field the caller reads: the callee registers, the caller is marked broken.
  await writeFile(file, Double("z.object({ value: z.number() })", "return { value: n * factor };").join("\n"));
  const changed = await host.call(workflowRegister, { file, id: callee.id });
  expect(changed.rechecked).toEqual([{ id: dependent.id, version: dependent.version, ok: false }]);
  expect((await host.call(workflowList, {})).items.find((one) => one.id === dependent.id)).toMatchObject({ broken: true });
  expect((await host.call(workflowGet, { id: dependent.id })).versions.at(-1)?.broken).toContain("TS");
  await expect(host.call(workflowStart, { id: dependent.id, args: { n: 1 } })).rejects.toThrow(/broken/);

  // The callee goes back to the contract the caller reads: the check passes again, and the caller starts.
  await writeFile(file, Double("z.object({ n: z.number() })", "return { n: n * factor * 10 };").join("\n"));
  const mended = await host.call(workflowRegister, { file, id: callee.id });
  expect(mended.rechecked).toEqual([{ id: dependent.id, version: dependent.version, ok: true }]);
  const run = await host.call(workflowStart, { id: dependent.id, args: { n: 1 }, wait: true, timeoutMs: 30_000 });
  expect(run.outcome).toEqual({ status: "done", result: 20 });
}, 120_000);

const Sweep = (pr: string): string[] => [
  `const Blocked = record("blocked", z.object({ pr: ${pr} }));`,
  'export default workflow({ name: "sweep", description: "Sweep the pull requests", emits: [Blocked], output: z.number() }, async () => 1);',
];

test("a change in the records a workflow writes checks the scripts that wait for or read them again, and breaks the ones that no longer pass", async () => {
  const { host, home } = await served();
  const sweep = await scriptIn(home, "sweep.ts", Sweep("z.number()"));
  const writer = await host.call(workflowRegister, { file: sweep });
  const waiter = await scriptIn(home, "waiter.ts", [
    'export default workflow({ description: "Wait for a block", output: z.number() }, async () => {',
    '  const blocked = await wait("wf.sweep.blocked");',
    '  return "timedOut" in blocked ? 0 : blocked.pr;',
    "});",
  ]);
  const reader = await scriptIn(home, "reader.ts", [
    'export default workflow({ description: "Read the blocks", uses: ["niwa.records.read"], output: z.number() }, async () => {',
    '  const found = await read.records({ types: ["wf.sweep.blocked"] });',
    "  return found.length;",
    "});",
  ]);
  const unrelated = await scriptIn(home, "unrelated.ts", [
    'export default workflow({ description: "Wait for a ping", output: z.number() }, async () => {',
    '  await wait("ping.sent");',
    "  return 1;",
    "});",
  ]);
  const waiting = await host.call(workflowRegister, { file: waiter });
  const reading = await host.call(workflowRegister, { file: reader });
  const other = await host.call(workflowRegister, { file: unrelated });

  // The same records again: nothing is checked.
  expect((await host.call(workflowRegister, { file: sweep, id: writer.id })).rechecked).toEqual([]);

  // The data of the record loses its number: the waiter reads `pr` as a number and is broken, the reader and the one that
  // waits for something else pass; none of the three is the workflow that changed.
  await writeFile(sweep, Sweep('z.string()').join("\n"));
  const changed = await host.call(workflowRegister, { file: sweep, id: writer.id });
  expect(changed.rechecked).toEqual(
    expect.arrayContaining([
      { id: waiting.id, version: waiting.version, ok: false },
      { id: reading.id, version: reading.version, ok: true },
    ]),
  );
  expect(changed.rechecked).toHaveLength(2);
  expect(changed.rechecked.map((one) => one.id)).not.toContain(other.id);
  expect((await host.call(workflowList, {})).items.find((one) => one.id === waiting.id)).toMatchObject({ broken: true });
  expect((await host.call(workflowList, {})).items.find((one) => one.id === reading.id)).toMatchObject({ broken: false });
  await expect(host.call(workflowStart, { id: waiting.id })).rejects.toThrow(/broken/);

  // The record goes back to the shape the waiter reads: it starts again.
  await writeFile(sweep, Sweep("z.number()").join("\n"));
  const mended = await host.call(workflowRegister, { file: sweep, id: writer.id });
  expect(mended.rechecked).toContainEqual({ id: waiting.id, version: waiting.version, ok: true });
  expect((await host.call(workflowList, {})).items.find((one) => one.id === waiting.id)).toMatchObject({ broken: false });
}, 180_000);

test("a workflow registered after the script that waits for its records checks that script too", async () => {
  const { host, home } = await served();
  const waiter = await scriptIn(home, "waiter.ts", [
    'export default workflow({ description: "Wait for a block", output: z.number() }, async () => {',
    '  await wait("wf.sweep.blocked", { filter: { pr: "seven" } });',
    "  return 1;",
    "});",
  ]);
  const waiting = await host.call(workflowRegister, { file: waiter });
  // Its records had no schema, so any filter held: now they have one, and the filter of the waiter cannot match.
  const sweep = await scriptIn(home, "sweep.ts", Sweep("z.number()"));
  const registered = await host.call(workflowRegister, { file: sweep });
  expect(registered.rechecked).toEqual([{ id: waiting.id, version: waiting.version, ok: false }]);
}, 120_000);

test("a second workflow cannot take the name another registered one has, and a new version of the first may keep it", async () => {
  const { host, home } = await served();
  const first = await host.call(workflowRegister, { file: await scriptIn(home, "sweep.ts", Sweep("z.number()")) });
  const again = await scriptIn(home, "sweep-again.ts", Sweep("z.string()"));
  await expect(host.call(workflowRegister, { file: again })).rejects.toThrow(new RegExp(`"sweep".*${first.id}`));
  expect((await host.call(workflowList, {})).items).toHaveLength(1);

  // The first one is a workflow under its id: a new version of it keeps its name.
  const next = await host.call(workflowRegister, { file: again, id: first.id });
  expect(next.added).toBe(true);
  expect((await host.call(workflowList, {})).items).toHaveLength(1);
}, 120_000);

test("an installation issues sub-…, its runs name it at their start, and uninstall takes the id", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "on.ts", [
    "export default workflow({",
    '  description: "Look at a ping",',
    '  on: ["ping.sent"],',
    "  output: z.string(),",
    "}, async (trigger) => trigger.data.id);",
  ]);
  const { id } = await host.call(workflowRegister, { file });
  // The version says what starts it, so a reader knows it is installed and not started by hand.
  expect((await host.call(workflowGet, { id })).versions.at(-1)?.on).toEqual([{ type: "ping.sent" }]);
  const installed = await host.call(workflowInstall, { id, description: "pings seen" });
  expect(installed.id).toMatch(/^sub-[0-9a-z]{6,8}$/);
  expect(installed.profile).toBe(`wf:${installed.id}`);

  await host.emit(Ping, { id: "a" });
  let run = "";
  await eventually(async () => {
    const started = (await recordsOf(host, RunRequested.name)).map((row) => RunRequested.schema.parse(row.data));
    run = started.find((one) => one.installation === installed.id)?.run ?? "";
    return run !== "";
  }, 20_000);
  expect(run).toMatch(/^run-/);
  const status = await host.call(workflowWait, { run, timeoutMs: 20_000 });
  expect(status.outcome).toEqual({ status: "done", result: "a" });
  expect((await host.call(workflowGet, { id })).installations).toEqual([installed.id]);

  expect(await host.call(workflowUninstall, { id: installed.id })).toEqual({ id: installed.id });
  expect((await host.call(workflowGet, { id })).installations).toEqual([]);
}, 60_000);

test("an installation by id pins the whole version: it runs the stored copy, an edited helper changes nothing", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "helper.ts"), 'export const label = "one";\n');
  const file = await scriptIn(home, "on.ts", [
    'import { label } from "./helper.ts";',
    "export default workflow({",
    '  description: "Label a ping",',
    '  on: ["ping.sent"],',
    "  output: z.string(),",
    "}, async (trigger) => `${label}:${trigger.data.id}`);",
  ]);
  const { id } = await host.call(workflowRegister, { file });
  const installed = await host.call(workflowInstall, { id, description: "labelled pings" });

  // The installation runs the copy of the version niwa keeps: an edit of the file it was registered from is not it.
  await writeFile(join(home, "helper.ts"), 'export const label = "two";\n');
  await host.emit(Ping, { id: "a" });
  let run = "";
  await eventually(async () => {
    run = (await recordsOf(host, RunRequested.name)).map((row) => RunRequested.schema.parse(row.data)).find((one) => one.installation === installed.id)?.run ?? "";
    return run !== "";
  }, 20_000);
  expect((await host.call(workflowWait, { run, timeoutMs: 20_000 })).outcome).toEqual({ status: "done", result: "one:a" });
}, 90_000);

test("a broken workflow keeps its installation, starts no run from it, and runs again once a check passes", async () => {
  const { host, home } = await served();
  await writeFile(join(home, "factor.ts"), "export const factor = 2;\n");
  const file = await scriptIn(home, "double.ts", Double("z.object({ n: z.number() })", "return { n: n * factor };"));
  const callee = await host.call(workflowRegister, { file });
  const watcher = await scriptIn(home, "watcher.ts", [
    "export default workflow({",
    '  description: "Double on a ping",',
    '  on: ["ping.sent"],',
    "  output: z.number(),",
    `  uses: ["flow.${callee.id}"],`,
    "}, async () => {",
    `  return (await niwa.flow[${JSON.stringify(callee.id)}]({ n: 4 })).n;`,
    "});",
  ]);
  const registered = await host.call(workflowRegister, { file: watcher });
  const installed = await host.call(workflowInstall, { id: registered.id, description: "doubling pings" });
  const startedFor = async (): Promise<string[]> =>
    (await recordsOf(host, RunRequested.name)).flatMap((row) => {
      const data = RunRequested.schema.parse(row.data);
      return data.installation === installed.id ? [data.run] : [];
    });

  await writeFile(file, Double("z.object({ value: z.number() })", "return { value: n * factor };").join("\n"));
  expect((await host.call(workflowRegister, { file, id: callee.id })).rechecked).toEqual([{ id: registered.id, version: registered.version, ok: false }]);
  expect((await host.call(workflowGet, { id: registered.id })).installations).toEqual([installed.id]);

  // The ping is committed and handled, and no run was born from the installation of the broken workflow.
  await host.emit(Ping, { id: "while-broken" });
  await eventually(async () => {
    const rows = await host.records.read(seq(0));
    const admitted = rows.filter((row) => row.type === "niwa.invocation.admitted" && String((row.data as { handler: string }).handler).endsWith(`workflow.on:${installed.id}`));
    const done = new Set(rows.filter((row) => row.type === "niwa.invocation.state" && (row.data as { state: string }).state === "done").map((row) => (row.data as { invocation: string }).invocation));
    return admitted.length === 1 && admitted.every((row) => done.has((row.data as { invocation: string }).invocation));
  }, 20_000);
  expect(await startedFor()).toEqual([]);

  await writeFile(file, Double("z.object({ n: z.number() })", "return { n: n * factor };").join("\n"));
  expect((await host.call(workflowRegister, { file, id: callee.id })).rechecked).toEqual([{ id: registered.id, version: registered.version, ok: true }]);
  await host.emit(Ping, { id: "mended" });
  let run: string | undefined;
  await eventually(async () => {
    run = (await startedFor())[0];
    return run !== undefined;
  }, 30_000);
  const status = await host.call(workflowWait, { run: run ?? "", timeoutMs: 30_000 });
  expect(status.outcome).toEqual({ status: "done", result: 8 });
}, 120_000);
