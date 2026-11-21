// Stopping part of a run, and the tree of runs.
//
// The owner stops a branch, a scope or a step of a run by its key prefix: its steps end as
// cancelled and the rest of the run goes on. A shielded scope under it is spared unless the stop
// goes through shields. A run that a branch starts is its child: stopping the branch, cancelling
// the run or pausing it goes down to the child, and a child is not started deeper than the limits
// of the tree allow.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, requests, stub, tempHome, testClock, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { workflow } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const ofRun = (records: readonly StoredRecord[], type: string, run: string): StoredRecord[] =>
  ofType(records, type).filter((row) => (row.data as { run?: string }).run === run);

async function setup() {
  const home = await tempHome();
  homes.push(home);
  const aborted: string[] = [];
  const calls: string[] = [];
  const clock = testClock(1_700_000_000_000);
  const niwa = createNiwa({ home: home.path, clock });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(stub(home.path));
  niwa.use(
    plugin("tree", (api) => {
      api.action(
        action("tree.hang", {
          description: "Runs until it is aborted.",
          input: z.object({ name: z.string() }),
          output: z.object({ name: z.string() }),
          recovery: "do-not-repeat",
          effect: "write",
          run: ({ name }, ctx) =>
            new Promise((_resolve, reject) => {
              calls.push(name);
              ctx.signal?.addEventListener("abort", () => {
                aborted.push(name);
                reject(new Error("aborted"));
              });
            }),
        }),
      );
      api.action(
        action("tree.work", {
          description: "Answers at once.",
          input: z.object({ name: z.string() }),
          output: z.object({ name: z.string() }),
          recovery: "repeat",
          effect: "write",
          run: async ({ name }) => {
            calls.push(name);
            return { name };
          },
        }),
      );
    }),
  );
  niwa.use(workflow());
  await niwa.serve();
  hosts.push(niwa);
  let files = 0;
  const write = async (source: string): Promise<string> => {
    const file = join(home.path, `script-${String((files += 1))}.js`);
    await writeFile(file, source);
    return file;
  };
  const call = <T>(name: string, input: unknown): Promise<T> => niwa.call(name as ActionName, input as never) as Promise<T>;
  return {
    niwa,
    clock,
    aborted,
    calls,
    records: (): Promise<StoredRecord[]> => niwa.records.read(),
    call,
    start: async (source: string, extra: Record<string, unknown> = {}): Promise<string> =>
      (await call<{ run: string }>("workflow.start", { file: await write(source), ...extra })).run,
    register: async (source: string): Promise<string> => (await call<{ id: string }>("workflow.register", { file: await write(source) })).id,
  };
}

test("the owner stops one branch of a running scope: its steps end as cancelled, and the run goes on to its end", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("work", undefined, async (s) => {
      s.start("stuck", () => niwa.tree.hang({ name: "stuck" }));
      s.start("waiting", async () => { await wait("stub.finished", { filter: { id: "go" } }); return "went"; });
      return await s.rest();
    });
  });`);
  await eventually(() => t.calls.includes("stuck"), 10_000, "the branch should start");
  await t.call("workflow.stop", { run, at: "@work.stuck" });
  // The run is not over: the other branch still waits.
  await eventually(async () => ofType(await t.records(), "workflow.scope.settled").length === 1, 10_000, "the stopped branch should end");
  expect(ofRun(await t.records(), "workflow.run.finished", run)).toEqual([]);
  await t.call("stub.finish", { id: "go" });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", run).length > 0, 10_000, "the run should finish");
  const finished = ofRun(await t.records(), "workflow.run.finished", run)[0]?.data as { outcome: { status: string; result: unknown } };
  expect(finished.outcome).toEqual({
    status: "done",
    result: { stuck: { ok: false, error: { name: "Cancelled", message: "stopped by the owner" } }, waiting: { ok: true, value: "went" } },
  });
  expect(t.aborted).toEqual(["stuck"]);
}, 30_000);

test("a stop of a waiting run ends the wait of the branch it names, and the run goes on", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("w", undefined, async (s) => {
      s.start("never", () => wait("stub.finished", { filter: { id: "never" } }));
      return await s.rest();
    });
  });`);
  await eventually(
    async () => ofType(await t.records(), "niwa.invocation.state").some((row) => (row.data as { state: string }).state === "waiting"),
    10_000,
    "the run should wait",
  );
  await t.call("workflow.stop", { run, at: "@w.never", reason: "not needed" });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", run).length > 0, 10_000, "the run should finish");
  const finished = ofRun(await t.records(), "workflow.run.finished", run)[0]?.data as { outcome: { result: unknown } };
  expect(finished.outcome.result).toEqual({ never: { ok: false, error: { name: "Cancelled", message: "not needed" } } });
}, 30_000);

test("a stop of a branch whose wait is suspended while another branch works takes hold when the run comes to wait", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("both", undefined, async (s) => {
      s.start("waits", () => wait("stub.finished", { filter: { id: "never" } }));
      s.start("works", async () => { await niwa.tree.work({ name: "before" }); await new Promise((r) => setTimeout(r, 300)); return niwa.tree.work({ name: "after" }); });
      return await s.rest();
    });
  });`);
  await eventually(() => t.calls.includes("before"), 10_000, "the working branch should start");
  await eventually(
    async () => ofType(await t.records(), "niwa.step.intent").some((row) => (row.data as { key: string }).key === "@both.waits.call-1"),
    10_000,
    "the wait should begin",
  );
  await t.call("workflow.stop", { run, at: "@both.waits" });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", run).length > 0, 10_000, "the run should finish");
  const finished = ofRun(await t.records(), "workflow.run.finished", run)[0]?.data as { outcome: { result: unknown } };
  expect(finished.outcome.result).toEqual({
    waits: { ok: false, error: { name: "Cancelled", message: "stopped by the owner" } },
    works: { ok: true, value: { name: "after" } },
  });
}, 30_000);

test("a stop spares a shielded scope under it, and a forced stop goes through the shield", async () => {
  const t = await setup();
  const source = (name: string) => `export default workflow({ output: z.json() }, async () => {
    return await scope("outer", undefined, async (s) => {
      s.start("guarded", () => scope("safe", { shield: true }, async () => {
        try { await niwa.tree.hang({ name: "${name}" }); return "not stopped"; } catch (error) { return error.name; }
      }));
      return await s.rest();
    });
  });`;
  const spared = await t.start(source("spared"));
  await eventually(() => t.calls.includes("spared"), 10_000, "the shielded block should start");
  await t.call("workflow.stop", { run: spared, at: "@outer.guarded" });
  await Bun.sleep(100);
  expect(t.aborted).toEqual([]);
  expect(ofRun(await t.records(), "workflow.run.finished", spared)).toEqual([]);
  await t.call("workflow.stop", { run: spared, at: "@outer.guarded", force: true });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", spared).length > 0, 10_000, "the run should finish");
  expect(t.aborted).toEqual(["spared"]);
  const finished = ofRun(await t.records(), "workflow.run.finished", spared)[0]?.data as { outcome: { result: unknown } };
  expect(finished.outcome.result).toEqual({ guarded: { ok: true, value: "StepCancelled" } });
}, 30_000);

test("a run a branch starts is its child: stopping the branch ends the child, and the child knows its parent", async () => {
  const t = await setup();
  const child = await t.register(`export default workflow({ description: "a child that hangs", input: z.object({}), output: z.json() }, async () => {
    await niwa.tree.hang({ name: "child-work" });
    return "child done";
  });`);
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("kids", undefined, async (s) => {
      s.run("one", { id: "${child}", args: {} });
      return await s.rest();
    });
  });`);
  await eventually(() => t.calls.includes("child-work"), 10_000, "the child should start");
  const requested = ofType(await t.records(), "workflow.run.requested").map((row) => row.data as { run: string; parent?: { run: string; step: string } });
  const childRun = requested.find((one) => one.parent?.run === run);
  expect(childRun?.parent?.step).toContain("@kids.one.call-1");
  await t.call("workflow.stop", { run, at: "@kids.one" });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", run).length > 0, 10_000, "the parent should finish");
  const childEnd = ofRun(await t.records(), "workflow.run.finished", childRun?.run ?? "")[0]?.data as { outcome: { status: string } } | undefined;
  expect(childEnd?.outcome.status).toBe("cancelled");
}, 30_000);

test("cancelling a run cancels its child runs, pausing it pauses them, and the limits of a tree refuse a child too deep", async () => {
  const t = await setup();
  const child = await t.register(`export default workflow({ description: "a child that hangs", input: z.object({}), output: z.json() }, async () => {
    await niwa.tree.hang({ name: "deep-work" });
    return "child done";
  });`);
  const parentSource = `export default workflow({ output: z.json() }, async () => {
    return await niwa.flow["${child}"]({});
  });`;
  const run = await t.start(parentSource);
  await eventually(() => t.calls.includes("deep-work"), 10_000, "the child should start");
  const childRun = ofType(await t.records(), "workflow.run.requested")
    .map((row) => row.data as { run: string; parent?: { run: string } })
    .find((one) => one.parent?.run === run)?.run;
  expect(childRun).toBeDefined();
  await t.call("workflow.pause", { run });
  expect(ofRun(await t.records(), "workflow.run.pause-requested", childRun ?? "").length).toBe(1);
  await t.call("workflow.cancel", { run });
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", childRun ?? "").length > 0, 10_000, "the child should end");

  // A tree that may be one deep: the run may not start a child.
  const shallow = await t.start(parentSource, { limits: { depth: 1 } });
  await eventually(async () => ofRun(await t.records(), "workflow.run.paused", shallow).length > 0, 10_000, "the parent should pause");
  const refusal = ofType(await t.records(), "niwa.step.outcome")
    .map((row) => row.data as { outcome: { status: string; error?: string } })
    .find((row) => row.outcome.error?.includes("deep") === true);
  expect(refusal?.outcome.error).toContain("would be 2 deep in its tree, and its limits allow 1");
}, 30_000);

test("a child run's deadline comes no later than its parent's", async () => {
  const t = await setup();
  const child = await t.register(`export default workflow({ description: "a child that hangs", input: z.object({}), output: z.json() }, async () => {
    await niwa.tree.hang({ name: "child-work" });
    return "child done";
  });`);
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    await sleep("10s");
    return await niwa.flow["${child}"]({});
  });`, { limits: { deadline: 60_000 } });
  // The child starts ten seconds into its parent: its own minute would end after the parent's.
  await eventually(async () => ofType(await t.records(), "timer.sleep.requested").length === 1, 10_000, "the sleep should be armed");
  await t.clock.advance(10_000);
  await eventually(() => t.calls.includes("child-work"), 10_000, "the child should start");
  const requested = ofType(await t.records(), "workflow.run.requested").map((row) => row.data as { run: string; deadline?: number; parent?: { run: string } });
  const parent = requested.find((one) => one.run === run);
  const childRun = requested.find((one) => one.parent?.run === run);
  expect(parent?.deadline).toBe(1_700_000_000_000 + 60_000);
  expect(childRun?.deadline).toBe(parent?.deadline);
}, 30_000);

test("a branch runs a registered workflow that takes no input as its child", async () => {
  const t = await setup();
  const child = await t.register(`export default workflow({ description: "a child with no input", output: z.string() }, async () => {
    await niwa.tree.work({ name: "plain-child" });
    return "child done";
  });`);
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("kids", undefined, async (s) => {
      const one = s.run("one", { id: "${child}" });
      return await one.value();
    });
  });`);
  await eventually(async () => ofRun(await t.records(), "workflow.run.finished", run).length > 0, 10_000, "the parent should finish");
  const finished = ofRun(await t.records(), "workflow.run.finished", run)[0]?.data as { outcome: { status: string; result: unknown } };
  expect(finished.outcome).toEqual({ status: "done", result: "child done" });
}, 30_000);
