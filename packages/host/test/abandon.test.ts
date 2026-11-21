// A handler that gives up its work: `step.abandon()` says the work is
// no longer wanted, so a step that does not complete after it pauses nothing and the invocation
// ends as done. A step that fails without it still pauses.

import { expect, test } from "bun:test";

import { z } from "zod";

import { action, actionName, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome } from "@niwa-labs/testing";

const Start = record("abandon.start", z.object({ abandon: z.boolean() }));
const FAIL: ActionName = actionName("abandon.fail");
const NEST: ActionName = actionName("abandon.nest");

const io = { input: z.object({}), output: z.object({}), recovery: "do-not-repeat" as const, effect: "write" as const };

/** The states the invocations were written in, in order. */
async function run(abandon: boolean, call: ActionName): Promise<string[]> {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("abandon", (api) => {
      api.declare(Start);
      api.action(action(FAIL, { ...io, description: "fails", run: async () => { throw new Error("no"); } }));
      api.action(action(NEST, { ...io, description: "calls a call that fails", run: async (_input, ctx) => ctx.step(FAIL, {}) }));
      api.on(Start, async (data, step) => {
        if (data.abandon) step.abandon();
        await step(call, {});
      });
    }),
  );
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const stored of niwa.records.since()) records.push(stored);
  })();
  try {
    await niwa.emit(Start, { abandon });
    const states = () =>
      records.filter((stored) => stored.type === "niwa.invocation.state").map((stored) => (stored.data as { state: string }).state);
    await eventually(() => states().some((state) => state !== "running"), 10_000, "the invocation did not end");
    return states();
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}

test("a failed step pauses the invocation, and after abandon it does not, whether it is the handler's or a nested one", async () => {
  expect(await run(false, FAIL)).toEqual(["running", "paused"]);
  expect(await run(true, FAIL)).toEqual(["running", "done"]);
  expect(await run(false, NEST)).toEqual(["running", "paused"]);
  expect(await run(true, NEST)).toEqual(["running", "done"]);
}, 30_000);
