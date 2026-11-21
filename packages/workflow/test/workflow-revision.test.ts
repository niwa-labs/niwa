// A run started again on an edited script takes the calls of its earlier start along the longest
// unchanged prefix. The first new or changed call runs, and so does everything after it in its
// branch, or after the scope that holds it; a call with an effect that was made before as the same
// call is taken all the same, never made twice. An agent call is its prompt and its harness. The
// owner may ask for the steps from one of them, a branch or a phase on to run again. Nothing is
// taken from another run, and the journal and workflow.inspect say which steps were taken.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, requests, tempHome, testClock, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { workflow } from "../src/index.ts";
import type { WorkflowInspection } from "../src/inspect.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const Revision = z.object({
  reused: z.array(z.object({ key: z.string() })),
  rerun: z.array(z.object({ key: z.string(), reason: z.string() })),
});
const Resumed = z.object({ run: z.string(), revision: Revision.optional() });

async function setup() {
  const home = await tempHome();
  homes.push(home);
  const calls: string[] = [];
  const io = { input: z.object({ name: z.string() }), output: z.object({ name: z.string(), at: z.number() }) };
  const answer = (name: string) => {
    calls.push(name);
    return { name, at: calls.length };
  };
  const agent = action("rev.agent", {
    description: "An agent: it answers with its prompt.",
    input: z.object({ prompt: z.string(), harness: z.string().optional(), label: z.string().optional(), effort: z.string().optional() }),
    output: z.object({ answer: z.string(), at: z.number() }),
    // A session is started and asked: it has an effect.
    recovery: "do-not-repeat",
    run: async ({ prompt }) => {
      calls.push(`agent:${prompt}`);
      return { answer: prompt, at: calls.length };
    },
  });
  const niwa = createNiwa({ home: home.path, clock: testClock(1_700_000_000_000) });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(
    plugin("rev", (api) => {
      api.action(agent);
      api.action(action("rev.read", { ...io, description: "Reads: it may be made again.", recovery: "repeat", run: async ({ name }) => answer(`read:${name}`) }));
      api.action(action("rev.write", { ...io, description: "Writes: it is made once.", recovery: "do-not-repeat", run: async ({ name }) => answer(`write:${name}`) }));
    }),
  );
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();
  hosts.push(niwa);
  const file = join(home.path, "script.js");
  const call = <T>(name: string, input: unknown): Promise<T> => niwa.call(name as ActionName, input as never) as Promise<T>;
  const records = (): Promise<StoredRecord[]> => niwa.records.read();
  const finished = async (run: string): Promise<unknown[]> =>
    (await records())
      .filter((row) => row.type === "workflow.run.finished" && (row.data as { run: string }).run === run)
      .map((row) => (row.data as { outcome: { result?: unknown } }).outcome.result);
  return {
    calls,
    records,
    write: (source: string) => writeFile(file, source),
    start: async (): Promise<string> => (await call<{ run: string }>("workflow.start", { file })).run,
    resume: async (run: string, from?: string) =>
      Resumed.parse(await call("workflow.resume", { run, ...(from === undefined ? {} : { from }) })),
    inspect: (run: string) => call<WorkflowInspection>("workflow.inspect", { run }),
    /** Wait for the n-th end of the run, and give what it returned. */
    ended: async (run: string, n: number): Promise<unknown> => {
      await eventually(async () => (await finished(run)).length >= n, 15_000, `the run should end ${String(n)} times`);
      return (await finished(run))[n - 1];
    },
    reusedKeys: async (): Promise<string[]> =>
      (await records()).filter((row) => row.type === "workflow.step.reused").map((row) => (row.data as { key: string }).key),
  };
}

const script = (second: string) => `export default workflow({ uses: ["rev.*"], output: z.json() }, async () => {
  const a = await agent("first", { label: "a" });
  const r1 = await niwa.rev.read({ name: "one" }, { label: "r1" });
  const b = await agent("${second}", { label: "b" });
  const r2 = await niwa.rev.read({ name: "two" }, { label: "r2" });
  const w = await niwa.rev.write({ name: "once" }, { label: "w" });
  return [a.answer, r1.name, b.answer, r2.name, w.name];
});`;

test("a changed call and what comes after it run; the unchanged prefix and an effect made before are taken", async () => {
  const t = await setup();
  await t.write(script("second"));
  const run = await t.start();
  expect(await t.ended(run, 1)).toEqual(["first", "read:one", "second", "read:two", "write:once"]);
  expect(t.calls).toEqual(["agent:first", "read:one", "agent:second", "read:two", "write:once"]);

  await t.write(script("second, changed"));
  const resumed = await t.resume(run);
  expect(resumed.revision?.reused.map((one) => one.key)).toEqual(["label:a", "label:r1", "label:w"]);
  expect(resumed.revision?.rerun.map((one) => [one.key, one.reason])).toEqual([
    ["label:b", "changed"],
    ["label:r2", "after a change"],
  ]);
  expect(await t.ended(run, 2)).toEqual(["first", "read:one", "second, changed", "read:two", "write:once"]);
  // The changed call and the read after it ran; the write after it was made before, and is not made twice.
  expect(t.calls.slice(5)).toEqual(["agent:second, changed", "read:two"]);
  expect(await t.reusedKeys()).toEqual(["label:a", "label:r1", "label:w"]);

  // workflow.inspect says which steps a later start took, and which have an effect.
  const steps = (await t.inspect(run)).steps;
  const first = steps.filter((step) => step.key === "label:a");
  expect(first.map((step) => step.reused === true)).toEqual([true]);
  expect(steps.find((step) => step.key === "label:w")).toMatchObject({ reused: true, effect: true });
  expect(steps.find((step) => step.key === "label:r1")?.effect).toBeUndefined();
}, 30_000);

test("an agent call is its prompt and its harness: another effort takes the recorded answer", async () => {
  const t = await setup();
  const source = (effort: string) => `export default workflow({ uses: ["rev.*"], output: z.json() }, async () => {
    return (await agent("same prompt", { label: "only", effort: "${effort}" })).answer;
  });`;
  await t.write(source("low"));
  const run = await t.start();
  expect(await t.ended(run, 1)).toBe("same prompt");
  await t.write(source("high"));
  const resumed = await t.resume(run);
  expect(resumed.revision?.reused.map((one) => one.key)).toEqual(["label:only"]);
  expect(await t.ended(run, 2)).toBe("same prompt");
  expect(t.calls).toEqual(["agent:same prompt"]);
}, 30_000);

test("the owner asks for the steps from one on to run again: the effects before it and after it are not made twice", async () => {
  const t = await setup();
  await t.write(script("second"));
  const run = await t.start();
  await t.ended(run, 1);
  const resumed = await t.resume(run, "label:b");
  expect(resumed.revision).toBeUndefined();
  expect(await t.ended(run, 2)).toEqual(["first", "read:one", "second", "read:two", "write:once"]);
  expect(t.calls.slice(5)).toEqual(["agent:second", "read:two"]);
  expect(await t.reusedKeys()).toEqual(["label:a", "label:r1", "label:w"]);
}, 30_000);

test("the owner asks for a phase to run again: its steps run, and the steps before it are taken", async () => {
  const t = await setup();
  await t.write(`export default workflow({ uses: ["rev.*"], phases: [{ title: "Gather" }, { title: "Judge" }], output: z.json() }, async () => {
    phase("Gather");
    const one = await niwa.rev.read({ name: "one" }, { label: "one" });
    phase("Judge");
    const two = await niwa.rev.read({ name: "two" }, { label: "two" });
    return [one.at, two.at];
  });`);
  const run = await t.start();
  expect(await t.ended(run, 1)).toEqual([1, 2]);
  await t.resume(run, "Judge");
  expect(await t.ended(run, 2)).toEqual([1, 3]);
  expect(t.calls).toEqual(["read:one", "read:two", "read:two"]);
}, 30_000);

test("a change in one branch of a scope leaves the other branches taken, and what comes after the scope runs", async () => {
  const t = await setup();
  const source = (x: string) => `export default workflow({ uses: ["rev.*"], output: z.json() }, async () => {
    const got = await scope("s", undefined, async (s) => {
      s.start("x", async () => { await agent("${x}"); return (await niwa.rev.read({ name: "x2" })).at; });
      s.start("y", async () => { await niwa.rev.read({ name: "y1" }); return (await niwa.rev.read({ name: "y2" })).at; });
      return await s.rest();
    });
    const after = await niwa.rev.read({ name: "after" });
    return [got.x.value, got.y.value, after.name];
  });`;
  await t.write(source("x1"));
  const run = await t.start();
  await t.ended(run, 1);
  expect([...t.calls].sort()).toEqual(["agent:x1", "read:after", "read:x2", "read:y1", "read:y2"]);
  const before = t.calls.length;

  await t.write(source("x1, changed"));
  const resumed = await t.resume(run);
  expect(resumed.revision?.reused.map((one) => one.key).sort()).toEqual(["@s.y.call-1", "@s.y.call-2"]);
  expect(Object.fromEntries((resumed.revision?.rerun ?? []).map((one) => [one.key, one.reason]))).toEqual({
    "@s.x.call-1": "changed",
    "@s.x.call-2": "after a change",
    "call-1": "after a change",
  });
  await t.ended(run, 2);
  expect(t.calls.slice(before).sort()).toEqual(["agent:x1, changed", "read:after", "read:x2"]);
}, 30_000);

test("a new run of the same script takes nothing: only the starts of one run share their steps", async () => {
  const t = await setup();
  await t.write(script("second"));
  const one = await t.start();
  await t.ended(one, 1);
  const two = await t.start();
  await t.ended(two, 1);
  expect(t.calls).toEqual([
    "agent:first", "read:one", "agent:second", "read:two", "write:once",
    "agent:first", "read:one", "agent:second", "read:two", "write:once",
  ]);
  expect(await t.reusedKeys()).toEqual([]);
}, 30_000);
