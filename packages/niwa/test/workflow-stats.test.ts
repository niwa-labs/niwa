// `workflow.stats`: the runs of the workflows folded from the journal.
//
//   1. a registered workflow is measured version by version: outcomes, clean rate, agent calls by harness and model;
//   2. a question to the owner and a sleep are human and timer time, and the run is not clean;
//   3. a step that fails is a failure in the phase the run was in;
//   4. `compare` takes two versions by a start of their hash, and `since` drops the runs before it.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { seq, timestamp } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import {
  ModelNameSchema,
  NativeSessionIdSchema,
  harnessId,
  harnessKind,
  machineId,
} from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
} from "@niwa-labs/harness";
import { RequestCreated, requestAnswer, requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempHome, testClock, connectAsOwner } from "@niwa-labs/testing";
import type { TestClock } from "@niwa-labs/testing";
import { timers } from "@niwa-labs/timer";
import {
  workflow,
  workflowRegister,
  workflowStart,
  workflowStats,
  workflowWait,
  StatsFold,
} from "@niwa-labs/workflow";
import type { WorkflowVersion } from "@niwa-labs/workflow";

import { openJournal } from "@niwa-labs/core/journal";

const HARNESS = harnessId("fake-harness");
const START = 1_700_000_000_000;

class FakeControl implements SessionControl {
  private counter = 0;

  async start(): Promise<{ session: SessionId }> {
    this.counter += 1;
    return { session: { harness: HARNESS, native: NativeSessionIdSchema.parse(`session-${String(this.counter)}`) } };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    return { session: id, value: options.schema.parse({ answer: "ok" }), at: timestamp(START) };
  }

  async *life(): AsyncIterable<LifeEvent> {
    yield { kind: "model", model: ModelNameSchema.parse("fake-model-1") };
  }

  async state(): Promise<"running" | "idle" | "unknown"> {
    return "unknown";
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    reading: { list: true, read: true, watch: false },
    control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: true, effort: ["low"], modes: ["auto"] } },
  },
};

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 30_000);

async function served(clock: TestClock): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path, clock });
  host.use(requests());
  host.use(timers([]));
  host.use(sessions({ harnesses: [{ instance, control: new FakeControl() }] }));
  host.use(workflow({ harnesses: [HARNESS] }));
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

const settled = async (host: Host, run: string, state: "finished" | "paused"): Promise<void> => {
  expect((await host.call(workflowWait, { run, timeoutMs: 20_000 })).state).toBe(state);
};

test("the stats of a workflow by versions, and of every workflow", async () => {
  const clock = testClock(START);
  const { host, home } = await served(clock);
  const file = await scriptIn(home, "flow.ts", [
    "export default workflow({ description: 'one agent call', output: z.string(), phases: [{ title: 'work' }] }, async () => {",
    '  phase("work");',
    '  const reply = await agent("hi", { harness: "fake-harness" });',
    "  return reply.answer;",
    "});",
  ]);
  const first = await host.call(workflowRegister, { file });
  for (let i = 0; i < 2; i += 1) await settled(host, (await host.call(workflowStart, { id: first.id })).run, "finished");

  await writeFile(file, ["export default workflow({ description: 'it breaks', output: z.string(), phases: [{ title: 'boom' }] }, async () => {", '  phase("boom");', '  throw new Error("broken");', "});"].join("\n"));
  const second = await host.call(workflowRegister, { file, id: first.id });
  expect(second.version).not.toBe(first.version);
  await clock.advance(60_000);
  const broken = await host.call(workflowStart, { id: first.id });
  await settled(host, broken.run, "paused");

  const byVersion = await host.call(workflowStats, { id: first.id });
  if (byVersion.scope !== "workflow") throw new Error("a workflow view was expected");
  expect(byVersion.versions.map((one) => one.version)).toEqual([first.version, second.version]);
  const [v1, v2] = byVersion.versions;
  expect(v1?.measures).toMatchObject({ runs: 2, clean: 2, cleanRate: 1, outcomes: { done: 2, paused: 0 }, failures: [] });
  expect(v1?.measures.duration?.n).toBe(2);
  expect(v1?.measures.agentCalls).toEqual([{ harness: "fake-harness", model: "fake-model-1", calls: 2, failed: 0, ms: expect.any(Number) }]);
  expect(v2?.measures).toMatchObject({ runs: 1, clean: 0, cleanRate: null, outcomes: { paused: 1 }, failures: [{ phase: "boom", count: 1 }] });
  expect(byVersion.total.runs).toBe(3);
  expect(byVersion.caveats.length).toBeGreaterThan(0);

  const compared = await host.call(workflowStats, { id: first.id, compare: [second.version.slice(0, 8), first.version.slice(0, 8)] });
  if (compared.scope !== "workflow") throw new Error("a workflow view was expected");
  expect(compared.versions.map((one) => one.version)).toEqual([second.version, first.version] satisfies WorkflowVersion[]);

  // A second answer with nothing new in the journal is the same answer: no record is folded twice.
  expect(await host.call(workflowStats, { id: first.id })).toEqual(byVersion);

  const recent = await host.call(workflowStats, { id: first.id, since: START + 30_000 });
  expect(recent.total.runs).toBe(1);

  await expect(host.call(workflowStats, { id: first.id, compare: ["zzzz", first.version] })).rejects.toThrow(/no version/);
  await expect(host.call(workflowStats, { compare: [first.version, second.version] })).rejects.toThrow(/name its id/);
}, 60_000);

test("a question to the owner and a sleep are human and timer time, and the run is not clean", async () => {
  const clock = testClock(START);
  const { host, home } = await served(clock);
  const file = await scriptIn(home, "talk.ts", [
    "export default workflow({ output: z.boolean(), phases: [{ title: 'talk' }] }, async () => {",
    '  phase("talk");',
    '  const yes = await ask.confirm("Go on?");',
    '  await sleep("1m");',
    "  return yes;",
    "});",
  ]);
  const owner = await connectAsOwner(home);
  try {
    const { run } = await host.call(workflowStart, { file });
    const asked = async () => (await host.records.read(seq(0))).find((row) => row.type === RequestCreated.name);
    await eventually(async () => (await asked()) !== undefined, 10_000, "the owner should be asked");
    await clock.advance(5_000);
    await owner.call(requestAnswer, { id: RequestCreated.schema.parse((await asked())?.data).id, answer: { ids: ["yes"] } });
    await eventually(async () => (await host.records.read(seq(0))).some((row) => row.type === "timer.sleep.requested"), 10_000, "the run should sleep");
    await clock.advance(60_000);
    await settled(host, run, "finished");
  } finally {
    await owner.close().catch(() => {});
  }

  const all = await host.call(workflowStats, {});
  if (all.scope !== "all") throw new Error("a general view was expected");
  expect(all.workflows).toEqual([{ subject: { kind: "script", file }, measures: all.total }]);
  expect(all.total).toMatchObject({ runs: 1, clean: 0, cleanRate: 0, outcomes: { done: 1 } });
  expect(all.total.time.askMs).toBeGreaterThanOrEqual(5_000);
  expect(all.total.time.humanMs).toBe(all.total.time.askMs);
  expect(all.total.time.timerMs).toBeGreaterThanOrEqual(60_000);
  expect(all.total.duration?.max).toBeGreaterThanOrEqual(65_000);
}, 60_000);

test("the fold over a journal of many runs, timed", async () => {
  const clock = testClock(START);
  const { host, home } = await served(clock);
  const file = await scriptIn(home, "one.ts", [
    "export default workflow({ output: z.string(), phases: [{ title: 'work' }] }, async () => {",
    '  phase("work");',
    '  const reply = await agent("hi", { harness: "fake-harness" });',
    "  return reply.answer;",
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  await settled(host, run, "finished");
  // The records of the run, copied with other ids: each copy is one more run the fold reads.
  const template = (await host.records.read(seq(0))).map((row) => JSON.stringify({ ...row, seq: undefined, at: undefined }));
  const copies = await tempHome();
  homes.push(copies);
  const journal = openJournal(copies.path);
  const RUNS = 2_000;
  try {
    for (let copy = 0; copy < RUNS; copy += 1) {
      journal.appendMany(template.map((text) => JSON.parse(text.replaceAll(run, `run-${copy.toString(16).padStart(8, "0")}`).replaceAll("inv:", `inv${String(copy)}:`).replaceAll('"id":"', `"id":"c${String(copy)}-`))));
    }
    const fold = new StatsFold();
    const began = performance.now();
    fold.catchUp(journal);
    const ms = performance.now() - began;
    console.log(`workflow.stats fold: ${String(RUNS)} runs, ${String(journal.last())} records, ${ms.toFixed(0)} ms`);
    const all = fold.answer({});
    expect(all.total.runs).toBe(RUNS);
    expect(all.total.outcomes.done).toBe(RUNS);
    expect(all.total.agentCalls).toEqual([{ harness: "fake-harness", model: "fake-model-1", calls: RUNS, failed: 0, ms: expect.any(Number) }]);
  } finally {
    journal.close();
  }
}, 120_000);
