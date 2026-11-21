// The cancel of steps: a record that says which keys of an invocation are given up. A step under
// it is not called, a call of it in flight is cut short through its signal, and a step that ended
// before keeps its outcome. The cancelled outcome is recorded, so a replay throws the same cancel.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { CORE_TYPES, StepCancelled, action, cancelHolds, record, recordId, streamId } from "../src/index.ts";
import type { HandlerId, InvocationId, StepsCancelled, StoredRecord } from "../src/index.ts";
import { NO_INTERCEPTS, abortSteps, openJournal, runInvocation } from "../src/journal.ts";
import type { InvocationSpec, RunResult, RunnerDeps } from "../src/journal.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

const Wake = record("cancel.wake", z.object({}));
const Never = record("cancel.never", z.object({ id: z.string() }));
const INVOCATION = "inv:cancel/start:rec-wake" as InvocationId;

type Handle = (step: Parameters<InvocationSpec["handler"]>[1]) => Promise<void>;

async function bench() {
  const path = await mkdtemp(join(tmpdir(), "niwa-cancel-test-"));
  homes.push(path);
  const journal = openJournal(path);
  const wake = journal.append({
    id: recordId("rec-wake"),
    stream: streamId("test"),
    type: Wake.name,
    schema: 1,
    data: {},
    actor: { kind: "host" },
    cause: null,
    root: recordId("rec-wake"),
  });
  const deps: RunnerDeps = {
    journal,
    now: () => 0,
    append: (recs) => journal.appendMany(recs),
    appendAll: (entries) => journal.appendAll(entries),
    resolveAction: () => undefined,
    interceptsOf: () => NO_INTERCEPTS,
    emit: () => Promise.reject(new Error("no emit in this test")),
    admitEmit: (_caller, _type, data) => ({ data, version: 1 }),
  };
  let marks = 0;
  return {
    journal,
    run: (handler: Handle): Promise<RunResult> =>
      runInvocation(deps, {
        id: INVOCATION,
        handlerId: "cancel/start" as HandlerId,
        record: wake,
        parse: (data) => data,
        handler: async (_data, step) => handler(step),
      }),
    /** Write a cancel of steps, as the host does. */
    cancel: (prefixes: string[], reason: string, except?: string[]): StepsCancelled => {
      const cancel: StepsCancelled = { invocation: INVOCATION, prefixes, reason, ...(except === undefined ? {} : { except }) };
      marks += 1;
      journal.append({
        id: recordId(`cancel-${String(marks)}`),
        stream: streamId("test"),
        type: CORE_TYPES.stepCancelled,
        schema: 1,
        data: cancel,
        actor: { kind: "host" },
        cause: null,
        root: recordId(`cancel-${String(marks)}`),
      });
      return cancel;
    },
    outcomes: (): Array<{ key: string; outcome: { status: string; reason?: string } }> =>
      journal.find({ type: CORE_TYPES.stepOutcome }).map((row: StoredRecord) => row.data as { key: string; outcome: { status: string; reason?: string } }),
    lastState: () => journal.find({ type: CORE_TYPES.invocationState }).at(-1)?.data as { state: string } | undefined,
    close: () => journal.close(),
  };
}

function counted(name: string) {
  const calls = { count: 0 };
  const made = action(name, {
    description: "counts its runs",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "do-not-repeat",
    effect: "write",
    run: async ({ n }) => {
      calls.count += 1;
      return { n };
    },
  });
  return { made, calls };
}

test("a prefix holds its own key and the keys under it, not a key that only starts with it", () => {
  const cancel: StepsCancelled = { invocation: INVOCATION, prefixes: ["@s.a"], reason: "r", except: ["@s.a.@inner"] };
  expect(cancelHolds(cancel, "@s.a")).toBe(true);
  expect(cancelHolds(cancel, "@s.a.call-1")).toBe(true);
  expect(cancelHolds(cancel, "@s.a~auth")).toBe(true);
  expect(cancelHolds(cancel, "@s.ab.call-1")).toBe(false);
  expect(cancelHolds(cancel, "@s.a.@inner.x.call-1")).toBe(false);
});

test("a step under a cancel is not called: it is recorded cancelled and the code catches the cancel", async () => {
  const b = await bench();
  const { made, calls } = counted("cancel.count");
  b.cancel(["@s.a"], "the scope was left");
  const seen: unknown[] = [];
  const handler: Handle = async (step) => {
    seen.push(await step(made, { n: 1 }, { key: "@s.b.call-1" }));
    try {
      await step(made, { n: 2 }, { key: "@s.a.call-1" });
    } catch (error) {
      seen.push(error instanceof StepCancelled ? `cancelled: ${error.reason}` : error);
    }
  };
  expect(await b.run(handler)).toBe("done");
  expect(calls.count).toBe(1);
  expect(seen).toEqual([{ n: 1 }, "cancelled: the scope was left"]);
  expect(b.outcomes().find((row) => row.key === "@s.a.call-1")?.outcome).toEqual({ status: "cancelled", reason: "the scope was left" });

  // A replay throws the same cancel from the record and calls nothing.
  seen.length = 0;
  expect(await b.run(handler)).toBe("done");
  expect(calls.count).toBe(1);
  expect(seen).toEqual([{ n: 1 }, "cancelled: the scope was left"]);
  b.close();
});

test("a step that ended before the cancel keeps its outcome", async () => {
  const b = await bench();
  const { made, calls } = counted("cancel.count");
  const handler: Handle = async (step) => {
    await step(made, { n: 1 }, { key: "@s.a.call-1" });
  };
  expect(await b.run(handler)).toBe("done");
  b.cancel(["@s.a"], "too late");
  expect(await b.run(handler)).toBe("done");
  expect(calls.count).toBe(1);
  expect(b.outcomes().map((row) => row.outcome.status)).toEqual(["completed"]);
  b.close();
});

test("a call in flight is cut short through its signal, and what it returns later is not its outcome", async () => {
  const b = await bench();
  let signal: AbortSignal | undefined;
  let release: () => void = () => undefined;
  const slow = action("cancel.slow", {
    description: "waits until it is released",
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    recovery: "do-not-repeat",
    effect: "write",
    run: async (_input, ctx) => {
      signal = ctx.signal;
      await new Promise<void>((done) => {
        release = done;
      });
      return { done: true };
    },
  });
  let caught: unknown;
  const running = b.run(async (step) => {
    try {
      await step(slow, {}, { key: "@s.a.call-1" });
    } catch (error) {
      caught = error;
    }
  });
  while (signal === undefined) await Bun.sleep(1);
  expect(abortSteps({ invocation: INVOCATION, prefixes: ["@s.b"], reason: "another branch" })).toBe(0);
  expect(abortSteps({ invocation: INVOCATION, prefixes: ["@s"], reason: "stopped by the owner" })).toBe(1);
  expect(await running).toBe("done");
  expect(signal.aborted).toBe(true);
  expect(caught).toBeInstanceOf(StepCancelled);
  release();
  await Bun.sleep(5);
  expect(b.outcomes().map((row) => row.outcome)).toEqual([{ status: "cancelled", reason: "stopped by the owner" }]);
  b.close();
});

test("a wait under a cancel ends with the cancel, and the invocation does not wait for it", async () => {
  const b = await bench();
  const handler: Handle = async (step) => {
    try {
      await step.wait(Never, { key: "@s.a.wait", filter: { id: "x" } });
    } catch (error) {
      if (!(error instanceof StepCancelled)) throw error;
    }
  };
  expect(await b.run(handler)).toBe("waiting");
  b.cancel(["@s.a"], "deadline");
  expect(await b.run(handler)).toBe("done");
  expect(b.outcomes().map((row) => row.outcome)).toEqual([{ status: "cancelled", reason: "deadline" }]);
  b.close();
});

test("a call still in flight after its invocation suspended on another step is aborted all the same", async () => {
  const b = await bench();
  let signal: AbortSignal | undefined;
  const slow = action("cancel.slow", {
    description: "runs until it is aborted",
    input: z.object({}),
    output: z.object({}),
    recovery: "do-not-repeat",
    effect: "write",
    run: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        signal = ctx.signal;
        ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const handler: Handle = async (step) => {
    await Promise.all([step(slow, {}, { key: "a.call-1" }).catch(() => undefined), step.wait(Never, { key: "b.wait", filter: { id: "x" } })]);
  };
  expect(await b.run(handler)).toBe("waiting");
  expect(signal?.aborted).toBe(false);
  expect(abortSteps({ invocation: INVOCATION, prefixes: ["a"], reason: "left" })).toBe(1);
  expect(signal?.aborted).toBe(true);
  b.close();
});
