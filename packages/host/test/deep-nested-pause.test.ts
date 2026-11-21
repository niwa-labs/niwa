// A pause two calls down: a handler calls "a", "a" calls
// "b", "b" calls "c", and "c" fails. The invocation pauses on the step of "c"; "a" and "b" are not
// failed, they are waiting for the decision. The owner's retry enters them again, "c" is called
// again, and the invocation ends with the answer.

import { expect, test } from "bun:test";

import { z } from "zod";

import { action, actionName, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome } from "@niwa-labs/testing";

const Start = record("deep.start", z.object({}));
const Answered = record("deep.answered", z.object({ value: z.number() }));

const A: ActionName = actionName("deep.a");
const B: ActionName = actionName("deep.b");
const C: ActionName = actionName("deep.c");

/** The host of the three calls; "c" fails while `state.failing`. */
function serve(path: string, state: { failing: boolean; calls: number }) {
  const niwa = createNiwa({ home: path });
  niwa.use(
    plugin("deep", (api) => {
      api.declare(Start, Answered);
      const io = { input: z.object({}), output: z.object({ value: z.number() }), recovery: "do-not-repeat" as const };
      api.action(action(C, { ...io, description: "c", run: async () => {
        state.calls += 1;
        if (state.failing) throw new Error("c is not ready");
        return { value: 3 };
      } }));
      // A skipped "c" gives nothing back, and "b" goes on with a value of its own.
      api.action(action(B, { ...io, description: "b", run: async (_input, ctx) => {
        const got = await ctx.step<unknown, { value: number } | undefined>(C, {});
        return { value: got?.value ?? -1 };
      } }));
      api.action(action(A, { ...io, description: "a", run: async (_input, ctx) => ctx.step(B, {}) }));
      api.on(Start, async (_data, step) => {
        const { value } = await step<unknown, { value: number }>(A, {});
        await step.emit(Answered, { value });
      });
    }),
  );
  return niwa;
}

const pausedOf = (records: StoredRecord[]) =>
  records.filter((stored) => stored.type === "niwa.invocation.state" && (stored.data as { state: string }).state === "paused");

async function open(niwa: ReturnType<typeof createNiwa>): Promise<StoredRecord[]> {
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const stored of niwa.records.since()) records.push(stored);
  })();
  return records;
}

test("a pause two calls down pauses every call above it, and the retry finishes them", async () => {
  const state = { failing: true, calls: 0 };
  const home = await tempHome();
  const niwa = serve(home.path, state);
  const records = await open(niwa);

  try {
    await niwa.emit(Start, {});
    const paused = () =>
      records.filter((stored) => stored.type === "niwa.invocation.state" && (stored.data as { state: string }).state === "paused");
    await eventually(() => paused().length === 1, 10_000, "the invocation did not pause");
    const pause = paused()[0]!.data as { invocation: string; key: string };
    expect(pause.key).toBe("1.step-1.step-1");
    // The calls above the one that failed have no outcome: they wait for the decision.
    const outcomes = records
      .filter((stored) => stored.type === "niwa.step.outcome")
      .map((stored) => (stored.data as { key: string }).key);
    expect(outcomes).toEqual(["1.step-1.step-1"]);

    state.failing = false;
    await niwa.call("niwa.invocation.resolve" as ActionName, { invocation: pause.invocation, choice: "retry" });
    await eventually(() => records.some((stored) => stored.type === Answered.name), 10_000, "the retry did not finish");
    expect(records.find((stored) => stored.type === Answered.name)?.data).toEqual({ value: 3 });
    expect(state.calls).toBe(2);
    expect(paused()).toHaveLength(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("the owner's skip two calls down lets the calls above it go on without the skipped one", async () => {
  const state = { failing: true, calls: 0 };
  const home = await tempHome();
  const niwa = serve(home.path, state);
  const records = await open(niwa);
  try {
    await niwa.emit(Start, {});
    await eventually(() => pausedOf(records).length === 1, 10_000, "the invocation did not pause");
    const pause = pausedOf(records)[0]!.data as { invocation: string };
    await niwa.call("niwa.invocation.resolve" as ActionName, { invocation: pause.invocation, choice: "skip" });
    await eventually(() => records.some((stored) => stored.type === Answered.name), 10_000, "the skip did not finish");
    expect(records.find((stored) => stored.type === Answered.name)?.data).toEqual({ value: -1 });
    expect(state.calls).toBe(1);
    expect(pausedOf(records)).toHaveLength(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("a pause two calls down survives a restart: the paused invocation is not run again, and the retry after it finishes", async () => {
  const state = { failing: true, calls: 0 };
  const home = await tempHome();
  const first = serve(home.path, state);
  const before = await open(first);
  let invocation = "";
  try {
    await first.emit(Start, {});
    await eventually(() => pausedOf(before).length === 1, 10_000, "the invocation did not pause");
    invocation = (pausedOf(before)[0]!.data as { invocation: string }).invocation;
  } finally {
    await first.close();
  }
  const second = serve(home.path, state);
  const after = await open(second);
  try {
    await eventually(() => after.some((stored) => stored.type === Start.name), 10_000, "the journal was not read");
    // Nothing runs on its own: still one call to "c", and no outcome written for "a" or "b".
    expect(state.calls).toBe(1);
    state.failing = false;
    await second.call("niwa.invocation.resolve" as ActionName, { invocation, choice: "retry" });
    await eventually(() => after.some((stored) => stored.type === Answered.name), 10_000, "the retry did not finish");
    expect(after.find((stored) => stored.type === Answered.name)?.data).toEqual({ value: 3 });
    expect(state.calls).toBe(2);
    const outcomes = after
      .filter((stored) => stored.type === "niwa.step.outcome")
      .map((stored) => (stored.data as { key: string }).key);
    // The calls above "c" end once each, and only now.
    expect(outcomes.filter((key) => key === "1")).toHaveLength(1);
    expect(outcomes.filter((key) => key === "1.step-1")).toHaveLength(1);
  } finally {
    await second.close();
    await home.cleanup();
  }
}, 30_000);
