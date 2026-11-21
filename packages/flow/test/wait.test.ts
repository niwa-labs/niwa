// Waiting in a real script: a gate of the owner never throws for a decline or a cancel and opens
// only on a choice; settle reads first, so what is settled already is not waited for, and wakes on
// a record after the position it read.

import { afterEach, expect, test } from "bun:test";

import { z } from "zod";

import { counter, eventually, gate, plugin, stub, stubAction, testClock } from "@niwa-labs/testing";
import type { TestClock } from "@niwa-labs/testing";

import { flowHost, resultOf } from "./support.ts";
import type { FlowHost } from "./support.ts";

const hosts: FlowHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

const GATE = `
  import { humanGate } from "@niwa-labs/flow";
  export default workflow({ output: z.json() }, async (): Promise<any> =>
    humanGate("ship", { summary: "Ship the release?", options: ["ship", "hold"], recommend: "hold", risk: "a user sees it" }));`;

test("a gate of the owner gives the choice, a decline, or a cancel as an outcome", async () => {
  const flow = await flowHost({});
  hosts.push(flow);

  const chosen = await flow.start(GATE);
  await flow.answer("ship");
  expect(resultOf(await flow.wait(chosen))).toEqual({ outcome: "chosen", choice: "ship" });

  const declined = await flow.start(GATE);
  await flow.answer("decline");
  expect(resultOf(await flow.wait(declined))).toEqual({ outcome: "declined" });

  const cancelled = await flow.start(GATE);
  await flow.cancelAsk();
  expect(resultOf(await flow.wait(cancelled))).toEqual({ outcome: "cancelled" });
}, 60_000);

/** A host whose `probe.read` counts its calls, beside the stub plugin whose `stub.finish` writes `stub.finished`. */
async function settleHost(packages?: readonly string[], clock?: TestClock): Promise<FlowHost> {
  const flow = await flowHost({}, {
    ...(clock === undefined ? {} : { clock }),
    ...(packages === undefined ? {} : { packages }),
    plugins: (home) => [
      stub(home),
      plugin("probe", (api) =>
        api.action(
          stubAction("probe.read", { home, input: z.object({}), output: z.object({ n: z.number() }), recovery: "repeat", effect: "read", result: () => ({ n: counter(home, "probe.read").count() }) }),
        ),
      ),
      plugin("slow", (api) => {
        for (const gated of ["slow.read", "block.read"]) {
          api.action(stubAction(gated, { home, input: z.object({}), output: z.object({ n: z.number() }), recovery: "repeat", effect: "read", gate: gated, result: () => ({ n: 0 }) }));
        }
      }
      ),
    ],
  });
  hosts.push(flow);
  return flow;
}

const SETTLE = (until: number) => `
  import { settle } from "@niwa-labs/flow";
  export default workflow({ output: z.json() }, async (): Promise<any> =>
    settle("finished", {
      on: { types: ["stub.finished"] },
      every: "1h",
      read: async () => (await call("probe.read", {})).n,
      done: (n) => n >= ${String(until)},
    }));`;

test("settle does not wait when the facts are settled already", async () => {
  const flow = await settleHost();
  expect(resultOf(await flow.run(SETTLE(1)))).toEqual({ facts: 1, outcome: "done" });
}, 30_000);

test("settle wakes on a record written after the position it read, and reads again", async () => {
  const flow = await settleHost();
  const run = await flow.start(SETTLE(2));
  await eventually(() => counter(flow.home, "probe.read").count() === 1, 15_000, "the facts should be read once");
  await flow.host.call("stub.finish" as never, { id: "t-1" } as never);
  expect(resultOf(await flow.wait(run))).toEqual({ facts: 2, outcome: "done" });
}, 30_000);

const SETTLE_BY_REFERENCE = `
  import { record } from "@niwa-labs/core";
  import { settle } from "@niwa-labs/flow";
  const StubFinished = record("stub.finished", z.object({ id: z.string() }));
  export default workflow({ output: z.json() }, async (): Promise<any> =>
    settle("finished", {
      on: { types: [StubFinished], filter: { id: "t-1" } },
      every: "1h",
      read: async () => (await call("probe.read", {})).n,
      done: (n) => n >= 2,
    }));`;

test("settle waits for a type named by reference as it waits for one named as text", async () => {
  const flow = await settleHost(["flow", "core"]);
  const run = await flow.start(SETTLE_BY_REFERENCE);
  await eventually(() => counter(flow.home, "probe.read").count() === 1, 15_000, "the facts should be read once");
  await flow.host.call("stub.finish" as never, { id: "t-2" } as never);
  await flow.host.call("stub.finish" as never, { id: "t-1" } as never);
  expect(resultOf(await flow.wait(run))).toEqual({ facts: 2, outcome: "done" });
}, 30_000);

const SETTLE_NAMED_READ = `
  import { settle } from "@niwa-labs/flow";
  export default workflow({ output: z.json() }, async (): Promise<any> =>
    settle("finished", {
      on: { types: ["stub.finished"] },
      every: "1h",
      read: async () => scope("read", undefined, async () => (await call("probe.read", {})).n),
      done: (n) => n >= 2,
    }));`;

test("settle reads again with a helper that opens a named scope in its read", async () => {
  const flow = await settleHost();
  const run = await flow.start(SETTLE_NAMED_READ);
  await eventually(() => counter(flow.home, "probe.read").count() === 1, 15_000, "the facts should be read once");
  await flow.host.call("stub.finish" as never, { id: "t-1" } as never);
  expect(resultOf(await flow.wait(run))).toEqual({ facts: 2, outcome: "done" });
}, 30_000);

test("settle past its deadline gives the facts it read, and the first read is not cut short by it", async () => {
  const clock = testClock();
  const flow = await settleHost(undefined, clock);
  const run = await flow.start(`
    import { settle } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      let reads = 0;
      return settle("finished", {
        on: { types: ["stub.finished"] },
        every: "1h",
        deadline: "1m",
        read: async () => { reads += 1; return (await call(reads === 1 ? "slow.read" : "block.read", {})).n; },
        done: (n) => n >= 1,
      });
    });`);
  await eventually(() => counter(flow.home, "slow.read").count() === 1, 15_000, "the first read should begin");
  await clock.advance(5 * 60_000);
  gate(flow.home, "slow.read").open();
  await eventually(async () => ((await flow.host.call("workflow.wait" as never, { run, timeoutMs: 200 } as never)) as { waiting?: string }).waiting === "wait stub.finished", 15_000, "the settle should wait for the record");
  await flow.host.call("stub.finish" as never, { id: "t-1" } as never);
  await eventually(() => counter(flow.home, "block.read").count() === 1, 15_000, "the second read should begin");
  await clock.advance(2 * 60_000);
  expect(resultOf(await flow.wait(run))).toEqual({ facts: 0, outcome: "timed-out" });
}, 60_000);
