// A wait may carry a match key: the host indexes the waiting invocations by (type, key) and a
// record wakes only those it can match.
//
//   1. 100 invocations wait with a key; one record wakes one handler, not a hundred
//   2. the key is recorded with the wait: after a restart the parked waiters are indexed again
//      from the journal, and a record still wakes only its own
//   3. a wait without a key is woken by every record of its type
//   4. an invocation waiting in two parallel branches is woken by the answer of either, in any
//      order: every open wait is indexed, not only the last one written
//   5. a branch that begins its wait after another branch suspended the invocation is woken too
//   6. a key that does not parse indexes the wait by its type alone: woken too often, never lost
//   7. request.ask names its request id as the key: with many open asks, one answer wakes one

import { expect, test } from "bun:test";

import type { ActionContext } from "@niwa-labs/core";
import { action, actionName, record, seq, owner } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import {
  REQUEST_ANSWER,
  RequestAnswered,
  RequestCreated,
  answeredBy,
  requestAsk,
  question,
  requests,
} from "@niwa-labs/requests";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const Start = record("wait-key.start", z.object({ n: z.number() }));
const Answer = record("wait-key.answer", z.object({ id: z.string() }));
const Done = record("wait-key.done", z.object({ n: z.number() }));

const Input = z.object({ n: z.number() });


/** The host of one run; `runs` counts how many times a handler body ran, a wake included. */
function build(home: string, keyed: boolean) {
  const state = { runs: 0 };
  const waiter = action("waiter", {
    description: "Waits for the answer of its own id.",
    input: Input,
    output: z.string(),
    recovery: "repeat",
    async run(input, ctx) {
      const id = `k${String(input.n)}`;
      // A filter on the id keys the wait by it. Without one the wait is woken by every answer, and
      // waits on from the answer it saw until its own comes.
      if (keyed) return (await ctx.wait(Answer, { filter: { id } })).data.id;
      for (let from = seq(0); ; ) {
        const answered = await ctx.wait(Answer, { from });
        if (answered.data.id === id) return answered.data.id;
        from = answered.at;
      }
    },
  });
  const niwa = createNiwa({ home });
  niwa.use(
    plugin("wait-key", (api) => {
      api.declare(Start, Answer, Done);
      api.action(waiter);
      api.on(Start, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
        state.runs += 1;
        await step(actionName("waiter"), { n: data.n });
        await step.emit(Done, { n: data.n });
      });
    }),
  );
  return { niwa, state };
}

async function settled(niwa: ReturnType<typeof createNiwa>, done: number): Promise<number[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const finished = (await niwa.records.read()).filter((r) => r.type === Done.name).map((r) => (r.data as { n: number }).n);
    if (finished.length >= done) return finished;
    if (Date.now() > deadline) throw new Error(`only ${String(finished.length)} of ${String(done)} finished`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function parked(niwa: ReturnType<typeof createNiwa>, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const records = await niwa.records.read();
    const latest = new Map<string, string>();
    for (const r of records) {
      if (r.type !== "niwa.invocation.state") continue;
      const data = r.data as { invocation: string; state: string };
      latest.set(data.invocation, data.state);
    }
    if ([...latest.values()].filter((state) => state === "waiting").length >= count) return;
    if (Date.now() > deadline) throw new Error("the waiters did not park");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * What the host holds of its waiters, read from the inside: the index must not keep an entry
 * for an invocation that is no longer parked, and the count of a key field must follow the slots.
 */
function held(niwa: ReturnType<typeof createNiwa>) {
  const inner = niwa as unknown as {
    waiting: Map<string, unknown>;
    waitIndex: Map<string, Set<string>>;
    waitFields: Map<string, Map<string, number>>;
  };
  return {
    waiting: inner.waiting.size,
    slots: inner.waitIndex.size,
    entries: [...inner.waitIndex.values()].reduce((sum, set) => sum + set.size, 0),
    fields: Object.fromEntries([...inner.waitFields].map(([type, fields]) => [type, Object.fromEntries(fields)])),
  };
}

/** Let the host react to what it was just given: a wake is scheduled right after the commit. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

test("100 keyed waiters: one record wakes one handler", async () => {
  const home = await tempHome();
  const { niwa, state } = build(home.path, true);
  try {
    await niwa.serve();
    for (let n = 0; n < 100; n += 1) await niwa.emit(Start, { n });
    await parked(niwa, 100);
    expect(state.runs).toBe(100);

    // An answer nobody waits for wakes nobody.
    await niwa.emit(Answer, { id: "nobody" });
    await quiet();
    expect(state.runs).toBe(100);

    expect(held(niwa)).toEqual({ waiting: 100, slots: 100, entries: 100, fields: { [Answer.name]: { id: 100 } } });

    await niwa.emit(Answer, { id: "k42" });
    expect(await settled(niwa, 1)).toEqual([42]);
    await quiet();
    expect(state.runs).toBe(101);
    // The woken waiter left the index, and the count of the field went down with it.
    expect(held(niwa)).toEqual({ waiting: 99, slots: 99, entries: 99, fields: { [Answer.name]: { id: 99 } } });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 60_000);

test("keyed waiters parked across a restart are indexed again: a record wakes only its own", async () => {
  const home = await tempHome();
  const first = build(home.path, true);
  try {
    await first.niwa.serve();
    for (let n = 0; n < 5; n += 1) await first.niwa.emit(Start, { n });
    await parked(first.niwa, 5);
  } finally {
    await first.niwa.close();
  }

  const second = build(home.path, true);
  try {
    await second.niwa.serve();
    await parked(second.niwa, 5);
    await quiet();
    // The restart ran every waiter once to park it again.
    expect(second.state.runs).toBe(5);

    await second.niwa.emit(Answer, { id: "k3" });
    expect(await settled(second.niwa, 1)).toEqual([3]);
    await quiet();
    expect(second.state.runs).toBe(6);
  } finally {
    await second.niwa.close();
    await home.cleanup();
  }
}, 60_000);

test("a wait without a key is woken by every record of its type", async () => {
  const home = await tempHome();
  const { niwa, state } = build(home.path, false);
  try {
    await niwa.serve();
    for (let n = 0; n < 10; n += 1) await niwa.emit(Start, { n });
    await parked(niwa, 10);
    expect(state.runs).toBe(10);

    await niwa.emit(Answer, { id: "k4" });
    expect(await settled(niwa, 1)).toEqual([4]);
    await quiet();
    // All ten were woken; nine checked and waited again, one finished.
    expect(state.runs).toBe(20);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 60_000);

const Both = record("wait-key.both", z.object({ delay: z.number() }));
const Pair = record("wait-key.pair", z.object({ ids: z.array(z.string()) }));

/** One handler that waits in two parallel branches, `a` then `b`; `b` may begin after a delay. */
function buildParallel(home: string) {
  const state = { runs: 0 };
  const branch = action("branch", {
    description: "Waits, after an optional delay, for the answer of its id.",
    input: z.object({ id: z.string(), delay: z.number() }),
    output: z.string(),
    recovery: "repeat",
    async run(input, ctx) {
      if (input.delay > 0) await new Promise((resolve) => setTimeout(resolve, input.delay));
      const answered = await ctx.wait(Answer, { filter: { id: input.id } });
      return answered.data.id;
    },
  });
  const niwa = createNiwa({ home });
  niwa.use(
    plugin("wait-key-parallel", (api) => {
      api.declare(Both, Answer, Pair);
      api.action(branch);
      api.on(Both, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
        state.runs += 1;
        const ids = await Promise.all([
          step(actionName("branch"), { id: "a", delay: 0 }, { key: "a" }),
          step(actionName("branch"), { id: "b", delay: data.delay }, { key: "b" }),
        ]);
        await step.emit(Pair, { ids: ids as string[] });
      });
    }),
  );
  return { niwa, state };
}

async function paired(niwa: ReturnType<typeof createNiwa>): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const pair = (await niwa.records.read()).find((r) => r.type === Pair.name);
    if (pair !== undefined) return (pair.data as { ids: string[] }).ids;
    if (Date.now() > deadline) throw new Error("the parallel waits were not both answered");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const order of [["a", "b"], ["b", "a"]] as const) {
  test(`parallel keyed waits are each woken by their own answer: ${order.join(" then ")}`, async () => {
    const home = await tempHome();
    const { niwa, state } = buildParallel(home.path);
    try {
      await niwa.serve();
      await niwa.emit(Both, { delay: 0 });
      await parked(niwa, 1);
      expect(state.runs).toBe(1);

      await niwa.emit(Answer, { id: order[0] });
      await quiet();
      // The first answer woke it; it ran, found the other wait open, and parked again.
      expect(state.runs).toBe(2);
      await parked(niwa, 1);

      // The answered wait is closed: the same answer again wakes nothing.
      await niwa.emit(Answer, { id: order[0] });
      await quiet();
      expect(state.runs).toBe(2);

      expect(held(niwa)).toEqual({ waiting: 1, slots: 1, entries: 1, fields: { [Answer.name]: { id: 1 } } });

      await niwa.emit(Answer, { id: order[1] });
      expect(await paired(niwa)).toEqual(["a", "b"]);
      await quiet();
      expect(held(niwa)).toEqual({ waiting: 0, slots: 0, entries: 0, fields: {} });
    } finally {
      await niwa.close();
      await home.cleanup();
    }
  }, 60_000);
}

test("a wait a parallel branch begins after the invocation was suspended is woken by its answer", async () => {
  const home = await tempHome();
  const { niwa, state } = buildParallel(home.path);
  try {
    await niwa.serve();
    // Branch a suspends the invocation at once; branch b begins its wait a little later, after
    // the host has parked the invocation on a alone.
    await niwa.emit(Both, { delay: 150 });
    await parked(niwa, 1);
    await quiet();
    expect(state.runs).toBe(1);
    // Both waits are indexed, the second one by parkLate: two slots for the one invocation.
    expect(held(niwa)).toEqual({ waiting: 1, slots: 2, entries: 2, fields: { [Answer.name]: { id: 2 } } });

    await niwa.emit(Answer, { id: "b" });
    await quiet();
    expect(state.runs).toBe(2);
    // The run that b woke parked again before branch b settled its wait, so b's slot is still
    // there: stale but harmless (at worst one wake too many), and gone with the next wake.
    expect(held(niwa)).toEqual({ waiting: 1, slots: 2, entries: 2, fields: { [Answer.name]: { id: 2 } } });

    await niwa.emit(Answer, { id: "a" });
    expect(await paired(niwa)).toEqual(["a", "b"]);
    await quiet();
    expect(held(niwa)).toEqual({ waiting: 0, slots: 0, entries: 0, fields: {} });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 60_000);

const Asked = record("wait-key.asked", z.object({ n: z.number() }));
const Reply = record("wait-key.reply", z.object({ n: z.number() }));
const Who = question("wait-key.who", { kind: "text", title: "Which one?" });

test("request.ask names its request id as the key: one answer among many open asks wakes one invocation", async () => {
  const home = await tempHome();
  const state = { runs: 0 };
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests({ bind: (caller) => (caller.kind === "client" ? owner : undefined) }));
  niwa.use(
    plugin("wait-key-asks", (api) => {
      api.declare(Asked, Reply);
      api.on(Asked, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
        state.runs += 1;
        const { answer } = answeredBy(await step(requestAsk, { to: owner, ...Who, input: { ...Who.input, detail: String(data.n) } }));
        await step.emit(Reply, { n: "text" in answer ? Number(answer.text) : -1 });
      });
    }),
  );
  const count = 30;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await niwa.serve();
    client = await connectAsOwner(home.path);
    for (let n = 0; n < count; n += 1) await niwa.emit(Asked, { n });
    const created = async () => (await niwa.records.read()).filter((r) => r.type === RequestCreated.name);
    await eventually(async () => (await created()).length === count, 20_000, "the asks were not all opened");
    await parked(niwa, count);
    await quiet();
    expect(state.runs).toBe(count);

    // The request of the asker n = 7 is answered: that asker alone is woken.
    const ids = new Map<number, string>();
    for (const row of await created()) {
      const data = row.data as { id: string; input: { detail: string } };
      ids.set(Number(data.input.detail), data.id);
    }
    const id = ids.get(7);
    expect(id).toBeDefined();
    await client.call(REQUEST_ANSWER, { id, answer: { text: "7" } });
    await eventually(
      async () => (await niwa.records.read()).some((r) => r.type === Reply.name),
      20_000,
      "the asker did not go on",
    );
    await quiet();
    const replies = (await niwa.records.read()).filter((r) => r.type === Reply.name);
    expect(replies.map((r) => r.data)).toEqual([{ n: 7 }]);
    expect((await niwa.records.read()).filter((r) => r.type === RequestAnswered.name)).toHaveLength(1);
    // One run for the asker that was answered; the other twenty-nine were not woken at all.
    expect(state.runs).toBe(count + 1);
  } finally {
    await client?.close().catch(() => {});
    await niwa.close();
    await home.cleanup();
  }
}, 90_000);

/** A handler whose run goes on after its wait suspended it: it settles the wait, then a timer. */
function buildSlowEnd(home: string) {
  const state = { runs: 0 };
  const branch = action("slow-branch", {
    description: "Waits for the answer of its id.",
    input: z.object({ id: z.string() }),
    output: z.string(),
    recovery: "repeat",
    async run(input, ctx) {
      const answered = await ctx.wait(Answer, { filter: { id: input.id } });
      return answered.data.id;
    },
  });
  const niwa = createNiwa({ home });
  niwa.use(
    plugin("wait-key-slow", (api) => {
      api.declare(Both, Answer, Pair);
      api.action(branch);
      api.on(Both, { concurrency: Number.POSITIVE_INFINITY }, async (_data, step) => {
        state.runs += 1;
        // The wait suspends the invocation, but the run lasts until the timer is done.
        const [answered] = await Promise.allSettled([
          step(actionName("slow-branch"), { id: "a" }, { key: "a" }),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        // Only a run that was answered goes on; the first one, suspended, ends here.
        if (answered.status === "fulfilled") await step.emit(Pair, { ids: [answered.value as string] });
      });
    }),
  );
  return { niwa, state };
}

test("an answer that arrives while the run still goes on wakes the invocation once it is parked", async () => {
  const home = await tempHome();
  const { niwa, state } = buildSlowEnd(home.path);
  try {
    await niwa.serve();
    await niwa.emit(Both, { delay: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Nobody is parked yet: the run is still going. The answer is looked for when it parks.
    await niwa.emit(Answer, { id: "a" });
    expect(await paired(niwa)).toEqual(["a"]);
    expect(state.runs).toBe(2);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 60_000);

test("a record the wait cannot match that arrives while the run goes on does not wake it", async () => {
  const home = await tempHome();
  const { niwa, state } = buildSlowEnd(home.path);
  try {
    await niwa.serve();
    await niwa.emit(Both, { delay: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await niwa.emit(Answer, { id: "elsewhere" });
    await parked(niwa, 1);
    await quiet();
    expect(state.runs).toBe(1);

    await niwa.emit(Answer, { id: "a" });
    expect(await paired(niwa)).toEqual(["a"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 60_000);
