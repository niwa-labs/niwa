// Guards of the invocation: step keys, a swallowed refusal of the journal, a retry of a wait.

import { expect, test } from "bun:test";

import { action, deny, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionContext, NewRecord, StoredRecord } from "@niwa-labs/core";
import type { StateHandle } from "@niwa-labs/plugin";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { runInvocation, NO_INTERCEPTS, openJournal } from "@niwa-labs/core/journal";
import type { InvocationSpec, RunnerDeps } from "@niwa-labs/core/journal";
import { CORE_TYPES, recordId, streamId } from "@niwa-labs/core";
import type { HandlerId, InvocationId } from "@niwa-labs/core";

const Start = record("guards.start", z.object({}));
const Note = record("guards.note", z.object({}));
const Other = record("guards.other", z.object({}));

const STATE_TYPE = "niwa.invocation.state";

type StateData = { invocation: string; state: string; reason?: string; choices?: string[] };

/** An in-process host with a plugin, and the states of its invocations as they are recorded. */
async function hosted(setup: Parameters<typeof plugin>[1]) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("guards", setup));
  await niwa.serve();
  const seen: StoredRecord[] = [];
  const watching = (async () => {
    for await (const rec of niwa.records.since(seq(0))) seen.push(rec);
  })();
  return {
    niwa,
    home: home.path,
    states: (): StateData[] =>
      seen.filter((r) => r.type === STATE_TYPE).map((r) => r.data as StateData),
    close: async () => {
      await niwa.close();
      await watching.catch(() => {});
      await home.cleanup();
    },
  };
}

test("a step key with a separator is refused at the call", async () => {
  for (const key of ["a/b", "a#2"]) {
    const h = await hosted((api) => {
      api.declare(Start);
      api.on(Start, async (_data, step) => {
        await step.now({ key });
      });
    });
    try {
      await h.niwa.emit(Start, {});
      await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "the key is refused");
      expect(h.states().at(-1)?.reason).toContain('step key must not contain "/" or "#"');
    } finally {
      await h.close();
    }
  }
});

test("a handler that swallows the refusal of the journal does not continue", async () => {
  const home = await tempHome();
  const journal = openJournal(home.path);
  const refuse = new Error("disk full");
  let refusing = false;
  const deps: RunnerDeps = {
    journal,
    now: () => Date.now(),
    append: (recs: NewRecord[]) => {
      if (refusing && recs.some((r) => r.type === CORE_TYPES.stepIntent)) throw refuse;
      return journal.appendMany(recs);
    },
    appendAll: (entries) => journal.appendAll(entries),
    resolveAction: () => undefined,
    interceptsOf: () => NO_INTERCEPTS,
    emit: () => Promise.reject(new Error("no emit in this test")),
  };
  const wake = journal.append({
    id: recordId("rec-wake"),
    stream: streamId("test"),
    type: Start.name,
    schema: 1,
    data: {},
    actor: { kind: "host" },
    cause: null,
    root: recordId("rec-wake"),
  });
  let after = 0;
  const send = action("guards.send", {
    description: "never runs",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    run: async () => ({}),
  });
  const spec: InvocationSpec = {
    id: "inv:guards/start:rec-wake" as InvocationId,
    handlerId: "guards/start" as HandlerId,
    record: wake,
    parse: (data) => data,
    handler: async (_data, step) => {
      try {
        await step(send, {});
      } catch {
        // swallowed
      }
      after += 1;
    },
  };
  try {
    refusing = true;
    await expect(runInvocation(deps, spec)).rejects.toBe(refuse);
    expect(after).toBe(1);
    const states = journal.find({ type: CORE_TYPES.invocationState }).map((r) => r.data);
    expect(states.some((d) => (d as StateData).state === "done")).toBe(false);
  } finally {
    journal.close();
    await home.cleanup();
  }
});

test("a wait step cannot be retried, only cancelled", async () => {
  let run = 0;
  const h = await hosted((api) => {
    api.declare(Start, Note, Other);
    api.on(Start, async (_data, step) => {
      run += 1;
      if (run === 1) await step.wait(Note, () => true, { key: "k" });
      else await step.wait(Other, () => true, { key: "k" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "run 1 waits");
    await h.niwa.emit(Note, {});
    await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "run 2 pauses");
    const invocation = h.states().at(-1)?.invocation ?? "";
    expect(h.states().at(-1)?.reason).toBe("replay mismatch at step k");
    // The pause offers what the core accepts for it: a wait is only cancelled.
    expect(h.states().at(-1)?.choices).toEqual(["cancel"]);
    for (const choice of ["retry", "skip"]) {
      await expect(
        h.niwa.call("niwa.invocation.resolve" as never, { invocation, choice } as never),
      ).rejects.toThrow("is a wait");
    }
    await h.niwa.call("niwa.invocation.resolve" as never, { invocation, choice: "cancel" } as never);
    await eventually(() => h.states().at(-1)?.state === "done", 10_000, "cancelled");
  } finally {
    await h.close();
  }
});

test("a pause on no step offers retry and cancel, and the core refuses a skip it does not offer", async () => {
  let run = 0;
  const h = await hosted((api) => {
    api.declare(Start);
    api.on(Start, async () => {
      run += 1;
      if (run === 1) throw new Error("boom");
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "the handler error pauses");
    const paused = h.states().at(-1);
    expect(paused).toMatchObject({ reason: "handler error: boom", choices: ["retry", "cancel"] });
    const invocation = paused?.invocation ?? "";
    await expect(
      h.niwa.call("niwa.invocation.resolve" as never, { invocation, choice: "skip" } as never),
    ).rejects.toThrow("does not offer skip");
    await h.niwa.call("niwa.invocation.resolve" as never, { invocation, choice: "retry" } as never);
    await eventually(() => h.states().at(-1)?.state === "done", 10_000, "the retry goes on");
  } finally {
    await h.close();
  }
});

test("the answer to a paused invocation is written by the caller who gave it", async () => {
  let run = 0;
  const h = await hosted((api) => {
    api.declare(Start, Note, Other);
    api.on(Start, async (_data, step) => {
      run += 1;
      if (run === 1) await step.wait(Note, () => true, { key: "k" });
      else await step.wait(Other, () => true, { key: "k" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "run 1 waits");
    await h.niwa.emit(Note, {});
    await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "run 2 pauses");
    const invocation = h.states().at(-1)?.invocation ?? "";
    const client = await connectAsOwner(h.home);
    try {
      await client.call("niwa.invocation.resolve" as never, { invocation, choice: "cancel" } as never);
      const resolved: StoredRecord[] = [];
      for await (const rec of client.records.since(seq(0), { type: "niwa.invocation.resolved" as never })) {
        resolved.push(rec);
        break;
      }
      expect(resolved[0]?.actor.kind).toBe("client");
    } finally {
      await client.close();
    }
  } finally {
    await h.close();
  }
});

test("a wake of a call waiting inside an action asks no guard again and writes nothing", async () => {
  const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
  let guards = 0;
  const ran: string[] = [];
  const ask = action("guards.ask", {
    description: "Waits for a good reply.",
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    recovery: "do-not-repeat",
    async run(input, ctx) {
      ran.push(input.text);
      await ctx.wait(Reply, (reply) => reply.ok);
      return input;
    },
  });
  const h = await hosted((api) => {
    api.declare(Start, Reply);
    api.action(ask);
    api.guard(ask, () => ((guards += 1) > 1 ? deny("asked again") : undefined));
    api.on(Start, async (_data, step) => {
      await step(ask, { text: "requested" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
    const before = (await h.niwa.records.read(seq(0))).filter((r) => r.stream.startsWith("invocation:")).length;

    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => ran.length === 2, 10_000, "the wake does not enter the call again");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await h.niwa.records.read(seq(0))).filter((r) => r.stream.startsWith("invocation:"))).toHaveLength(before);
    expect(guards).toBe(1);

    await h.niwa.emit(Reply, { ok: true });
    await eventually(() => h.states().at(-1)?.state === "done", 10_000, "the answer ends it");
    expect(ran).toEqual(["requested", "requested", "requested"]);
    expect(guards).toBe(1);
  } finally {
    await h.close();
  }
});

test("a waiting call whose adjust now decides otherwise is decided again, and a denial is recorded", async () => {
  const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
  let adjusts = 0;
  const ask = action("guards.ask", {
    description: "Waits for a good reply.",
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    recovery: "do-not-repeat",
    async run(input, ctx) {
      await ctx.wait(Reply, (reply) => reply.ok);
      return input;
    },
  });
  const h = await hosted((api) => {
    api.declare(Start, Reply);
    api.action(ask);
    api.adjust(ask, () => ({ text: `adjusted-${String((adjusts += 1))}` }));
    api.guard(ask, (input) => (input.text === "adjusted-1" ? undefined : deny("changed")));
    api.on(Start, async (_data, step) => {
      await step(ask, { text: "requested" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "the denial pauses it");
    const decisions = (await h.niwa.records.read(seq(0))).filter((r) => r.type === CORE_TYPES.stepDecision);
    expect(decisions.map((r) => (r.data as { denied: boolean; reason?: string }).reason)).toEqual([undefined, "changed"]);
  } finally {
    await h.close();
  }
});

/** The waiting action of the wake tests: it enters again on every reply, and `again` runs from the second entry on. */
function waitingAsk(entered: { count: number }, again: (ctx: ActionContext) => void | Promise<void>, Reply: ReturnType<typeof record<{ ok: boolean }>>) {
  return action("guards.ask", {
    description: "Waits for a good reply.",
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    recovery: "do-not-repeat",
    async run(input, ctx) {
      entered.count += 1;
      if (entered.count === 2) await again(ctx);
      await ctx.wait(Reply, (reply) => reply.ok);
      return input;
    },
  });
}

test("a re-decision that matches the latest recorded one is not recorded again", async () => {
  const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
  const entered = { count: 0 };
  let adjusts = 0;
  const ask = waitingAsk(entered, () => {}, Reply);
  const h = await hosted((api) => {
    api.declare(Start, Reply);
    api.action(ask);
    // The first call is adjusted to "a", every later one to "b": the decision changes once and settles.
    api.adjust(ask, () => ({ text: (adjusts += 1) === 1 ? "a" : "b" }));
    api.on(Start, async (_data, step) => {
      await step(ask, { text: "requested" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => entered.count === 2, 10_000, "the first wake");
    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => entered.count === 3, 10_000, "the second wake");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const decisions = (await h.niwa.records.read(seq(0))).filter((r) => r.type === CORE_TYPES.stepDecision);
    expect(decisions.map((r) => (r.data as { final: { text: string } }).final.text)).toEqual(["a", "b"]);
  } finally {
    await h.close();
  }
});

test("a guard that denies a waiting call on the same final input records the denial", async () => {
  const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
  const entered = { count: 0 };
  let guards = 0;
  const ask = waitingAsk(entered, () => {}, Reply);
  const h = await hosted((api) => {
    api.declare(Start, Reply);
    api.action(ask);
    // The adjust always gives the same final input, so only the guard's answer differs between wakes.
    api.adjust(ask, () => ({ text: "fixed" }));
    api.guard(ask, () => ((guards += 1) > 1 ? deny("not any more") : undefined));
    api.on(Start, async (_data, step) => {
      await step(ask, { text: "requested" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => h.states().at(-1)?.state === "paused", 10_000, "the denial pauses it");
    const decisions = (await h.niwa.records.read(seq(0))).filter((r) => r.type === CORE_TYPES.stepDecision);
    expect(decisions.map((r) => (r.data as { denied: boolean }).denied)).toEqual([false, true]);
  } finally {
    await h.close();
  }
});

for (const op of ["get", "set", "update", "take", "emit"] as const) {
  test(`a woken run that first writes with a state ${op} says running before that write, once`, async () => {
    const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
    const entered = { count: 0 };
    let box: StateHandle<number> | undefined;
    const ask = waitingAsk(
      entered,
      async (ctx) => {
        if (box === undefined) throw new Error("the plugin is not set up");
        if (op === "get") box.get();
        if (op === "set") box.set(1);
        if (op === "update") box.update((n) => n + 1);
        if (op === "take") box.take();
        if (op === "emit") await ctx.emit(Note, {});
      },
      Reply,
    );
    const h = await hosted((api) => {
      api.declare(Start, Reply, Note);
      api.action(ask);
      box = api.state("box", z.number(), 0);
      api.on(Start, async (_data, step) => {
        await step(ask, { text: "requested" });
      });
    });
    try {
      await h.niwa.emit(Start, {});
      await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
      await h.niwa.emit(Reply, { ok: false });
      await eventually(() => h.states().map((s) => s.state).join() === "running,waiting,running,waiting", 10_000, "the wake");
      const written = (await h.niwa.records.read(seq(0))).filter((r) =>
        [STATE_TYPE, CORE_TYPES.stateRead, CORE_TYPES.stateChanged, Note.name].includes(r.type),
      );
      const first = written.findIndex((r) => r.type !== STATE_TYPE && r.seq > written[1]!.seq);
      expect(first).toBeGreaterThan(-1);
      expect((written[first - 1]!.data as StateData).state).toBe("running");
      expect(written.slice(first - 1).filter((r) => r.type === STATE_TYPE).map((r) => (r.data as StateData).state)).toEqual(["running", "waiting"]);
    } finally {
      await h.close();
    }
  });
}

test("a plain wake of a call that emitted before finds its record and writes nothing", async () => {
  const Reply = record("guards.reply", z.object({ ok: z.boolean() }));
  const entered = { count: 0 };
  const ask = action("guards.ask", {
    description: "Emits, then waits for a good reply.",
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    recovery: "do-not-repeat",
    async run(input, ctx) {
      entered.count += 1;
      await ctx.emit(Note, {});
      await ctx.wait(Reply, (reply) => reply.ok);
      return input;
    },
  });
  const h = await hosted((api) => {
    api.declare(Start, Reply, Note);
    api.action(ask);
    api.on(Start, async (_data, step) => {
      await step(ask, { text: "requested" });
    });
  });
  try {
    await h.niwa.emit(Start, {});
    await eventually(() => h.states().at(-1)?.state === "waiting", 10_000, "the call waits");
    const before = (await h.niwa.records.read(seq(0))).length;
    await h.niwa.emit(Reply, { ok: false });
    await eventually(() => entered.count === 2, 10_000, "the wake");
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Only the reply itself is new.
    expect(await h.niwa.records.read(seq(0))).toHaveLength(before + 1);
  } finally {
    await h.close();
  }
});
