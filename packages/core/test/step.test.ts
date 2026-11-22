// The steps of an invocation, against the real journal: how one step is admitted, what a denial
// leaves behind, which recovery contract judges a call that was cut off, and what a replay gives back.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { ARTIFACT_THRESHOLD, CORE_TYPES, NotSent, action, deny, recordId, streamId, record } from "../src/index.ts";
import type { Action, ArtifactRef, ArtifactStore, HandlerId, InvocationId, NewRecord, Recovery, StoredRecord } from "../src/index.ts";
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
async function bench(options: { intercepts?: Intercepts; artifacts?: ArtifactStore } = {}) {
  const path = await mkdtemp(join(tmpdir(), "niwa-step-test-"));
  homes.push(path);
  let journal = openJournal(path);
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
    get journal() { return journal; },
    now: () => 0,
    append: (recs) => {
      if (refuse?.(recs) === true) throw new Error("cut off");
      return journal.appendMany(recs);
    },
    appendAll: (entries) => journal.appendAll(entries),
    resolveAction: () => undefined,
    interceptsOf: () => options.intercepts ?? NO_INTERCEPTS,
    emit: () => Promise.reject(new Error("no emit in this test")),
    admitEmit: () => { throw new Error("no emit in this test"); },
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
  };
  const spec = (handler: Handle): InvocationSpec => ({
    id: INVOCATION,
    handlerId: "step/start" as HandlerId,
    record: wake,
    parse: (data) => data,
    handler: async (data, step) => handler(data, step),
  });
  return {
    get journal() { return journal; },
    reopen: () => {
      journal.close();
      journal = openJournal(path);
    },
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
    effect: "write",
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


test("a replay gives back the output as its schema reads it, as the first run did", async () => {
  const b = await bench();
  const When = z.object({ at: z.coerce.date() });
  const { made } = counted("step.when", "repeat", When, () => ({ at: new Date(0) }));
  const kinds: string[] = [];
  const handler: Handle = async (_data, step) => {
    const got = (await step(made, {})) as z.infer<typeof When>;
    kinds.push(got.at instanceof Date ? "date" : typeof got.at);
  };
  await b.run(handler);
  await b.run(handler);
  expect(kinds).toEqual(["date", "date"]);
  b.close();
});


test("a replay of a recorded output that its schema no longer reads pauses the invocation", async () => {
  const b = await bench();
  const before = counted("step.out", "repeat", z.object({ n: z.number() }), () => ({ n: 1 }));
  await b.run((_data, step) => step(before.made, {}).then(() => undefined));
  const after = counted("step.out", "repeat", z.object({ n: z.string() }), () => ({ n: "1" }));
  expect(await b.run((_data, step) => step(after.made, {}).then(() => undefined))).toBe("paused");
  expect(b.lastState()?.reason).toContain("output schema");
  expect(after.calls.count).toBe(0);
  b.close();
});


test("a call that a check found complete gives its value as the output schema reads it", async () => {
  const b = await bench();
  const When = z.object({ at: z.coerce.date() });
  const { made } = counted("step.found", "do-not-repeat", When, () => ({ at: new Date(0) }), {
    check: () => Promise.resolve({ status: "completed", value: { at: "1970-01-01T00:00:00.000Z" } as never }),
  });
  b.cutOffWhen(writesOf(CORE_TYPES.stepOutcome));
  await b.run((_data, step) => step(made, {}).then(() => undefined));
  b.cutOffWhen(undefined);
  let got: unknown;
  await b.run(async (_data, step) => {
    got = await step(made, {});
  });
  expect((got as z.infer<typeof When>).at).toBeInstanceOf(Date);
  b.close();
});


test.each(["owner", "audit"] as const)("a recorded owner pause takes precedence over a sibling wait with %s first", async (first) => {
  let denied = true;
  const b = await bench({ intercepts: { adjusts: [], guards: [() => denied ? deny("not now") : undefined] } });
  const { made, calls } = counted("step.bind", "do-not-repeat", Any, () => ({ n: 1 }));
  const key = "@lane.owner.label:bind";
  const waitKey = "@lane.audit.label:sleep";
  const handler: Handle = async (_data, step) => {
    const owner = () => step(made, {}, { key });
    const audit = () => step.wait(Note, { key: waitKey });
    const ownerFirst = first === "owner";
    const started = ownerFirst ? owner() : audit();
    const [settledFirst] = await Promise.allSettled([started]);
    const [settledSecond] = await Promise.allSettled([ownerFirst ? audit() : owner()]);
    // The workflow runner drains sibling calls and passes the parked wait back to Core.
    const waited = ownerFirst ? settledSecond : settledFirst;
    if (waited.status === "rejected") throw waited.reason;
  };
  const paused = { state: "paused", key, reason: `step ${key}: denied`, choices: ["retry", "skip", "cancel"] };
  try {
    expect(await b.run(handler)).toBe("paused");
    expect(b.lastState()).toMatchObject(paused);

    b.reopen();
    denied = false;
    expect(await b.run(handler)).toBe("paused");
    expect(b.lastState()).toMatchObject(paused);
    expect(calls.count).toBe(0);

    b.journal.append({
      id: recordId("rec-retry"),
      stream: streamId("test"),
      type: CORE_TYPES.invocationResolved,
      schema: 1,
      data: { invocation: INVOCATION, key, choice: "retry", attempt: 0 },
      actor: { kind: "host" },
      cause: recordId("rec-wake"),
      root: recordId("rec-wake"),
    });
    expect(await b.run(handler)).toBe("waiting");
    expect(b.lastState()).toMatchObject({ state: "waiting" });
    expect(b.lastState()).not.toHaveProperty("key");
    expect(calls.count).toBe(1);
  } finally {
    b.close();
  }
});

test("a replayed wait gives back the record as its type reads it", async () => {
  const b = await bench();
  const kinds: string[] = [];
  const handler: Handle = async (_data, step) => {
    const got = await step.wait(Note);
    kinds.push(got.data.at instanceof Date ? "date" : typeof got.data.at);
  };
  expect(await b.run(handler)).toBe("waiting");
  b.journal.append({
    id: recordId("rec-note"),
    stream: streamId("test"),
    type: Note.name,
    schema: 1,
    data: { at: "1970-01-01T00:00:00.000Z" },
    actor: { kind: "host" },
    cause: null,
    root: recordId("rec-note"),
  });
  await b.run(handler);
  await b.run(handler);
  expect(kinds).toEqual(["date", "date"]);
  b.close();
});


test("an action that says nothing was sent fails its step with no effect possible; any other throw leaves one possible", async () => {
  const b = await bench();
  const refused = action("step.refused", {
    description: "fails before anything goes out",
    input: z.object({}),
    output: z.object({}),
    recovery: "do-not-repeat",
    effect: "write",
    run: async () => {
      throw new NotSent("the other side never got it");
    },
  });
  const broke = action("step.broke", {
    description: "fails after it may have gone out",
    input: z.object({}),
    output: z.object({}),
    recovery: "do-not-repeat",
    effect: "write",
    run: async () => {
      throw new Error("the line dropped");
    },
  });
  const got: unknown[] = [];
  await b.run(async (_data, step) => {
    got.push(await step.outcome(refused, {}, { key: "refused" }), await step.outcome(broke, {}, { key: "broke" }));
  });
  expect(got).toEqual([
    { status: "failed", error: "the other side never got it", effectPossible: false },
    { status: "failed", error: "the line dropped", effectPossible: true },
  ]);
  b.close();
});


/** An artifact store in memory: what it was given, by digest. */
function memoryArtifacts(): ArtifactStore & { kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array | string, type: string): ArtifactRef => {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(data).digest("hex")}`;
    kept.set(digest, data);
    return { digest, size: data.length, type };
  };
  return {
    kept,
    put,
    writer: () => {
      throw new Error("not written in parts here");
    },
    read: (ref) => {
      const found = kept.get(ref.digest);
      if (found === undefined) throw new Error(`no artifact ${ref.digest}`);
      return found;
    },
  };
}

test("a step whose value is larger than a record should hold keeps it as an artifact, and a replay reads it back", async () => {
  const artifacts = memoryArtifacts();
  const b = await bench({ artifacts });
  const Text = z.object({ text: z.string() });
  const text = "y".repeat(ARTIFACT_THRESHOLD + 1);
  const big = counted("step.big", "do-not-repeat", Text, () => ({ text }));
  const small = counted("step.small", "do-not-repeat", Text, () => ({ text: "short" }));
  const got: unknown[] = [];
  const handler: Handle = async (_data, step) => {
    got.push(await step(big.made, {}, { key: "big" }), await step(small.made, {}, { key: "small" }));
  };
  await b.run(handler);
  const [bigOutcome, smallOutcome] = b.records(CORE_TYPES.stepOutcome).map((row) => (row.data as { outcome: Record<string, unknown> }).outcome);
  expect(bigOutcome).toEqual({ status: "completed", artifact: { digest: expect.stringMatching(/^sha256:/), size: JSON.stringify({ text }).length, type: "application/json" } });
  expect(smallOutcome).toEqual({ status: "completed", value: { text: "short" } });
  expect(artifacts.kept.size).toBe(1);

  await b.run(handler);
  expect(big.calls.count).toBe(1);
  expect(got).toEqual([{ text }, { text: "short" }, { text }, { text: "short" }]);
  b.close();
});

test("a step records the class its call was decided under, not the most the action can be", async () => {
  const b = await bench();
  const ci = action("forge.ci.run", {
    description: "Runs CI on a ref.",
    input: z.object({ ref: z.string() }),
    output: z.object({ ok: z.boolean() }),
    recovery: "do-not-repeat",
    effect: "irreversible",
    classify: ({ ref }) => (ref === "main" ? "irreversible" : "write"),
    run: () => ({ ok: true }),
  });
  await b.run(async (_data, step) => {
    await step(ci, { ref: "feature/x" }, { key: "branch" });
    await step(ci, { ref: "main" }, { key: "main" });
  });
  const byKey = (type: string) => Object.fromEntries(b.records(type).map((row) => [(row.data as { key: string }).key, (row.data as { effect?: string }).effect]));
  expect(byKey(CORE_TYPES.stepDecision)).toEqual({ branch: "write", main: "irreversible" });
  expect(byKey(CORE_TYPES.stepIntent)).toEqual({ branch: "write", main: "irreversible" });
  b.close();
});
