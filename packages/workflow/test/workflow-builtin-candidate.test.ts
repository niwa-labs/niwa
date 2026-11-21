// A built-in offered with `gated: true` comes in as a candidate: the sync registers each new version of it as one,
// and neither the latest version nor the installation moves to it. Before any version was accepted the candidate is
// shown and starts on nothing. A host that starts again with the same file counts the candidate as in place. A suite
// the same plugin ships starts the candidate by its version and promotes it: then it is latest and installed.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { record } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempDir, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { BuiltinsWanted, workflow, workflowBuiltinPromote, workflowGet, workflowInstallationList, workflowList, workflowStart, workflowWait } from "../src/index.ts";
import { z } from "zod";

import { versionOf } from "../src/registry.ts";

const Go = record("gated.go", z.object({ n: z.number() }));
const Release = record("gated.release", z.object({ n: z.number() }));

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A plugin that ships the gated built-in `entry`, and the suite that tries it and promotes it. */
const shipper = (file: string, suite?: string, router?: string) =>
  plugin("gated", (api) => {
    api.declare(Go, Release);
    api.offer(BUILTIN_WORKFLOW, { name: "entry", file, description: "Answer every go", triggers: [Go], gated: true });
    if (suite !== undefined) api.offer(BUILTIN_WORKFLOW, { name: "suite", file: suite, description: "Try the entry and promote it", suite: true });
    if (router !== undefined) api.offer(BUILTIN_WORKFLOW, { name: "router", file: router, description: "Route to the entry" });
  });

/** The suite opens a durable trial, checks an answer and optionally waits before promoting. */
function suiteScript(file: string): void {
  writeFileSync(
    file,
    [
      "export default workflow({",
      '  uses: ["workflow.start", "workflow.builtin.trial", "workflow.builtin.promote", "workflow.list", "niwa.records.read"],',
      "  input: z.object({ expected: z.string(), router: z.string().optional(), release: z.number().optional() }),",
      "  output: z.string(),",
      "}, async ({ expected, router, release }) => {",
      "  const { entries } = await niwa.workflow.builtin.trial({});",
      '  const entry = entries.find((one) => one.name === "entry");',
      '  if (entry === undefined || !entries.some((one) => one.candidate === true)) return "nothing";',
      "  const done = await niwa.workflow.start({ id: router ?? entry.workflow, args: router === undefined ? { n: 1 } : { id: entry.workflow }, wait: true, timeoutMs: 20000 });",
      '  if (done.outcome?.status !== "done" || done.outcome.result !== expected) return `failed: ${JSON.stringify(done)}`;',
      '  if (release !== undefined) await wait("gated.release", { filter: { n: release }, from: 0 });',
      "  return (await niwa.workflow.builtin.promote({})).status;",
      "});",
    ].join("\n"),
  );
}

/** The entry: an installation of it is held to what it uses, which the module's own handler holds. */
function script(file: string, text: string): void {
  writeFileSync(file, `export default workflow({ on: ["gated.go"], uses: ["workflow.list"], output: z.string() }, async () => ${JSON.stringify(text)});\n`);
}

async function served(home: string, file: string, suite?: string, router?: string): Promise<Host> {
  const host = createNiwa({ home });
  host.use(shipper(file, suite, router), workflow());
  await host.serve();
  hosts.push(host);
  return host;
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> => (await host.records.read()).filter((row) => row.type === type);
const failuresOf = async (host: Host) => (await ofType(host, "niwa.step.outcome")).filter((row) => (row.data as { outcome: { status: string } }).outcome.status === "failed").map((row) => row.data);

test("a gated built-in with no accepted version is a candidate: shown, not installed, not started", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join(await tempDir("gated"), "entry.ts");
  script(file, "v1");
  const host = await served(home.path, file);
  await eventually(async () => (await ofType(host, "workflow.registered")).length === 1, 20_000, "the candidate was not registered");
  await Bun.sleep(300);

  const [listed] = (await host.call(workflowList, {})).items;
  const got = await host.call(workflowGet, { id: listed?.id ?? "" });
  expect(got.versions.map((one) => one.candidate)).toEqual([true]);
  expect((await host.call(workflowInstallationList, {})).items).toEqual([]);
  await expect(host.call(workflowStart, { id: listed?.id ?? "" })).rejects.toThrow("candidate");

  await host.emit(Go, { n: 1 });
  await Bun.sleep(500);
  expect(await ofType(host, "workflow.run.requested")).toEqual([]);

  // The same file again: the candidate is in place, and nothing is asked for.
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  const again = await served(home.path, file);
  await Bun.sleep(500);
  expect(await ofType(again, "workflow.builtins.wanted")).toHaveLength(1);
  expect(await ofType(again, "workflow.registered")).toHaveLength(1);
}, 60_000);

const results = async (host: Host, workflowId: string): Promise<unknown[]> => {
  const runs = new Set((await ofType(host, "workflow.run.requested")).filter((row) => (row.data as { workflow?: string }).workflow === workflowId).map((row) => (row.data as { run: string }).run));
  return (await ofType(host, "workflow.run.finished")).filter((row) => runs.has((row.data as { run: string }).run)).map((row) => (row.data as { outcome: { result?: unknown } }).outcome.result);
};

test("a suite of the same plugin starts a candidate by its version and promotes it; then a new version waits as a candidate", async () => {
  const home = await tempHome();
  homes.push(home);
  const dir = await tempDir("gated");
  const file = join(dir, "entry.ts");
  const suite = join(dir, "suite.ts");
  script(file, "v1");
  suiteScript(suite);
  const host = await served(home.path, file, suite);
  await eventually(async () => (await host.call(workflowList, {})).items.length === 2, 20_000, "the built-ins were not registered");
  const items = (await host.call(workflowList, {})).items;
  const entry = items.find((one) => one.builtin?.name === "entry");
  const tried = items.find((one) => one.builtin?.name === "suite");
  const v1 = entry?.version ?? "";

  // Nobody but the suite starts a candidate by its version, or promotes it.
  await expect(host.call(workflowStart, { id: entry?.id ?? "", version: v1 })).rejects.toThrow("candidate");
  await expect(host.call(workflowBuiltinPromote, {})).rejects.toThrow("only a designated built-in suite");

  const { run } = await host.call(workflowStart, { id: tried?.id ?? "", args: { expected: "v1" } });
  const status = await host.call(workflowWait, { run, timeoutMs: 30_000 });
  if (status.outcome === undefined) throw new Error(JSON.stringify({ status, failed: await failuresOf(host) }));
  expect(status.outcome).toEqual({ status: "done", result: "promoted" });
  const promoted = await ofType(host, "workflow.builtin.promoted");
  expect(promoted.map((row) => row.data)).toEqual([expect.objectContaining({ run, versions: [{ workflow: entry?.id, version: v1 }] })]);
  const got = await host.call(workflowGet, { id: entry?.id ?? "" });
  expect(got.versions.map((one) => one.candidate)).toEqual([undefined]);
  await eventually(async () => (await host.call(workflowInstallationList, {})).items.some((one) => one.workflow === entry?.id), 20_000, "the promoted version was not installed");
  // Installed as the sync installs a built-in: by the module itself, not by the run that promoted it.
  const made = (await ofType(host, "workflow.subscription.installed")).map((row) => row.data as { workflow?: string; installer?: unknown });
  expect(made.filter((one) => one.workflow === entry?.id).map((one) => one.installer)).toEqual([undefined]);
  await host.emit(Go, { n: 1 });
  await eventually(async () => (await results(host, entry?.id ?? "")).includes("v1"), 20_000, "the promoted version did not run");
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);

  // A new build: the new version is a candidate, and the accepted one stays latest and installed.
  script(file, "v2");
  const next = await served(home.path, file, suite);
  await eventually(async () => (await next.call(workflowGet, { id: entry?.id ?? "" })).versions.length === 2, 20_000, "the candidate was not registered");
  const after = await next.call(workflowGet, { id: entry?.id ?? "" });
  expect(after.versions.map((one) => one.candidate)).toEqual([undefined, true]);
  const listed = (await next.call(workflowList, {})).items.find((one) => one.id === entry?.id);
  expect(listed?.version).toBe(v1);
  const installed = (await next.call(workflowInstallationList, {})).items.filter((one) => one.workflow === entry?.id);
  expect(installed).toHaveLength(1);
  expect((await next.call(workflowStart, { id: entry?.id ?? "", args: { n: 2 }, wait: true, timeoutMs: 20_000 })).outcome).toEqual({ status: "done", result: "v1" });
}, 90_000);

test("trial descendants use the pinned candidate and a late suite cannot roll it back", async () => {
  const home = await tempHome();
  homes.push(home);
  const dir = await tempDir("gated-trial");
  const file = join(dir, "entry.ts");
  const suite = join(dir, "suite.ts");
  const router = join(dir, "router.ts");
  script(file, "v1");
  suiteScript(suite);
  writeFileSync(router, `export default workflow({
    description: "Route to the entry",
    uses: ["workflow.start", "workflow.list"],
    input: z.object({ id: z.string(), version: z.string().optional() }),
    output: z.string(),
  }, async ({ id, version }) => {
    const called = await niwa.workflow.start({ id, version, args: { n: 1 }, wait: true, timeoutMs: 20000 });
    const result = called.outcome?.status === "done" ? called.outcome.result : undefined;
    return typeof result === "string" ? result : "no result";
  });\n`);
  const host = await served(home.path, file, suite, router);
  await eventually(async () => {
    const failures = await failuresOf(host);
    if (failures.length > 0) throw new Error(JSON.stringify(failures));
    return (await host.call(workflowList, {})).items.length === 3;
  }, 20_000);
  const items = (await host.call(workflowList, {})).items;
  const entry = items.find((one) => one.builtin?.name === "entry")!;
  const suiteId = items.find((one) => one.builtin?.name === "suite")!.id;
  const routerId = items.find((one) => one.builtin?.name === "router")!.id;
  const v1 = entry.version;
  const gate = (run: string) => eventually(async () => (await host.call(workflowWait, { run, timeoutMs: 10 })).waiting?.includes("gated.release") === true, 20_000);
  const finished = (run: string) => host.call(workflowWait, { run, timeoutMs: 20_000 });

  // An ordinary sibling built-in cannot pass an explicit candidate into a child.
  const ordinary = await host.call(workflowStart, { id: routerId, args: { id: entry.id, version: v1 }, wait: true, timeoutMs: 20_000 });
  expect(ordinary.state).toBe("paused");
  expect((await ofType(host, "workflow.run.requested")).some((row) => (row.data as { version?: string }).version === v1)).toBe(false);

  const older = await host.call(workflowStart, { id: suiteId, args: { expected: "v1", router: routerId, release: 1 } });
  await gate(older.run);
  // Submit the same offer update the host writes when a changed build starts. The sync registers the version.
  script(file, "v2");
  const v2 = versionOf(file)!;
  const prior = BuiltinsWanted.schema.parse((await ofType(host, BuiltinsWanted.name)).at(-1)?.data);
  await host.emit(BuiltinsWanted, { items: prior.items.map((item) => item.name === "entry" ? { ...item, version: v2 } : item) });
  await eventually(async () => (await host.call(workflowGet, { id: entry.id })).versions.length === 2, 20_000);
  const before = (await host.call(workflowGet, { id: entry.id })).versions;
  expect(before.map(({ version, candidate, superseded }) => ({ version, candidate, superseded }))).toEqual([
    { version: v1, candidate: undefined, superseded: true },
    { version: v2, candidate: true, superseded: undefined },
  ]);
  await expect(host.call(workflowStart, { id: entry.id, version: v1, args: { n: 1 } })).rejects.toThrow("unaccepted candidate");

  const newer = await host.call(workflowStart, { id: suiteId, args: { expected: "v2", router: routerId, release: 2 } });
  await gate(newer.run);
  const same = await host.call(workflowStart, { id: suiteId, args: { expected: "v2", router: routerId, release: 3 } });
  await gate(same.run);
  await host.emit(Release, { n: 2 });
  expect((await finished(newer.run)).outcome).toEqual({ status: "done", result: "promoted" });
  await host.emit(Release, { n: 1 });
  expect((await finished(older.run)).outcome).toEqual({ status: "done", result: "stale" });
  await host.emit(Release, { n: 3 });
  expect((await finished(same.run)).outcome).toEqual({ status: "done", result: "stale" });
  expect((await ofType(host, "niwa.record.refused")).map((row) => row.data)).toContainEqual(expect.objectContaining({ code: "stale-builtin-trial" }));
  const repeated = await host.call(workflowStart, { id: suiteId, args: { expected: "v2" }, wait: true, timeoutMs: 20_000 });
  expect(repeated.outcome).toEqual({ status: "done", result: "nothing" });
  expect((await ofType(host, "workflow.builtin.promoted")).map((row) => row.data)).toEqual([
    expect.objectContaining({ run: newer.run, versions: [{ workflow: entry.id, version: v2 }] }),
  ]);
  expect((await host.call(workflowStart, { id: entry.id, args: { n: 1 }, wait: true, timeoutMs: 20_000 })).outcome).toEqual({ status: "done", result: "v2" });
}, 90_000);
