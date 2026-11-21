// The calls an agent uses to drive a run: `workflow.start` with `wait`, `workflow.wait` and
// `workflow.runs`. No model is involved: the scripts finish, fail or ask.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect, createNiwa, requests, timers, tempHome } from "@niwa-labs/testing";
import type { Host, NiwaApi } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";
import type { RunStatus } from "../src/status.ts";

const START = actionName("workflow.start");
const WAIT = actionName("workflow.wait");
const RUNS = actionName("workflow.runs");

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
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

const statusOf = async (host: Host, run: string, timeoutMs?: number): Promise<RunStatus> =>
  (await host.call(WAIT, { run, ...(timeoutMs === undefined ? {} : { timeoutMs }) })) as RunStatus;

test("start with wait answers with the result when the run finishes", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "done.js", ["export default workflow({ output: z.json() }, async () => { return { answer: 42 }; });"]);
  const started = (await host.call(START, { file, wait: true, timeoutMs: 20_000 })) as RunStatus & { finished: boolean };
  expect(started.run).toMatch(/^run-[0-9a-f]{6,8}$/);
  expect(started).toMatchObject({ state: "finished", finished: true, outcome: { status: "done", result: { answer: 42 } }, requests: [] });
  // Waiting for a run that has ended answers at once.
  expect(await statusOf(host, started.run)).toMatchObject({ state: "finished", outcome: { status: "done", result: { answer: 42 } } });
}, 30_000);

test("wait returns a paused run with its reason and the invocation to resolve", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "boom.js", ['export default workflow({}, async () => { throw new Error("boom"); });']);
  const runBoom = ((await host.call(START, { file })) as { run: string }).run;
  const paused = await statusOf(host, runBoom, 20_000);
  expect(paused.state).toBe("paused");
  expect(paused.reason).toContain("boom");
  // An error of the script outside any step has no step to skip.
  expect(paused.choices).toEqual(["retry", "cancel"]);
  expect(paused.invocation).toBeString();

  const { runs } = (await host.call(RUNS, {})) as { runs: string[] };
  expect(runs).toHaveLength(1);
  expect(runs[0]).toContain(`${runBoom}  boom  paused  boom`);
  expect(runs[0]).toContain(`resolve: niwa workflow.resume --run ${runBoom} --choice retry|cancel`);
}, 30_000);

test("the end of the timeout is not an error: the run is running, and says what it asked", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "asks.js", ['export default workflow({ output: z.json() }, async () => { return await ask.confirm("go on?"); });']);
  const runAsks = ((await host.call(START, { file })) as { run: string }).run;
  const started = Date.now();
  let status = await statusOf(host, runAsks, 300);
  // The question may not be written yet at the first look: the run asks once it has started.
  while (status.requests.length === 0 && Date.now() - started < 20_000) status = await statusOf(host, runAsks, 300);
  expect(status.state).toBe("running");
  expect(status.requests).toHaveLength(1);
  const { runs } = (await host.call(RUNS, {})) as { runs: string[] };
  expect(runs[0]).toMatch(/running {2}ask req-[0-9a-f]{6,8}/);
  expect(status.waiting).toBe(`ask ${status.requests[0]}`);
}, 30_000);

test("runs lists by state and keeps the latest ones; an unknown run is refused", async () => {
  const { host, home } = await served();
  const done = await scriptIn(home, "ok.js", ["export default workflow({ output: z.number() }, async () => { return 1; });"]);
  const boom = await scriptIn(home, "bad.js", ['export default workflow({}, async () => { throw new Error("no"); });']);
  const finished: string[] = [];
  for (let n = 0; n < 2; n += 1) finished.push(((await host.call(START, { file: done, wait: true })) as { run: string }).run);
  const run3 = ((await host.call(START, { file: boom, wait: true, timeoutMs: 20_000 })) as { run: string }).run;

  const lines = async (input: Record<string, unknown>): Promise<string[]> => ((await host.call(RUNS, input)) as { runs: string[] }).runs;
  expect(await lines({})).toHaveLength(3);
  expect((await lines({ state: "finished" })).map((line) => line.split("  ")[0])).toEqual(finished);
  expect((await lines({ state: "paused" })).map((line) => line.split("  ")[0])).toEqual([run3]);
  expect((await lines({ limit: 1 })).map((line) => line.split("  ")[0])).toEqual([run3]);
  await expect(statusOf(host, "run-ffffff")).rejects.toThrow('no run "run-ffffff"');
}, 30_000);

test("a read filtered by run gives everything about that run: its records, its steps and its questions, and nothing of another run", async () => {
  const { host, home } = await served();
  const asks = await scriptIn(home, "asker.js", ['export default workflow({ output: z.json() }, async () => { return await ask.confirm("one?"); });']);
  const other = await scriptIn(home, "other.js", ["export default workflow({ output: z.number() }, async () => { return 2; });"]);
  const runMine = ((await host.call(START, { file: asks })) as { run: string }).run;
  const runOther = ((await host.call(START, { file: other, wait: true })) as { run: string }).run;
  const started = Date.now();
  while ((await statusOf(host, runMine, 300)).requests.length === 0 && Date.now() - started < 20_000) continue;

  const read = (await host.call(actionName("niwa.records.read"), { filter: { run: runMine } })) as { records: Array<{ type: string; data: { run?: string } }> };
  const types = read.records.map((row) => String(row.type));
  expect(types).toContain("workflow.run.requested");
  expect(types).toContain("request.created");
  expect(types.some((type) => type.startsWith("niwa.step."))).toBe(true);
  expect(read.records.some((row) => row.data.run === runOther)).toBe(false);
  expect(types).not.toContain("workflow.run.finished");
}, 30_000);

test("a run paused for a revision, that only cancel answers, is paused and not finished", async () => {
  const { host, home } = await served();
  const body = (limit: number): string =>
    `export default workflow({ uses: ["niwa.records.read"] }, async () => { await call("niwa.records.read", { limit: ${limit} }); throw new Error("x"); });`;
  const file = await scriptIn(home, "edit.js", [body(1)]);
  const runEdit = ((await host.call(START, { file })) as { run: string }).run;
  expect((await statusOf(host, runEdit, 20_000)).state).toBe("paused");
  await writeFile(file, body(2));
  await host.call(actionName("workflow.resume"), { run: runEdit });
  const shown = await statusOf(host, runEdit, 300);
  expect(shown).toMatchObject({ state: "paused", choices: ["cancel"] });
  const { runs } = (await host.call(RUNS, {})) as { runs: string[] };
  expect(runs[0]).toContain(`resolve: niwa workflow.revise --run ${runEdit}`);
  await host.call(actionName("workflow.cancel"), { run: runEdit });
  expect(await statusOf(host, runEdit)).toMatchObject({ state: "finished", outcome: { status: "cancelled" } });
}, 30_000);

test("a client that is not the owner waits for and lists only the runs it started", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "mine.js", ["export default workflow({ output: z.number() }, async () => { return 1; });"]);
  const clients: NiwaApi[] = [];
  const holding = async (name: string): Promise<NiwaApi> => {
    const secret = host.issueToken(principalOf("session", name), { grant: grant(["workflow.start", "workflow.wait", "workflow.runs"]) });
    const client = await connect({ home, id: `session:${name}`, token: secret });
    clients.push(client);
    return client;
  };
  try {
    const first = await holding("first");
    const second = await holding("second");
    const runFirst = ((await first.call(START, { file, wait: true, timeoutMs: 20_000 })) as { run: string }).run;
    await expect(second.call(WAIT, { run: runFirst })).rejects.toThrow("only the owner or whoever made it");
    expect(await first.call(WAIT, { run: runFirst })).toMatchObject({ state: "finished" });
    expect(((await second.call(RUNS, {})) as { runs: string[] }).runs).toEqual([]);
    expect(((await first.call(RUNS, {})) as { runs: string[] }).runs).toHaveLength(1);
    expect(((await host.call(RUNS, {})) as { runs: string[] }).runs).toHaveLength(1);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
  }
}, 30_000);

test("niwa.host.status counts the runs by state and the open requests", async () => {
  const { host, home } = await served();
  const done = await scriptIn(home, "done.js", ["export default workflow({ output: z.number() }, async () => { return 1; });"]);
  const asks = await scriptIn(home, "asks.js", ['export default workflow({ output: z.json() }, async () => { return await ask.confirm("go on?"); });']);
  const runDone = ((await host.call(START, { file: done, wait: true, timeoutMs: 20_000 })) as { run: string }).run;
  const runAsks = ((await host.call(START, { file: asks })) as { run: string }).run;
  const started = Date.now();
  // The run asks once it has started: look until the question is written.
  while ((await statusOf(host, runAsks, 300)).requests.length === 0 && Date.now() - started < 20_000);
  const status = (await host.call(actionName("niwa.host.status"), {})) as { plugins: Array<{ name: string; summary?: Record<string, number> }> };
  expect(status.plugins.find((one) => one.name === "workflow")?.summary).toEqual({ running: 1, paused: 0, finished: 1 });
  expect(status.plugins.find((one) => one.name === "requests")?.summary).toEqual({ open: 1 });
}, 30_000);

test("a run that is going shows its phase and what it waits for: a sleep with its time, a wait with its type", async () => {
  const { host, home } = await served();
  const sleeper = await scriptIn(home, "sleeper.js", [
    'export default workflow({ output: z.number(), phases: [{ title: "resting" }, { title: "after" }] }, async () => { phase("resting"); await sleep("2h", { label: "nap" }); return 1; });',
  ]);
  const waiter = await scriptIn(home, "waiter.js", [
    'export default workflow({ output: z.number() }, async () => { await wait("x.y"); return 1; });',
  ]);
  const runSleeper = ((await host.call(START, { file: sleeper })) as { run: string }).run;
  const runWaiter = ((await host.call(START, { file: waiter })) as { run: string }).run;
  const lineOf = async (run: string, text: RegExp): Promise<string> => {
    const started = Date.now();
    for (;;) {
      const line = ((await host.call(RUNS, {})) as { runs: string[] }).runs.find((one) => one.startsWith(run)) ?? "";
      if (text.test(line) || Date.now() - started > 20_000) return line;
      await Bun.sleep(100);
    }
  };
  expect(await lineOf(runSleeper, /sleep nap/)).toMatch(new RegExp(`^${runSleeper} {2}sleeper {2}running {2}resting \\(1/2\\) {2}sleep nap until \\d\\d:\\d\\d:\\d\\d$`));
  expect(await lineOf(runWaiter, /wait x/)).toMatch(new RegExp(`^${runWaiter} {2}waiter {2}running {2}wait x\\.y$`));
  const status = await statusOf(host, runSleeper, 200);
  expect(status).toMatchObject({ state: "running", currentPhases: ["resting"], phases: [{ title: "resting", state: "current" }, { title: "after", state: "ahead" }] });
  expect(status.waiting).toMatch(/^sleep nap until/);
}, 30_000);

test("timer.list shows the pending sleeps with who asked and the timers with their schedule", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([{ id: "digest", daily: "21:00" }]), workflow());
  await host.serve();
  hosts.push(host);
  const file = await scriptIn(home.path, "napper.js", ['export default workflow({ output: z.number() }, async () => { await sleep("2h", { label: "nap" }); return 1; });']);
  await host.call(START, { file });
  const list = async () => (await host.call(actionName("timer.list"), {})) as { sleeps: string[]; timers: Array<{ name: string; schedule: unknown; nextDue: number | null; lastFiring: string | null }> };
  const started = Date.now();
  while ((await list()).sleeps.length === 0 && Date.now() - started < 20_000) await Bun.sleep(100);
  const { sleeps, timers: scheduled } = await list();
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toMatch(/^\d\d:\d\d:\d\d {2}run-[0-9a-f]{6,8} {2}nap$/);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]).toMatchObject({ name: "digest", schedule: { kind: "daily", time: "21:00" }, lastFiring: null });
  expect(scheduled[0]?.nextDue).toBeGreaterThan(Date.now());
  const status = (await host.call(actionName("niwa.host.status"), {})) as { plugins: Array<{ name: string; summary?: Record<string, number> }> };
  expect(status.plugins.find((one) => one.name === "timers")?.summary).toEqual({ sleeps: 1 });
}, 30_000);
