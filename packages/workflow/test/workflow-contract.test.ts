// The typed contract of a script: `workflow({ input, output, ... }, fn)`. The schemas are read by
// loading the module (check, install), held at the start (input) and at the end (output) of a run, kept
// as a hash with the run, and checked by the type checker against the function.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, requests, eventually, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { InputInvalid, workflow, workflowCancel, workflowCheck, workflowInstall, workflowInstallationGet, workflowInstallationList, workflowResume, workflowStart, workflowWait } from "../src/index.ts";
import { z } from "zod";
import type { RunStatus } from "../src/status.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const Ping = record("ping.sent", z.object({ id: z.string(), size: z.number() }));

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

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const recordsOf = async (host: Host): Promise<StoredRecord[]> => host.records.read();

/** The status of a run once it is paused with a reason that says this. */
async function untilPaused(host: Host, run: string, reason: string): Promise<RunStatus> {
  let seen: RunStatus | undefined;
  await eventually(async () => {
    seen = await host.call(workflowWait, { run, timeoutMs: 300 });
    return seen.state === "paused" && seen.reason?.includes(reason) === true;
  }, 30_000, `the run should pause with "${reason}"`);
  if (seen === undefined) throw new Error("no status");
  return seen;
}

const Repo = [
  "export default workflow({",
  '  description: "Count the findings of a repository",',
  "  input: z.object({ repo: z.string(), depth: z.number().int().default(2) }),",
  "  output: z.object({ repo: z.string(), findings: z.array(z.string()) }),",
  "}, async ({ repo, depth }) => {",
  "  return { repo, findings: Array.from({ length: depth }, (_, at) => `finding ${at}`) };",
  "});",
];

test("check shows the description, the schemas as JSON Schema and a contract hash; install keeps them for the installation", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "repo.ts", Repo);
  const report = await host.call(workflowCheck, { file });
  expect(report).toMatchObject({ ok: true, errors: [], note: "described, the script was not run", description: "Count the findings of a repository" });
  expect(report.input).toMatchObject({ type: "object", properties: { repo: { type: "string" }, depth: { type: "integer", default: 2 } }, required: ["repo"] });
  expect(report.output).toMatchObject({ type: "object", required: ["repo", "findings"] });
  expect(report.contract).toMatch(/^[0-9a-f]{64}$/);

  const on = await scriptIn(home, "on.ts", [
    "export default workflow({",
    '  description: "Look at a ping",',
    '  on: [{ type: "ping.sent", filter: { id: "a" } }],',
    "  output: z.string(),",
    "}, async (trigger) => {",
    "  return trigger.data.id;",
    "});",
  ]);
  const { id } = await host.call(workflowInstall, { file: on, description: "pinged" });
  const { items } = await host.call(workflowInstallationList, {});
  expect(items).toEqual([expect.objectContaining({ id, description: "pinged" })]);
  const installed = await host.call(workflowInstallationGet, { id });
  expect(installed).toMatchObject({ id, description: "pinged", output: { type: "string" } });
  expect(installed.input).toBeUndefined();
  expect(installed.contract).toMatch(/^[0-9a-f]{64}$/);
}, 60_000);

test("the module is loaded for its schemas, so imports at the top work and the function does not run", async () => {
  const { host, home } = await served();
  const marker = join(home, "ran");
  await writeFile(join(home, "shapes.ts"), "export const Shape = z.object({ size: z.number() });\n");
  const file = await scriptIn(home, "imports.ts", [
    'import { Shape } from "./shapes.ts";',
    `console.log("a line the module writes at its top level");`,
    "export default workflow({ input: Shape, output: Shape }, async ({ size }) => {",
    `  await Bun.write(${JSON.stringify(marker)}, "ran");`,
    "  return { size };",
    "});",
  ]);
  const report = await host.call(workflowCheck, { file });
  expect(report).toMatchObject({ ok: true, input: { type: "object", properties: { size: { type: "number" } } } });
  expect(await Bun.file(marker).exists()).toBe(false);
}, 60_000);

test("a schema that JSON Schema cannot say, an input that is not an object, and a call of niwa at the top are errors of the check", async () => {
  const { host, home } = await served();
  const bad = await scriptIn(home, "bad.js", [
    "export default workflow({",
    "  input: z.object({ when: z.date() }),",
    "  output: z.object({ anything: z.unknown() }),",
    "}, async () => ({ anything: 1 }));",
  ]);
  const report = await host.call(workflowCheck, { file: bad });
  expect(report.ok).toBe(false);
  expect(report.errors.map((error) => [error.code, error.line])).toEqual([["schema", 2], ["schema", 3]]);
  expect(report.errors[0]?.message).toContain("Date cannot be represented");
  expect(report.errors[1]?.message).toContain("says nothing");

  const text = await scriptIn(home, "text.js", ["export default workflow({ input: z.string() }, async () => {});"]);
  expect((await host.call(workflowCheck, { file: text })).errors[0]).toMatchObject({ code: "schema", message: expect.stringContaining("z.object") });

  const top = await scriptIn(home, "top.js", ["await niwa.task.create({});", "export default workflow({}, async () => {});"]);
  expect((await host.call(workflowCheck, { file: top })).errors[0]).toMatchObject({ code: "describe", message: expect.stringContaining("not available while the module is read") });

  const legacy = await scriptIn(home, "legacy.js", ["export default async function () {}"]);
  expect((await host.call(workflowCheck, { file: legacy })).errors[0]).toMatchObject({ code: "workflow" });

  const both = await scriptIn(home, "both.js", ['export default workflow({ input: z.object({}), on: ["ping.sent"] }, async () => {});']);
  expect((await host.call(workflowCheck, { file: both })).errors[0]).toMatchObject({ code: "workflow", message: expect.stringContaining("not both") });
}, 60_000);

test("a start whose arguments do not pass the input is refused with the fields, and no run exists", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "repo.ts", Repo);
  const refused = await host.call(workflowStart, { file, args: { repo: 7, depth: "deep" } }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain("input of the script");
  expect((refused as Error).message).toContain("repo");
  expect((refused as Error).message).toContain("depth");
  expect(ofType(await recordsOf(host), "workflow.run.requested")).toHaveLength(0);

  const nothing = await host.call(workflowStart, { file }).catch((error: unknown) => error);
  expect((nothing as Error).message).toContain("repo");

  const bare = await scriptIn(home, "bare.ts", ["export default workflow({ output: z.number() }, async () => 1);"]);
  const stray = await host.call(workflowStart, { file: bare, args: { x: 1 } }).catch((error: unknown) => error);
  expect((stray as Error).message).toContain("takes no input");
  expect(ofType(await recordsOf(host), "workflow.run.requested")).toHaveLength(0);
  expect(new InputInvalid([{ path: "a", message: "m" }]).code).toBe("input-invalid");

  // Good arguments run, the defaults go in, and the result is the outcome of the run.
  const started = await host.call(workflowStart, { file, args: { repo: "niwa" }, wait: true, timeoutMs: 20_000 });
  expect(started).toMatchObject({ state: "finished", outcome: { status: "done", result: { repo: "niwa", findings: ["finding 0", "finding 1"] } } });
}, 60_000);

test("a result that does not pass the output ends the run as failed with the fields; a result with no output declared is refused too", async () => {
  const { host, home } = await served();
  const wrong = await scriptIn(home, "wrong.js", [
    "export default workflow({ output: z.object({ count: z.number(), tags: z.array(z.string()) }) }, async () => ({ count: 'many', tags: [1] }));",
  ]);
  const failed = await host.call(workflowStart, { file: wrong, wait: true, timeoutMs: 20_000 });
  expect(failed.state).toBe("finished");
  expect(failed.outcome).toMatchObject({ status: "failed", error: { code: "output-invalid", issues: expect.arrayContaining([expect.objectContaining({ path: "count" }), expect.objectContaining({ path: "tags.0" })]) } });
  expect(await host.call(workflowWait, { run: failed.run })).toMatchObject({ state: "finished", outcome: { status: "failed" } });
  expect(ofType(await recordsOf(host), "workflow.run.finished")).toHaveLength(1);

  const silent = await scriptIn(home, "silent.js", ["export default workflow({}, async () => 5);"]);
  const stray = await host.call(workflowStart, { file: silent, wait: true, timeoutMs: 20_000 });
  expect(stray.outcome).toMatchObject({ status: "failed", error: { code: "output-invalid", message: expect.stringContaining("declares no output") } });
}, 60_000);

test("the outcome of a run is done, failed or cancelled", async () => {
  const { host, home } = await served();
  const done = await scriptIn(home, "done.js", ["export default workflow({ output: z.string() }, async () => 'ok');"]);
  const nothing = await scriptIn(home, "nothing.js", ["export default workflow({}, async () => {});"]);
  const sleeper = await scriptIn(home, "sleeper.js", ["export default workflow({}, async () => { await sleep('1h'); });"]);
  expect(await host.call(workflowStart, { file: done, wait: true, timeoutMs: 20_000 })).toMatchObject({ outcome: { status: "done", result: "ok" } });
  expect(await host.call(workflowStart, { file: nothing, wait: true, timeoutMs: 20_000 })).toMatchObject({ outcome: { status: "done", result: null } });
  const { run: sleeping } = await host.call(workflowStart, { file: sleeper });
  await eventually(async () => ofType(await recordsOf(host), "workflow.run.started").length === 3, 20_000);
  await host.call(workflowCancel, { run: sleeping });
  expect(await host.call(workflowWait, { run: sleeping })).toMatchObject({ state: "finished", outcome: { status: "cancelled" } });
  expect(ofType(await recordsOf(host), "workflow.run.finished").map((row) => (row.data as { outcome: { status: string } }).outcome.status).sort()).toEqual(["cancelled", "done", "done"]);
}, 30_000);

test("a changed contract stops a run whose recorded arguments no longer pass it, and lets one whose arguments still pass go on", async () => {
  const { host, home } = await served();
  const body = (shape: string): string[] => [
    `export default workflow({ input: z.object(${shape}), output: z.number() }, async () => {`,
    '  throw new Error("first start fails");',
    "});",
  ];
  const stops = await scriptIn(home, "stops.js", body("{ repo: z.string() }"));
  const { run: stopping } = await host.call(workflowStart, { file: stops, args: { repo: "niwa" } });
  expect((await host.call(workflowWait, { run: stopping, timeoutMs: 20_000 })).state).toBe("paused");
  const before = (ofType(await recordsOf(host), "workflow.run.started")[0]?.data as { contract: string }).contract;

  await writeFile(stops, body("{ repo: z.string(), branch: z.string() }").join("\n"));
  await host.call(workflowResume, { run: stopping });
  const status = await untilPaused(host, stopping, "contract-changed");
  expect(status).toMatchObject({ state: "paused", choices: ["cancel"] });
  expect(status.reason).toContain("branch");
  // The run keeps the contract it began under: a resume meets the same change.
  const starts = ofType(await recordsOf(host), "workflow.run.started");
  expect((starts.at(-1)?.data as { contract: string }).contract).toBe(before);

  const goes = await scriptIn(home, "goes.js", body("{ repo: z.string() }"));
  const { run: going } = await host.call(workflowStart, { file: goes, args: { repo: "niwa" } });
  expect((await host.call(workflowWait, { run: going, timeoutMs: 20_000 })).state).toBe("paused");
  // A field with a default: the recorded arguments still pass, so the run goes on under the new contract.
  await writeFile(goes, ["export default workflow({ input: z.object({ repo: z.string(), branch: z.string().default('main') }), output: z.number() }, async () => 7);"].join("\n"));
  await host.call(workflowResume, { run: going });
  await eventually(async () => (await host.call(workflowWait, { run: going, timeoutMs: 300 })).state === "finished", 20_000);
  const after = await host.call(workflowWait, { run: going });
  expect(after.outcome).toMatchObject({ status: "done", result: 7 });
  const goesStarts = ofType(await recordsOf(host), "workflow.run.started").filter((row) => (row.data as { run: string }).run === going);
  expect(new Set(goesStarts.map((row) => (row.data as { contract: string }).contract)).size).toBe(2);
}, 60_000);

test("a schema that the script imports changes the contract without changing the file of the script", async () => {
  const { host, home } = await served();
  const shape = (extra: string): string => `export const Input = z.object({ repo: z.string()${extra} });\n`;
  await writeFile(join(home, "input.ts"), shape(""));
  const file = await scriptIn(home, "imported.js", [
    'import { Input } from "./input.ts";',
    "export default workflow({ input: Input }, async () => { throw new Error('stop'); });",
  ]);
  const { run: imported } = await host.call(workflowStart, { file, args: { repo: "niwa" } });
  expect((await host.call(workflowWait, { run: imported, timeoutMs: 20_000 })).state).toBe("paused");
  await writeFile(join(home, "input.ts"), shape(", branch: z.string()"));
  await host.call(workflowResume, { run: imported });
  expect(await untilPaused(host, imported, "contract-changed")).toMatchObject({ state: "paused", choices: ["cancel"] });
}, 60_000);

test("the typing rejects a wrong field of the input, a wrong result, a result with no output, and an argument for a script with none", async () => {
  const { host, home } = await served();
  const rejected = async (name: string, lines: string[]): Promise<{ line: number; code: string }[]> => {
    const file = await scriptIn(home, name, lines);
    const report = await host.call(workflowCheck, { file });
    expect(report.ok).toBe(false);
    return report.errors.map((error) => ({ line: error.line, code: error.code }));
  };
  const ok = await scriptIn(home, "ok.ts", Repo);
  expect((await host.call(workflowCheck, { file: ok })).ok).toBe(true);

  expect(await rejected("input.ts", [
    "export default workflow({ input: z.object({ repo: z.string() }), output: z.number() }, async ({ repository }) => {",
    "  return 1;",
    "});",
  ])).toEqual([{ line: 1, code: "TS2339" }]);

  expect(await rejected("output.ts", [
    "export default workflow({ output: z.object({ count: z.number() }) }, async () => {",
    '  return { count: "many" };',
    "});",
  ])).toEqual([{ line: 1, code: "TS2345" }]);

  expect(await rejected("none.ts", [
    "export default workflow({}, async () => {",
    "  return 1;",
    "});",
  ])).toEqual([{ line: 1, code: "TS2345" }]);

  expect(await rejected("noinput.ts", [
    "export default workflow({ output: z.number() }, async (input) => {",
    "  return 1;",
    "});",
  ])).toEqual([{ line: 1, code: "TS2345" }]);

  expect(await rejected("trigger.ts", [
    'export default workflow({ on: [{ type: "ping.sent" }], output: z.number() }, async (trigger) => {',
    "  return trigger.data.nothing;",
    "});",
  ])).toEqual([{ line: 2, code: "TS2339" }]);
}, 60_000);

test("the filter of a subscription is held to the schema of its type: an unknown path and a literal the field cannot hold are errors", async () => {
  const { host, home } = await served();
  const on = (filter: string): string[] => [`export default workflow({ on: [{ type: "ping.sent", filter: ${filter} }] }, async () => {});`];
  const typo = await scriptIn(home, "typo.ts", on('{ idd: "a" }'));
  expect((await host.call(workflowCheck, { file: typo })).errors).toMatchObject([{ code: "on", message: expect.stringContaining('names "idd"') }]);
  const kind = await scriptIn(home, "kind.ts", on("{ size: 'big' }"));
  expect((await host.call(workflowCheck, { file: kind })).errors).toMatchObject([{ code: "on", message: expect.stringContaining("cannot hold") }]);
  const fine = await scriptIn(home, "fine.ts", on('{ id: "a", size: 3 }'));
  expect((await host.call(workflowCheck, { file: fine })).ok).toBe(true);
  await expect(host.call(workflowInstall, { file: typo, description: "typo" })).rejects.toThrow("does not pass its check");
}, 60_000);
