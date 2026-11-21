// The adjusts of an intercept.
//
// The order is the contract: the requested input is validated; adjusts run in registration
// order; the resulting input is validated again; guards run against that final input.
//
// The second validation is not a formality. An adjust that changes the input in place — or that
// returns the very object it was given — has changed it, whether it says so or not. Each adjust
// gets its own deep copy of the input, so an adjust that changes its copy in place cannot change
// what the decision records as the requested input.

import { expect, test } from "bun:test";

import { action, CORE_TYPES, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

import { decide, newIntercepts } from "@niwa-labs/core/journal";

const CALLER = { kind: "host" } as const;

/** The runs of the action below: how many times its body was called. */
const runs: number[] = [];

/** The inputs the action below was called with. */
const seen: Array<{ n: number }> = [];

const Take = action("adjust.take", {
  description: "Takes a number that is not negative.",
  input: z.object({ n: z.number().int().min(0) }),
  output: z.object({ n: z.number() }),
  recovery: "repeat",
  run: (input) => {
    runs.push(input.n);
    seen.push(input);
    return input;
  },
});

const Start = record("adjust.start", z.object({}));
const Note = record("adjust.note", z.object({ status: z.string() }));

/** A host with a plugin, and the records it wrote. */
async function hosted(setup: Parameters<typeof plugin>[1]) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("adjust", setup));
  await niwa.serve();
  const written: StoredRecord[] = [];
  const watching = (async () => {
    for await (const rec of niwa.records.since()) written.push(rec);
  })().catch(() => undefined);
  return {
    niwa,
    home: home.path,
    records: (): StoredRecord[] => written,
    close: async () => {
      await niwa.close();
      await watching;
      await home.cleanup();
    },
  };
}

test("(a) an adjust that changes the input in place is refused: the input is validated again", async () => {
  const intercepts = newIntercepts();
  let guards = 0;
  intercepts.adjusts.push((input: { n: number }) => {
    input.n = -5;
  });
  intercepts.guards.push(() => {
    guards += 1;
  });

  const decision = await decide({ intercepts, action: Take, input: { n: 1 }, caller: CALLER });

  // The input was validated again, and it did not fit: the call is refused.
  expect(decision.kind).toBe("invalid");
  if (decision.kind !== "invalid") return;
  expect(decision.which).toBe("final");
  expect(decision.final).toEqual({ n: -5 });
  // The guard is asked about a valid input, so it was not asked at all.
  expect(guards).toBe(0);
  // The action did not run.
  expect(runs).toEqual([]);
});

test("(b) an adjust that returns the very object it changed in place is refused as well", async () => {
  const intercepts = newIntercepts();
  let guards = 0;
  intercepts.adjusts.push((input: { n: number }) => {
    input.n = -5;
    return input;
  });
  intercepts.guards.push(() => {
    guards += 1;
  });

  const decision = await decide({ intercepts, action: Take, input: { n: 1 }, caller: CALLER });

  expect(decision.kind).toBe("invalid");
  if (decision.kind !== "invalid") return;
  expect(decision.which).toBe("final");
  expect(decision.final).toEqual({ n: -5 });
  expect(guards).toBe(0);
  expect(runs).toEqual([]);
});

test("(c) an adjust that adds a key has it stripped before the action runs", async () => {
  const intercepts = newIntercepts();
  intercepts.adjusts.push((input: { n: number }) => ({ ...input, extra: "smuggled" }));

  const decision = await decide({ intercepts, action: Take, input: { n: 1 }, caller: CALLER });

  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  // The schema is the one the action was called with: a field it does not have is not there.
  expect(decision.final).toEqual({ n: 1 });
  expect(Object.hasOwn(decision.final, "extra")).toBe(false);
});

test("(d) inside an invocation, a call an adjust broke in place ends as failed", async () => {
  const h = await hosted((api) => {
    api.declare(Start, Note);
    api.action(Take);
    api.adjust(Take, (input) => {
      input.n = -5;
      return undefined;
    });
    api.on(Start, async (_data, step) => {
      const outcome = await step.outcome(Take, { n: 1 });
      await step.emit(Note, { status: outcome.status });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(
      () => h.records().some((rec) => rec.type === Note.name),
      10_000,
      "the invocation should have ended the step",
    );
    const note = h.records().find((rec) => rec.type === Note.name);
    expect(Note.schema.parse(note?.data).status).toBe("failed");
    // The outcome says the adjusted input did not fit its schema.
    const outcome = h.records().find((rec) => rec.type === CORE_TYPES.stepOutcome);
    const error = (outcome?.data as { outcome: { error?: string } }).outcome.error ?? "";
    expect(error).toContain("does not match its schema");
    // The action did not run.
    expect(runs).toEqual([]);
  } finally {
    await h.close();
  }
});

test("(e) the recorded decision holds the requested input as it was asked for", async () => {
  const h = await hosted((api) => {
    api.declare(Start, Note);
    api.action(Take);
    // The adjust changes the input in place, to a value that is still valid.
    api.adjust(Take, (input) => {
      input.n = 2;
      return undefined;
    });
    api.on(Start, async (_data, step) => {
      const outcome = await step.outcome(Take, { n: 1 });
      await step.emit(Note, { status: outcome.status });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(
      () => h.records().some((rec) => rec.type === CORE_TYPES.stepDecision),
      10_000,
      "the decision should be recorded",
    );
    const decision = h.records().find((rec) => rec.type === CORE_TYPES.stepDecision);
    const data = decision?.data as { requested: { n: number }; final: { n: number } };
    // The requested input is the one the caller asked for: the adjust's change is not in it.
    expect(data.requested).toEqual({ n: 1 });
    expect(data.final).toEqual({ n: 2 });
    // The action ran with the changed input.
    expect(runs).toEqual([2]);
  } finally {
    await h.close();
  }
});

test("each adjust gets its own copy, and the adjusts are a pipeline over the input", async () => {
  const intercepts = newIntercepts();
  const seenByAdjusts: number[] = [];
  intercepts.adjusts.push((input: { n: number }) => {
    seenByAdjusts.push(input.n);
    input.n = 2;
  });
  intercepts.adjusts.push((input: { n: number }) => {
    seenByAdjusts.push(input.n);
    input.n = 3;
  });

  const decision = await decide({ intercepts, action: Take, input: { n: 1 }, caller: CALLER });

  // The adjusts run in registration order, each on what the one before it left.
  expect(seenByAdjusts).toEqual([1, 2]);
  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  // The requested input is still the one the caller asked for: no adjust changed it.
  expect(decision.requested).toEqual({ n: 1 });
  expect(decision.final).toEqual({ n: 3 });
});

test("an adjust that changes the input in place does not change what is recorded as requested", async () => {
  const intercepts = newIntercepts();
  intercepts.adjusts.push((input: { n: number }) => {
    input.n = 2;
  });

  const decision = await decide({ intercepts, action: Take, input: { n: 1 }, caller: CALLER });

  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  // The copy the adjust changed is not the one the decision holds as the requested input.
  expect(decision.requested).toEqual({ n: 1 });
  expect(decision.final).toEqual({ n: 2 });
});

/** An action whose input holds a value that cannot be copied: a function, like a question's schema. */
const Holding = action("adjust.holding", {
  description: "Takes a number and something that cannot be cloned.",
  input: z.object({ n: z.number().int().min(0), held: z.custom<() => number>((v) => typeof v === "function") }),
  output: z.object({ n: z.number() }),
  recovery: "repeat",
  run: (input) => ({ n: input.n }),
});

test("an input that holds a value that cannot be cloned: a valid change in place stays out of requested", async () => {
  const intercepts = newIntercepts();
  intercepts.adjusts.push((input: { n: number }) => {
    input.n = 2;
  });
  const held = () => 7;

  const decision = await decide({ intercepts, action: Holding, input: { n: 1, held }, caller: CALLER });

  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  // The plain fields are copied although one field is not clonable.
  expect(decision.requested.n).toBe(1);
  expect(decision.final.n).toBe(2);
  // The value that cannot be copied is passed on as it is.
  expect(decision.final.held).toBe(held);
  expect(decision.requested.held).toBe(held);
});

test("an input that holds a value that cannot be cloned: a change in place is still validated", async () => {
  const intercepts = newIntercepts();
  let guards = 0;
  intercepts.adjusts.push((input: { n: number }) => {
    input.n = -5;
  });
  intercepts.guards.push(() => {
    guards += 1;
  });

  const decision = await decide({ intercepts, action: Holding, input: { n: 1, held: () => 7 }, caller: CALLER });

  expect(decision.kind).toBe("invalid");
  if (decision.kind !== "invalid") return;
  expect(decision.which).toBe("final");
  expect((decision.requested as { n: number }).n).toBe(1);
  expect(guards).toBe(0);
});

test("an instance of a class keeps its class, and nested plain data is copied around it", async () => {
  class Box {
    constructor(readonly n: number) {}
  }
  const Nested = action("adjust.nested", {
    description: "Takes a box and a list.",
    input: z.object({ box: z.instanceof(Box), list: z.array(z.object({ n: z.number() })) }),
    output: z.object({ ok: z.boolean() }),
    recovery: "repeat",
    run: () => ({ ok: true }),
  });
  const intercepts = newIntercepts();
  intercepts.adjusts.push((input: { box: Box; list: Array<{ n: number }> }) => {
    input.list[0]!.n = 9;
  });
  const box = new Box(1);

  const decision = await decide({ intercepts, action: Nested, input: { box, list: [{ n: 1 }] }, caller: CALLER });

  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  expect(decision.final.box).toBe(box);
  expect(decision.final.list).toEqual([{ n: 9 }]);
  expect(decision.requested.list).toEqual([{ n: 1 }]);
});

test("with no adjust, a schema whose output is not its input is not made to parse its own output", async () => {
  const Length = action("adjust.length", {
    description: "Takes text, and works with its length.",
    input: z.string().transform((text) => text.length),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    run: (n) => ({ n }),
  });
  const decision = await decide({ intercepts: newIntercepts(), action: Length, input: "four", caller: CALLER });

  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  expect(decision.final).toBe(4);
});
