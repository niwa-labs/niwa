// The steps of an invocation, against the real journal: how one step is admitted, what a denial
// leaves behind, which recovery contract judges a call that was cut off, and what a replay gives back.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { CORE_TYPES, action, deny, recordId, streamId, record } from "../src/index.ts";
import type { Action, HandlerId, InvocationId, NewRecord, Recovery, StoredRecord } from "../src/index.ts";
import { NO_INTERCEPTS, openJournal, runInvocation } from "../src/journal.ts";
import type { InvocationSpec, Intercepts, RunResult, RunnerDeps } from "../src/journal.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

const Note = record("step.note", z.object({ at: z.coerce.date() }));
const INVOCATION = "inv:step/start:rec-wake" as InvocationId;

type Handle = (data: unknown, step: Parameters<InvocationSpec["handler"]>[1]) => Promise<void>;

/** A journal with one waking record, and the runs of handlers over it. */
async function bench(options: { intercepts?: Intercepts } = {}) {
  const path = await mkdtemp(join(tmpdir(), "niwa-step-test-"));
  homes.push(path);
  const journal = openJournal(path);
  const wake = journal.append({
    id: recordId("rec-wake"),
    stream: streamId("test"),
    type: Note.name,
    schema: 1,
    data: {},
    actor: { kind: "host" },
    cause: null,
    root: recordId("rec-wake"),
  });
  /** Decides which writes are refused: the test's way to cut a run off. */
  let refuse: ((recs: NewRecord[]) => boolean) | undefined;
  const deps: RunnerDeps = {
    journal,
    now: () => 0,
    append: (recs) => {
      if (refuse?.(recs) === true) throw new Error("cut off");
      return journal.appendMany(recs);
    },
    appendAll: (entries) => journal.appendAll(entries),
    resolveAction: () => undefined,
    interceptsOf: () => options.intercepts ?? NO_INTERCEPTS,
    emit: () => Promise.reject(new Error("no emit in this test")),
  };
  const spec = (handler: Handle): InvocationSpec => ({
    id: INVOCATION,
    handlerId: "step/start" as HandlerId,
    record: wake,
    parse: (data) => data,
    handler: async (data, step) => handler(data, step),
  });
  return {
    journal,
    /** Run the handler once more over the same journal; a refused write ends the run as a throw. */
    run: async (handler: Handle): Promise<RunResult | "cut off"> => {
      try {
        return await runInvocation(deps, spec(handler));
      } catch (error) {
        if (error instanceof Error && error.message === "cut off") return "cut off";
        throw error;
      }
    },
    cutOffWhen: (when: ((recs: NewRecord[]) => boolean) | undefined) => {
      refuse = when;
    },
    close: () => journal.close(),
    records: (type: string): StoredRecord[] => journal.find({ type: type as never }),
    lastState: (): { state: string; reason?: string } | undefined =>
      journal.find({ type: CORE_TYPES.invocationState }).at(-1)?.data as { state: string; reason?: string } | undefined,
  };
}

/** An action that counts its runs. */
function counted<O>(
  name: string,
  recovery: Recovery,
  output: z.ZodType<O>,
  result: () => unknown,
  extra: { delay?: number; check?: Action<unknown, O>["check"] } = {},
) {
  const calls = { count: 0 };
  const made = action(name, {
    description: "counts its runs",
    input: z.object({ n: z.number().optional() }),
    output,
    recovery,
    ...(extra.check === undefined ? {} : { check: extra.check }),
    run: async () => {
      calls.count += 1;
      if (extra.delay !== undefined) await Bun.sleep(extra.delay);
      return result() as O;
    },
  });
  return { made, calls };
}

const Any = z.object({ n: z.number() });
const writesOf = (type: string) => (recs: NewRecord[]) => recs.some((rec) => rec.type === type);

test("two calls under one key at the same time enter the action once", async () => {
  const b = await bench();
  const { made, calls } = counted("step.slow", "do-not-repeat", Any, () => ({ n: 7 }), { delay: 20 });
  const got: unknown[] = [];
  await b.run(async (_data, step) => {
    got.push(...(await Promise.all([step(made, { n: 1 }, { key: "k" }), step(made, { n: 1 }, { key: "k" })])));
  });
  expect(calls.count).toBe(1);
  expect(got).toEqual([{ n: 7 }, { n: 7 }]);
  expect(b.records(CORE_TYPES.stepIntent)).toHaveLength(1);
  b.close();
});


test("another call under a key that is being run is judged by what the first one recorded", async () => {
  const b = await bench();
  const { made, calls } = counted("step.slow", "do-not-repeat", Any, () => ({ n: 7 }), { delay: 20 });
  let second: unknown;
  await b.run(async (_data, step) => {
    const settled = await Promise.allSettled([step(made, { n: 1 }, { key: "k" }), step(made, { n: 2 }, { key: "k" })]);
    second = settled[1]?.status;
  });
  expect(calls.count).toBe(1);
  expect(second).toBe("rejected");
  expect(b.lastState()).toMatchObject({ state: "paused" });
  expect(b.lastState()?.reason).toContain("another input");
  b.close();
});


test("a denied step is written whole or not at all, so a restart never finds it cut off", async () => {
  const seen: unknown[] = [];
  for (let writes = 0; writes <= 3; writes++) {
    const b = await bench({ intercepts: { adjusts: [], guards: [() => deny("not now")] } });
    const { made, calls } = counted("step.send", "do-not-repeat", Any, () => ({ n: 1 }));
    // The run is cut off after `writes` writes of step records, then the host starts again.
    let written = 0;
    b.cutOffWhen((recs) => {
      if (!recs.some((rec) => rec.type.startsWith("niwa.step."))) return false;
      written += 1;
      return written > writes;
    });
    const handler: Handle = async (_data, step) => {
      await step(made, {});
    };
    await b.run(handler);
    b.cutOffWhen(undefined);
    await b.run(handler);
    const outcome = b.records(CORE_TYPES.stepOutcome).map((rec) => (rec.data as { outcome: { status: string } }).outcome.status);
    seen.push({ writes, calls: calls.count, outcome, reason: b.lastState()?.reason });
    b.close();
  }
  const denied = { calls: 0, outcome: ["denied"], reason: "step 1: denied" };
  expect(seen).toEqual([0, 1, 2, 3].map((writes) => ({ writes, ...denied })));
});


test("a cut-off call is judged by the recovery contract it was made under", async () => {
  for (const [was, now, repeated] of [
    ["do-not-repeat", "repeat", false],
    ["repeat", "do-not-repeat", true],
  ] as const) {
    const b = await bench();
    const before = counted("step.effect", was, Any, () => ({ n: 1 }));
    // The effect happens, and the outcome is never written.
    b.cutOffWhen(writesOf(CORE_TYPES.stepOutcome));
    expect(await b.run((_data, step) => step(before.made, {}).then(() => undefined))).toBe("cut off");
    b.cutOffWhen(undefined);
    // The code declares the action again, with another contract.
    const after = counted("step.effect", now, Any, () => ({ n: 2 }));
    await b.run((_data, step) => step(after.made, {}).then(() => undefined));
    expect(before.calls.count).toBe(1);
    expect(after.calls.count).toBe(repeated ? 1 : 0);
    expect(b.lastState()?.reason).toBe(repeated ? undefined : "step 1: unknown");
    b.close();
  }
});


test("a cut-off call whose intent holds no contract is not repeated", async () => {
  const b = await bench();
  const { made, calls } = counted("step.effect", "repeat", Any, () => ({ n: 1 }));
  b.journal.append({
    id: recordId(`${INVOCATION}/step/1/intent`),
    stream: streamId(`invocation:${INVOCATION}`),
    type: CORE_TYPES.stepIntent,
    schema: 1,
    data: { invocation: INVOCATION, key: "1", action: "step.effect", input: {}, operationId: `${INVOCATION}/1` },
    actor: { kind: "host" },
    cause: recordId("rec-wake"),
    root: recordId("rec-wake"),
  });
  await b.run((_data, step) => step(made, {}).then(() => undefined));
  expect(calls.count).toBe(0);
  expect(b.lastState()?.reason).toBe("step 1: unknown");
  b.close();
});

