// Ids a person types: a request, a run or an invocation is named by a unique start or end of its id,
// or by its short form; a text that fits several is refused with the candidates; a run names its own
// open ask (`request.answer --run`) and its own pause (`workflow.resume --run --choice`).

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NiwaApi } from "@niwa-labs/client";
import { RESOLVE_ACTION, actionName, seq, shortInvocation, shortRun } from "@niwa-labs/core";
import { logLine } from "@niwa-labs/cli";
import {
  createNiwa,
  eventually,
  tempHome,
  connectAsOwner,
  requests,
  timers,
  workflow,
} from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

const START = actionName("workflow.start");
const WAIT = actionName("workflow.wait");
const RUNS = actionName("workflow.runs");
const ANSWER = actionName("request.answer");
const LIST = actionName("request.list");
const CANCEL = actionName("request.cancel");
const RESUME = actionName("workflow.resume");

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; owner: NiwaApi; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  const owner = await connectAsOwner(home.path);
  clients.push(owner);
  return { host, owner, home: home.path };
}

async function scriptIn(home: string, name: string, text: string): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, text);
  return file;
}

const asker = (label: string): string =>
  `export default workflow({ output: z.json() }, async () => { try { return await ask.confirm("go?", { label: "${label}" }); } catch (error) { return error.name; } });`;

const stateOf = async (owner: NiwaApi, run: string): Promise<{ state: string; outcome?: { result?: unknown }; requests: string[] }> =>
  (await owner.call(WAIT, { run, timeoutMs: 200 })) as { state: string; outcome?: { result?: unknown }; requests: string[] };

const openAsks = async (owner: NiwaApi, runs: readonly string[]): Promise<void> =>
  eventually(async () => (await Promise.all(runs.map((run) => stateOf(owner, run)))).every((status) => status.requests.length === 1), 20_000, "the runs should ask");

/** The id of the open request each run asked, by the run. */
async function askedBy(owner: NiwaApi, runs: readonly string[]): Promise<Record<string, string>> {
  const { items } = (await owner.call(LIST, { status: "open" })) as { items: Array<{ id: string; from?: { id: string } }> };
  return Object.fromEntries(runs.map((run) => [run, items.find((item) => item.from?.id === `run:${run}`)?.id ?? ""]));
}

/** The shortest end of an id, from the hash, that no other of the ids ends with. */
function uniqueEnd(id: string, others: readonly string[]): string {
  for (let length = 3; length <= id.length; length += 1) {
    const end = id.slice(-length);
    if (!others.some((other) => other.endsWith(end))) return end;
  }
  return id;
}

test("a request is named by its id, a unique end of it, or by the run that asked; several are refused with the candidates", async () => {
  const { owner, home } = await served();
  const started: string[] = [];
  for (const name of ["a", "b", "c"]) {
    started.push(((await owner.call(START, { file: await scriptIn(home, `${name}.js`, asker("ship")) })) as { run: string }).run);
  }
  const [runA = "", runB = "", runC = ""] = started;
  await openAsks(owner, started);
  const ids = await askedBy(owner, started);
  for (const id of Object.values(ids)) expect(id).toMatch(/^req-[0-9a-f]{6,8}$/);
  expect(new Set(Object.values(ids)).size).toBe(3);

  // The prefix every id has fits all three.
  await expect(owner.call(ANSWER, { id: "req-", answer: { ids: ["yes"] } })).rejects.toThrow(/names 3 requests: req-/);
  const end = uniqueEnd(ids[runC] ?? "", [ids[runA] ?? "", ids[runB] ?? ""]);
  expect(await owner.call(ANSWER, { id: end, answer: { ids: ["yes"] } })).toMatchObject({ accepted: true });
  await eventually(async () => (await stateOf(owner, runC)).state === "finished", 20_000);
  expect((await stateOf(owner, runC)).outcome?.result).toBe(true);

  expect(await owner.call(ANSWER, { run: runA, answer: { ids: ["no"] } })).toMatchObject({ accepted: true });
  await eventually(async () => (await stateOf(owner, runA)).state === "finished", 20_000);
  // The ask of the second run is the only one still open: a text that ends several is the open one, and a cancel names it too.
  await owner.call(CANCEL, { id: ids[runB] ?? "" });
  await eventually(async () => (await stateOf(owner, runB)).state === "finished", 20_000);
  expect((await stateOf(owner, runB)).outcome?.result).toBe("AskCancelled");
  await expect(owner.call(CANCEL, { run: runB })).rejects.toThrow("has no open ask");
  await expect(owner.call(CANCEL, { id: "req-nothing" })).rejects.toThrow("does not exist");
}, 30_000);

test("a run is named by a unique start of its id; its pause is answered by the run, or by the short form of the invocation", async () => {
  const { host, owner, home } = await served();
  const boom = await scriptIn(home, "boom.js", 'export default workflow({}, async () => { throw new Error("boom"); });');
  const runBoom1 = ((await owner.call(START, { file: boom })) as { run: string }).run;
  const runBoom2 = ((await owner.call(START, { file: boom })) as { run: string }).run;
  const paused = (await owner.call(WAIT, { run: runBoom1, timeoutMs: 20_000 })) as { state: string; invocation: string };
  await owner.call(WAIT, { timeoutMs: 20_000, run: runBoom2 });
  expect(paused.state).toBe("paused");

  await expect(owner.call(WAIT, { run: "run-" })).rejects.toThrow(/names 2 runs/);
  const lines = ((await owner.call(RUNS, {})) as { runs: string[] }).runs;
  expect(lines[0]).toContain(`resolve: niwa workflow.resume --run ${runBoom1} --choice retry|cancel`);

  await owner.call(RESUME, { choice: "cancel", run: runBoom1 });
  await eventually(async () => (await stateOf(owner, runBoom1)).state === "finished", 20_000);
  await expect(owner.call(RESUME, { run: runBoom1, choice: "retry" })).rejects.toThrow("is not paused");

  const second = (await owner.call(WAIT, { run: runBoom2 })) as { invocation: string };
  await host.call(RESOLVE_ACTION, { invocation: shortInvocation(second.invocation), choice: "cancel" });
  await eventually(async () => (await stateOf(owner, runBoom2)).state === "finished", 20_000);
}, 30_000);

test("niwa.invocation.resolve takes --run: the one paused invocation of that run", async () => {
  const { host, owner, home } = await served();
  const boom = await scriptIn(home, "boom.js", 'export default workflow({}, async () => { throw new Error("boom"); });');
  const runPause1 = ((await owner.call(START, { file: boom })) as { run: string }).run;
  await owner.call(WAIT, { timeoutMs: 20_000, run: runPause1 });
  await expect(host.call(RESOLVE_ACTION, { run: "run-ffffff", choice: "cancel" })).rejects.toThrow("has no paused invocation");
  await host.call(RESOLVE_ACTION, { run: runPause1.slice(0, 7), choice: "cancel" });
  await eventually(async () => (await stateOf(owner, runPause1)).state === "finished", 20_000);
}, 30_000);

test("short forms: a long run id shows its first eight characters", () => {
  expect(shortRun("run_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")).toBe("run_1a2b3c4d");
  expect(shortRun("sub_0123456789abcdef01234567")).toBe("sub_01234567");
  expect(shortRun("run_boom")).toBe("run_boom");
}, 30_000);

test("niwa log shows a short subject: the request by its id, the invocation by its hash, and the data gets the room", async () => {
  const { host, owner, home } = await served();
  const runLog = ((await owner.call(START, { file: await scriptIn(home, "log.js", asker("ship")) })) as { run: string }).run;
  await openAsks(owner, [runLog]);
  const waiting = (line: string): boolean => line.includes("invocation.state") && line.includes("waiting");
  let lines: string[] = [];
  let created: string | undefined;
  await eventually(async () => {
    const rows = await host.records.read();
    lines = rows.map((one) => logLine(one, 200));
    // The record itself, not another that names its type (the position of a subscription to it).
    const row = rows.find((one) => one.type === "request.created");
    created = row === undefined ? undefined : logLine(row, 200);
    return lines.some(waiting);
  }, 20_000, "the invocation should be logged as waiting");
  expect(created).toMatch(/request\.created +req-[0-9a-f]{6,8} /);
  expect(created).not.toContain("op_");
  const state = lines.find(waiting);
  expect(state).toMatch(/invocation:inv_[0-9a-f]{8} {2}state=waiting/);
}, 30_000);
