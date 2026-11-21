// Runs and installations have owners: niwa issues the id of a run,
// and resume, revise and cancel of a run, and uninstall of an installation, are
// for whoever started or installed it, and for the owner.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf, seq } from "@niwa-labs/core";
import type { RuleSpec, StoredRecord } from "@niwa-labs/core";
import { connect, createNiwa, requests, timers, eventually, tempHome, connectAsOwner, StubFinished, WfNote, stub } from "@niwa-labs/testing";
import type { Host, NiwaApi } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


const START = actionName("workflow.start");
const RESUME = actionName("workflow.resume");
const REVISE = actionName("workflow.revise");
const CANCEL = actionName("workflow.cancel");
const INSTALL = actionName("workflow.install");
const UNINSTALL = actionName("workflow.uninstall");
const INSTALLED = actionName("workflow.installation.list");
const FINISH = actionName("stub.finish");

const NOT_YOURS = "whoever made it";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), stub(home.path));
  host.use(workflow({ triggers: [StubFinished], emits: [WfNote] }));
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

async function holding(host: Host, home: string, name: string, rules: readonly RuleSpec[]): Promise<NiwaApi> {
  const secret = host.issueToken(principalOf("session", name), { grant: grant(rules) });
  const client = await connect({ home, id: `session:${name}`, token: secret });
  clients.push(client);
  return client;
}

async function ownerOf(home: string): Promise<NiwaApi> {
  const client = await connectAsOwner(home);
  clients.push(client);
  return client;
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  const file = join(home, name);
  await mkdir(home, { recursive: true });
  await writeFile(file, lines.join("\n"));
  return file;
}

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const recordsOf = (host: Host): Promise<StoredRecord[]> => host.records.read();
const finished = async (host: Host): Promise<StoredRecord[]> => ofType(await recordsOf(host), "workflow.run.finished");

/** How many runs wait for a record now. */
async function waiting(host: Host): Promise<number> {
  const latest = new Map<string, string>();
  for (const row of ofType(await recordsOf(host), "niwa.invocation.state")) {
    const data = row.data as { invocation: string; state: string };
    if (data.invocation.startsWith("inv:workflow/workflow.run.requested")) latest.set(data.invocation, data.state);
  }
  return [...latest.values()].filter((state) => state === "waiting").length;
}

const FOREVER = [
  'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => { return await wait("never.happens"); });',
];
const WORK = ["workflow.start", "workflow.resume", "workflow.revise", "workflow.cancel", "niwa.records.read"] as const;

test("niwa issues the id of every run: two starts of one script are two runs run-…", async () => {
  const { host, home } = await served();
  const starter = await holding(host, home, "starter", WORK);
  const file = await scriptIn(home, "forever.js", FOREVER);
  const first = (await starter.call(START, { file })) as { run: string };
  const second = (await starter.call(START, { file })) as { run: string };
  expect(first.run).toMatch(/^run-[0-9a-z]{6,8}$/);
  expect(second.run).toMatch(/^run-[0-9a-z]{6,8}$/);
  expect(second.run).not.toBe(first.run);
  await eventually(async () => (await waiting(host)) === 2, 20_000);
  for (const run of [first.run, second.run]) await starter.call(CANCEL, { run });
  expect(ofType(await recordsOf(host), "workflow.run.requested")).toHaveLength(2);
}, 30_000);

test("a run is cancelled, resumed and revised by whoever started it and by the owner, and by no other client", async () => {
  const { host, home } = await served();
  const starter = await holding(host, home, "starter", WORK);
  const other = await holding(host, home, "other", WORK);
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "forever.js", FOREVER);
  const { run } = (await starter.call(START, { file })) as { run: string };
  await eventually(async () => (await waiting(host)) === 1, 20_000);

  await expect(other.call(CANCEL, { run })).rejects.toThrow(NOT_YOURS);
  await expect(other.call(RESUME, { run })).rejects.toThrow(NOT_YOURS);
  await expect(other.call(REVISE, { run, file })).rejects.toThrow(NOT_YOURS);
  expect(await finished(host)).toHaveLength(0);

  // The ones who may act get as far as the run itself: it is still going, so it is not started again.
  await expect(starter.call(RESUME, { run })).rejects.toThrow("still going");
  await expect(owner.call(REVISE, { run, file })).rejects.toThrow("still going");

  await owner.call(CANCEL, { run });
  expect(await finished(host)).toHaveLength(1);

  const second = (await starter.call(START, { file })) as { run: string };
  await eventually(async () => (await waiting(host)) === 2, 20_000);
  await starter.call(CANCEL, { run: second.run });
  expect(await finished(host)).toHaveLength(2);
}, 30_000);

test("an installation is uninstalled by whoever installed it and by the owner, and by no other client; its runs are for the installer", async () => {
  const { host, home } = await served();
  const installer = await holding(host, home, "installer", ["workflow.install", "workflow.uninstall", "workflow.cancel", "niwa.records.read"]);
  const other = await holding(host, home, "other", ["workflow.uninstall", "workflow.cancel", "workflow.installation.list"]);
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "installed.js", [
    'export default workflow({ on: ["stub.finished"], uses: ["niwa.records.read"], output: z.json() }, async () => { return await wait("never.happens"); });',
  ]);
  const { id } = (await installer.call(INSTALL, { file, description: "mine" })) as { id: string };
  await owner.call(FINISH, { id: "go" });
  await eventually(async () => (await waiting(host)) === 1, 20_000);
  const { run } = (ofType(await recordsOf(host), "workflow.run.started")[0]?.data ?? {}) as { run: string };

  // The run of an installation is its installer's, as the run a client started is the client's.
  await expect(other.call(CANCEL, { run })).rejects.toThrow(NOT_YOURS);
  await installer.call(CANCEL, { run });
  expect(await finished(host)).toHaveLength(1);

  await expect(other.call(UNINSTALL, { id })).rejects.toThrow(NOT_YOURS);
  expect(((await other.call(INSTALLED, {})) as { items: unknown[] }).items).toHaveLength(1);
  await installer.call(UNINSTALL, { id });

  const again = (await installer.call(INSTALL, { file, description: "mine" })) as { id: string };
  expect(again.id).not.toBe(id);
  await owner.call(UNINSTALL, { id: again.id });
  expect(((await owner.call(INSTALLED, {})) as { items: unknown[] }).items).toEqual([]);
}, 30_000);
