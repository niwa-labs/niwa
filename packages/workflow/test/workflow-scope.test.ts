// Scopes: groups of branches that never outlive their block.
//
// The host keeps a group: the branches that joined it, their outcomes in the order it committed
// them, and how it closed. Leaving the block waits for the branches or cancels them, a block that
// throws cancels them, a cancel goes down into the scopes inside except a shield, and a deadline
// cancels the scope on the clock of the host. The host is in this process and its clock is the
// test's, so a deadline is moved to and not waited for.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, requests, stub, tempHome, testClock, timers } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";

import { workflow } from "../src/index.ts";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** What the actions of the test saw: the calls by name, the most at once, and the calls that were aborted. */
interface Seen {
  calls: string[];
  active: number;
  most: number;
  aborted: string[];
}

/** The plugin of the test: `scope.work` takes a while and counts how many run at once, `scope.hang` runs until it is aborted. */
function work(seen: Seen) {
  return plugin("scope", (api) => {
    api.action(
      action("scope.work", {
        description: "Works for a few milliseconds.",
        input: z.object({ name: z.string(), ms: z.number().optional() }),
        output: z.object({ name: z.string() }),
        recovery: "repeat",
        effect: "write",
        run: async ({ name, ms }) => {
          seen.calls.push(name);
          seen.active += 1;
          seen.most = Math.max(seen.most, seen.active);
          await Bun.sleep(ms ?? 5);
          seen.active -= 1;
          return { name };
        },
      }),
    );
    api.action(
      action("scope.fail", {
        description: "Fails.",
        input: z.object({ name: z.string() }),
        output: z.object({ name: z.string() }),
        recovery: "repeat",
        effect: "write",
        run: async ({ name }) => {
          seen.calls.push(name);
          throw new Error("the work failed");
        },
      }),
    );
    api.action(
      action("scope.hang", {
        description: "Runs until it is aborted.",
        input: z.object({ name: z.string() }),
        output: z.object({ name: z.string() }),
        recovery: "do-not-repeat",
        effect: "write",
        run: ({ name }, ctx) =>
          new Promise((_resolve, reject) => {
            seen.calls.push(name);
            ctx.signal?.addEventListener("abort", () => {
              seen.aborted.push(name);
              reject(new Error("aborted"));
            });
          }),
      }),
    );
  });
}

async function hostOn(path: string, clock: TestClock, seen: Seen): Promise<Host> {
  const niwa = createNiwa({ home: path, clock });
  niwa.use(requests());
  niwa.use(timers([]));
  niwa.use(stub(path));
  niwa.use(work(seen));
  niwa.use(workflow());
  await niwa.serve();
  hosts.push(niwa);
  return niwa;
}

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);

/** A host and a home, and the way to run a script on them and read how it ended. */
async function setup() {
  const home = await tempHome();
  homes.push(home);
  const clock = testClock(START);
  const seen: Seen = { calls: [], active: 0, most: 0, aborted: [] };
  const niwa = await hostOn(home.path, clock, seen);
  const records = (): Promise<StoredRecord[]> => niwa.records.read();
  let scripts = 0;
  return {
    niwa,
    clock,
    seen,
    records,
    start: async (source: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const file = join(home.path, `script-${String((scripts += 1))}.js`);
      await writeFile(file, source);
      const started = (await niwa.call("workflow.start" as ActionName, { file, ...extra } as never)) as { run: string };
      return started.run;
    },
    ended: async (run: string): Promise<{ status: string; result?: unknown; error?: { message: string } }> => {
      await eventually(
        async () =>
          ofType(await records(), "workflow.run.finished").some((row) => (row.data as { run: string }).run === run) ||
          ofType(await records(), "workflow.run.paused").some((row) => (row.data as { run: string }).run === run),
        15_000,
        "the run should end",
      );
      const all = await records();
      const finished = ofType(all, "workflow.run.finished").find((row) => (row.data as { run: string }).run === run);
      if (finished !== undefined) return (finished.data as { outcome: { status: string; result?: unknown } }).outcome;
      const paused = ofType(all, "workflow.run.paused").find((row) => (row.data as { run: string }).run === run);
      return { status: "paused", error: { message: (paused?.data as { reason: string }).reason } };
    },
  };
}

test("a scope gives the outcomes of its branches in the order the host committed them, and the host keeps the group", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("probe", undefined, async (s) => {
      s.start("slow", () => niwa.scope.work({ name: "slow", ms: 60 }));
      s.start("fast", () => niwa.scope.work({ name: "fast", ms: 1 }));
      s.start("bad", async () => { throw new Error("no good"); });
      const order = [];
      for (let got = await s.next(); got !== null; got = await s.next()) order.push([got.key, got.result.ok]);
      return { order, rest: await s.rest(), path: s.path };
    });
  });`);
  const outcome = await t.ended(run);
  expect(outcome.status).toBe("done");
  const result = outcome.result as { order: Array<[string, boolean]>; rest: Record<string, unknown>; path: string[] };
  expect(result.order.map(([key]) => key).sort()).toEqual(["bad", "fast", "slow"]);
  expect(result.order.at(-1)).toEqual(["slow", true]);
  expect(result.rest).toEqual({
    slow: { ok: true, value: { name: "slow" } },
    fast: { ok: true, value: { name: "fast" } },
    bad: { ok: false, error: { name: "Error", message: "no good" } },
  });
  expect(result.path).toEqual(["probe"]);

  const all = await t.records();
  expect(ofType(all, "workflow.scope.opened").map((row) => row.data)).toEqual([{ run, scope: "@probe", onExit: "wait" }]);
  expect(ofType(all, "workflow.scope.branched").map((row) => (row.data as { key: string }).key)).toEqual(["slow", "fast", "bad"]);
  // The order of the commits is the order next() gave: the place of each outcome is written with it.
  const settled = ofType(all, "workflow.scope.settled").map((row) => row.data as { key: string; order: number; outcome: string });
  expect(settled.map(({ key, order }) => [key, order])).toEqual(result.order.map(([key], index) => [key, index]));
  expect(settled.find((one) => one.key === "bad")?.outcome).toBe("failed");
  expect(ofType(all, "workflow.scope.closed").map((row) => row.data)).toEqual([{ run, scope: "@probe", outcome: "done" }]);
  // Each branch joined the group before its first step: the record is written before the intent of its call.
  const joined = all.findIndex((row) => row.type === "workflow.scope.branched" && (row.data as { key: string }).key === "slow");
  const called = all.findIndex((row) => row.type === "niwa.step.intent" && (row.data as { key: string }).key === "@probe.slow.call-1");
  expect(joined).toBeGreaterThanOrEqual(0);
  expect(joined).toBeLessThan(called);
}, 30_000);

test("leaving a scope with onExit cancel cancels the branches left: their steps end as cancelled and their work is aborted", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("first", { onExit: "cancel" }, async (s) => {
      s.start("quick", () => niwa.scope.work({ name: "quick" }));
      const hung = s.start("hung", () => niwa.scope.hang({ name: "hung" }));
      const first = await s.next();
      return { first: first.key, hung: hung };
    }).then(async (out) => ({ first: out.first, hung: await out.hung.settled() }));
  });`);
  const outcome = await t.ended(run);
  expect(outcome.status).toBe("done");
  expect(outcome.result).toEqual({ first: "quick", hung: { ok: false, error: { name: "Cancelled", message: "the scope was left" } } });
  expect(t.seen.aborted).toEqual(["hung"]);
  const all = await t.records();
  const hungOutcome = ofType(all, "niwa.step.outcome").find((row) => (row.data as { key: string }).key === "@first.hung.call-1");
  expect((hungOutcome?.data as { outcome: unknown }).outcome).toEqual({ status: "cancelled", reason: "the scope was left" });
  expect(ofType(all, "workflow.scope.settled").find((row) => (row.data as { key: string }).key === "hung")?.data).toMatchObject({ outcome: "cancelled" });
}, 30_000);

test("a block that throws cancels its branches, and the error comes out of the scope once they ended", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    try {
      await scope("fails", undefined, async (s) => {
        s.start("hung", () => niwa.scope.hang({ name: "hung" }));
        await niwa.scope.work({ name: "block" });
        throw new Error("the block gave up");
      });
      return "not reached";
    } catch (error) {
      return error.message;
    }
  });`);
  const outcome = await t.ended(run);
  expect(outcome).toMatchObject({ status: "done", result: "the block gave up" });
  expect(t.seen.aborted).toEqual(["hung"]);
}, 30_000);

test("a cancel goes down into the scopes inside a branch, and a shield is waited for instead", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("outer", undefined, async (s) => {
      s.start("deep", () => scope("inner", undefined, async (inner) => {
        inner.start("hung", () => niwa.scope.hang({ name: "inner-hung" }));
        return await inner.rest();
      }));
      s.start("guarded", () => scope("safe", { shield: true }, async () => {
        await niwa.scope.work({ name: "shielded", ms: 40 });
        return "finished under the shield";
      }));
      await niwa.scope.work({ name: "block" });
      await s.cancel("enough");
      return await s.rest();
    });
  });`);
  const outcome = await t.ended(run);
  expect(outcome.status).toBe("done");
  const rest = outcome.result as Record<string, { ok: boolean; value?: unknown; error?: { name: string } }>;
  // The inner scope's branch was cancelled with its outer branch; the inner block gave its rest back.
  expect(rest.deep).toEqual({ ok: true, value: { hung: { ok: false, error: { name: "Cancelled", message: "enough" } } } });
  // The shielded block went on to its end.
  expect(rest.guarded).toEqual({ ok: true, value: "finished under the shield" });
  expect(t.seen.aborted).toEqual(["inner-hung"]);
  expect(t.seen.calls).toContain("shielded");
}, 30_000);

test("a deadline cancels the scope on the clock of the host: skip gives undefined, fail throws DeadlineExceeded", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    const skipped = await moveOnAfter("slow", "5m", () => niwa.scope.hang({ name: "slow" }));
    let failed = "no error";
    try {
      await failAfter("slower", "1m", () => niwa.scope.hang({ name: "slower" }));
    } catch (error) {
      failed = error.name;
    }
    return { skipped: skipped ?? "undefined", failed };
  });`);
  await eventually(() => t.seen.calls.includes("slow"), 10_000, "the first block should start");
  await t.clock.advance(5 * MINUTE - 1);
  expect(t.seen.aborted).toEqual([]);
  await t.clock.advance(1);
  await eventually(() => t.seen.calls.includes("slower"), 10_000, "the second block should start");
  await t.clock.advance(MINUTE);
  const outcome = await t.ended(run);
  expect(outcome).toEqual({ status: "done", result: { skipped: "undefined", failed: "DeadlineExceeded" } });
  expect(t.seen.aborted).toEqual(["slow", "slower"]);
  const closed = ofType(await t.records(), "workflow.scope.closed").map((row) => (row.data as { outcome: string }).outcome);
  expect(closed).toEqual(["deadline", "deadline"]);
}, 30_000);

test("a scope runs no more branches at once than its limit, and a start caps every scope of the run from outside", async () => {
  const t = await setup();
  const script = `export default workflow({ output: z.json() }, async () => {
    return await parallel({ a: () => niwa.scope.work({ name: "a", ms: 20 }), b: () => niwa.scope.work({ name: "b", ms: 20 }),
      c: () => niwa.scope.work({ name: "c", ms: 20 }), d: () => niwa.scope.work({ name: "d", ms: 20 }) }, { concurrency: 3 });
  });`;
  const first = await t.start(script);
  expect(await t.ended(first)).toEqual({
    status: "done",
    result: { a: { name: "a" }, b: { name: "b" }, c: { name: "c" }, d: { name: "d" } },
  });
  expect(t.seen.most).toBe(3);
  t.seen.most = 0;
  const second = await t.start(script, { concurrency: 1 });
  expect((await t.ended(second)).status).toBe("done");
  expect(t.seen.most).toBe(1);
}, 30_000);

test("the keys of branches and the names of scopes are refused before any step when they are empty, repeated or hold a mark", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    const refused = [];
    for (const key of ["", "a.b", "a~b", "a:b", "call-1"]) {
      try { await scope("k" + refused.length, undefined, async (s) => { s.start(key, () => 1); }); refused.push("taken"); }
      catch (error) { refused.push("refused"); }
    }
    try { await scope("twice", undefined, async (s) => { s.start("x", () => 1); s.start("x", () => 2); }); refused.push("taken"); }
    catch (error) { refused.push("refused"); }
    try { await scope("a.b", undefined, async () => 1); refused.push("taken"); } catch (error) { refused.push("refused"); }
    return refused;
  });`);
  expect(await t.ended(run)).toEqual({ status: "done", result: Array(7).fill("refused") });
  expect(t.seen.calls).toEqual([]);
}, 30_000);

test("a stream gives the outcomes one at a time and closing it cancels the rest; race gives the first branch that succeeds", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    const probes = stream("probe", { fast: () => niwa.scope.work({ name: "fast", ms: 1 }), stuck: () => niwa.scope.hang({ name: "stuck" }) });
    const first = await probes.next();
    await probes.close();
    const won = await race("pick", { broken: async () => { throw new Error("broken"); }, good: () => niwa.scope.work({ name: "good" }), hung: () => niwa.scope.hang({ name: "hung" }) });
    return { first: first.key, won };
  });`);
  expect(await t.ended(run)).toEqual({ status: "done", result: { first: "fast", won: { key: "good", value: { name: "good" } } } });
  expect(t.seen.aborted.sort()).toEqual(["hung", "stuck"]);
}, 30_000);

test("a branch that sleeps suspends the run while the block waits in next(), and the run goes on after the wake", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("nap", undefined, async (s) => {
      s.start("sleeper", async () => { await sleep("10m"); return "woke"; });
      s.start("quick", () => niwa.scope.work({ name: "quick" }));
      const first = await s.next();
      const second = await s.next();
      return Object.fromEntries([first, second].map((got) => [got.key, got.result.value]));
    });
  });`);
  await eventually(
    async () => ofType(await t.records(), "niwa.invocation.state").some((row) => (row.data as { state: string }).state === "waiting"),
    10_000,
    "the run should wait for the sleep",
  );
  await t.clock.advance(10 * MINUTE);
  expect(await t.ended(run)).toEqual({ status: "done", result: { quick: { name: "quick" }, sleeper: "woke" } });
  expect(t.seen.calls).toEqual(["quick"]);
}, 30_000);

test("after a wake the outcomes come in the order the script read them before, whichever branch ends first now", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("order", undefined, async (s) => {
      s.start("slow", () => niwa.scope.work({ name: "slow", ms: 300 }));
      // On the replay both calls answer from the journal at once: the pause makes "fast" end after "slow" there.
      s.start("fast", async () => { const done = await niwa.scope.work({ name: "fast", ms: 1 }); await new Promise((r) => setTimeout(r, 100)); return done; });
      const first = await s.next();
      await sleep("1m");
      const second = await s.next();
      return [first.key, second.key];
    });
  });`);
  await eventually(
    async () => ofType(await t.records(), "niwa.invocation.state").some((row) => (row.data as { state: string }).state === "waiting"),
    10_000,
    "the run should wait for the sleep",
  );
  await t.clock.advance(MINUTE);
  expect(await t.ended(run)).toEqual({ status: "done", result: ["fast", "slow"] });
  const settled = ofType(await t.records(), "workflow.scope.settled").map((row) => row.data as { key: string; order: number });
  expect(new Set(settled.map(({ key, order }) => `${key}:${String(order)}`))).toEqual(new Set(["fast:0", "slow:1"]));
}, 30_000);

test("a step of a branch that does not complete pauses the run: it is not an outcome of the branch, and nothing is cancelled for good", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("mixed", undefined, async (s) => {
      s.start("broken", () => niwa.scope.fail({ name: "broken" }));
      s.start("hung", () => niwa.scope.hang({ name: "hung" }));
      return await s.rest();
    });
  });`);
  const outcome = await t.ended(run);
  expect(outcome.status).toBe("paused");
  const all = await t.records();
  expect(ofType(all, "workflow.run.finished")).toEqual([]);
  expect((ofType(all, "workflow.run.paused")[0]?.data as { choices: string[] }).choices).toEqual(["retry", "skip", "cancel"]);
  expect(ofType(all, "niwa.step.cancelled")).toEqual([]);
  expect(ofType(all, "workflow.scope.settled")).toEqual([]);
}, 30_000);

test("a branch that waits does not stop the others: they go on and record their steps before the run waits", async () => {
  const t = await setup();
  await t.start(`export default workflow({ output: z.json() }, async () => {
    return await scope("apart", undefined, async (s) => {
      s.start("waits", () => wait("stub.finished", { filter: { id: "never" } }));
      s.start("works", async () => { await niwa.scope.work({ name: "first", ms: 50 }); return niwa.scope.work({ name: "second" }); });
      return await s.rest();
    });
  });`);
  await eventually(() => t.seen.calls.includes("second"), 10_000, "the working branch should go on");
  await eventually(
    async () => ofType(await t.records(), "niwa.invocation.state").at(-1)?.data !== undefined &&
      (ofType(await t.records(), "niwa.invocation.state").at(-1)?.data as { state: string }).state === "waiting",
    10_000,
    "the run should wait",
  );
  expect(ofType(await t.records(), "workflow.scope.settled").map((row) => (row.data as { key: string }).key)).toEqual(["works"]);
}, 30_000);

test("workflow.inspect lists the steps of scopes and of keyed parallel branches, with the branch each one is in", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    await scope("probe", undefined, async (s) => {
      s.start("slow", () => niwa.scope.work({ name: "slow" }));
      await niwa.scope.work({ name: "block" });
    });
    await parallel({ left: () => niwa.scope.work({ name: "left" }) });
    return null;
  });`);
  expect((await t.ended(run)).status).toBe("done");
  const inspected = (await t.niwa.call("workflow.inspect" as ActionName, { run } as never)) as { steps: Array<{ key: string; branch?: string }> };
  expect(inspected.steps.map((step) => [step.key, step.branch]).sort()).toEqual([
    ["@probe.call-1", "@probe"],
    ["@probe.slow.call-1", "@probe.slow"],
    ["p1.left.call-1", "p1.left"],
  ]);
}, 30_000);

test("a race of two waits ends when the first record arrives, and the wait that lost is cancelled", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    const won = await race("either", {
      a: async () => { await wait("stub.finished", { filter: { id: "a" } }); return "a"; },
      b: async () => { await wait("stub.finished", { filter: { id: "b" } }); return "b"; },
    });
    return won;
  });`);
  await eventually(
    async () => ofType(await t.records(), "niwa.invocation.state").at(-1)?.data !== undefined &&
      (ofType(await t.records(), "niwa.invocation.state").at(-1)?.data as { state: string }).state === "waiting",
    10_000,
    "the run should wait for both records",
  );
  await t.niwa.call("stub.finish" as ActionName, { id: "b" } as never);
  expect(await t.ended(run)).toEqual({ status: "done", result: { key: "b", value: "b" } });
  const settled = ofType(await t.records(), "workflow.scope.settled").map((row) => row.data as { key: string; outcome: string });
  expect(settled.map(({ key, outcome }) => `${key}:${outcome}`).sort()).toEqual(["a:cancelled", "b:done"]);
}, 30_000);

test("next() over a stream of waits gives the first record to arrive, and closing the stream cancels the wait left", async () => {
  const t = await setup();
  const run = await t.start(`export default workflow({ output: z.json() }, async () => {
    const either = stream("either", {
      a: () => wait("stub.finished", { filter: { id: "a" } }),
      b: () => wait("stub.finished", { filter: { id: "b" }, timeout: "1h" }),
    });
    const first = await either.next();
    await either.close();
    return first.key;
  });`);
  await eventually(
    async () => (ofType(await t.records(), "niwa.invocation.state").at(-1)?.data as { state: string } | undefined)?.state === "waiting",
    10_000,
    "the run should wait for both records",
  );
  await t.niwa.call("stub.finish" as ActionName, { id: "a" } as never);
  expect(await t.ended(run)).toEqual({ status: "done", result: "a" });
  const settled = ofType(await t.records(), "workflow.scope.settled").map((row) => row.data as { key: string; outcome: string });
  expect(settled.map(({ key, outcome }) => `${key}:${outcome}`).sort()).toEqual(["a:done", "b:cancelled"]);
}, 30_000);
