// A subscription of a plugin: where it starts, what it remembers across restarts, how many of its
// records run at once, and which records never wake it.

import { expect, test } from "bun:test";

import { CORE_TYPES, action, record, seq } from "@niwa-labs/core";
import type { ActionName, Handler, RecordType, StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { HandlerOptions, Plugin } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Item = record("sub-test.item", z.object({ n: z.number(), kind: z.string().optional() }));
const ItemV2 = record("sub-test.item", z.object({ n: z.number(), kind: z.string().optional() }), { version: 2 });
const Answer = record("sub-test.answer", z.object({ n: z.number() }));
const Echo = record("sub-test.echo", z.object({ n: z.number() }));

/** The plugin that declares the types and nothing else: what writes the records. */
const producer = (): Plugin => plugin("sub-producer", (api) => api.declare(Item, Answer));

/** A plugin with one handler of the items. */
function consumer(handler: Handler<{ n: number; kind?: string }>, opts: HandlerOptions = {}, type: RecordType<any> = Item): Plugin {
  return plugin("sub-consumer", (api) => {
    api.declare(Echo);
    api.on(type, opts, handler);
  });
}

type Host = ReturnType<typeof createNiwa>;

/** Serve a host on a home with these plugins. */
async function serving(home: string, plugins: Plugin[]): Promise<Host> {
  const niwa = createNiwa({ home });
  for (const one of plugins) niwa.use(one);
  await niwa.serve();
  return niwa;
}

const recordsOf = (niwa: Host, type?: string): Promise<StoredRecord[]> =>
  niwa.records.read().then((rows) => (type === undefined ? rows : rows.filter((row) => row.type === type)));

const positionsOf = async (niwa: Host): Promise<Array<{ subscription: string; seq: number; reason: string }>> =>
  (await recordsOf(niwa, CORE_TYPES.subscriptionPosition)).map((row) => row.data as { subscription: string; seq: number; reason: string });

const statesOf = async (niwa: Host): Promise<Array<{ invocation: string; state: string }>> =>
  (await recordsOf(niwa, CORE_TYPES.invocationState)).map((row) => row.data as { invocation: string; state: string });

const admissionsOf = async (niwa: Host): Promise<string[]> =>
  (await recordsOf(niwa, CORE_TYPES.invocationAdmitted)).map((row) => (row.data as { record: string }).record);

test("a new subscription starts at the position it was installed at", async () => {
  const home = await tempHome();
  try {
    const before = await serving(home.path, [producer()]);
    await before.emit(Item, { n: 1 });
    await before.emit(Item, { n: 2 });
    await before.close();

    const seen: number[] = [];
    const after = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n))]);
    await after.emit(Item, { n: 3 });
    await eventually(() => seen.length > 0);
    await Bun.sleep(50);
    expect(seen).toEqual([3]);
    expect((await positionsOf(after)).map((one) => one.reason)).toContain("installed");
    await after.close();
  } finally {
    await home.cleanup();
  }
});

test("a subscription that asks for the history starts at the beginning", async () => {
  const home = await tempHome();
  try {
    const before = await serving(home.path, [producer()]);
    await before.emit(Item, { n: 1 });
    await before.close();
    const seen: number[] = [];
    const after = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n), { from: "start" })]);
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([1]);
    await after.close();
  } finally {
    await home.cleanup();
  }
});

test("a subscription resumes from its stored position, not from the moment the host starts again", async () => {
  const home = await tempHome();
  try {
    const seen: number[] = [];
    const first = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n))]);
    await first.emit(Item, { n: 1 });
    await eventually(() => seen.length === 1);
    await first.close();
    // The records written while the subscription was not installed are still its records.
    const away = await serving(home.path, [producer()]);
    await away.emit(Item, { n: 2 });
    await away.emit(Item, { n: 3 });
    await away.close();
    const again = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n))]);
    await eventually(() => seen.length === 3);
    expect(seen).toEqual([1, 2, 3]);
    await again.close();
  } finally {
    await home.cleanup();
  }
});

test("a filtered record advances the position once, with its reason, and is not read again", async () => {
  const home = await tempHome();
  try {
    const seen: number[] = [];
    const first = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n), { filter: { kind: "wanted" } })]);
    await first.emit(Item, { n: 1, kind: "other" });
    await first.emit(Item, { n: 2, kind: "other" });
    await first.emit(Item, { n: 3, kind: "wanted" });
    await eventually(() => seen.length === 1);
    await first.emit(Item, { n: 4, kind: "other" });
    await eventually(async () => (await positionsOf(first)).some((one) => one.reason === "filtered"));
    expect(seen).toEqual([3]);
    const filtered = (await positionsOf(first)).filter((one) => one.reason === "filtered");
    const items = await recordsOf(first, Item.name);
    expect(filtered.at(-1)?.seq).toBe(items.at(-1)?.seq);
    await first.close();
  } finally {
    await home.cleanup();
  }
});

test("records of another schema version advance the position with the reason schema", async () => {
  const home = await tempHome();
  try {
    const old = await serving(home.path, [producer()]);
    await old.emit(Item, { n: 1 });
    await old.emit(Item, { n: 2 });
    await old.close();
    const seen: number[] = [];
    const newer = await serving(home.path, [
      plugin("sub-producer", (api) => api.declare(ItemV2, Answer)),
      consumer((data) => void seen.push(data.n), { from: "start" }, ItemV2),
    ]);
    await eventually(async () => (await positionsOf(newer)).some((one) => one.reason === "schema"));
    const written = (await positionsOf(newer)).filter((one) => one.reason === "schema").length;
    await newer.emit(ItemV2, { n: 3 });
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([3]);
    // The tail of the old version is read past once, not again at every look for new work.
    expect((await positionsOf(newer)).filter((one) => one.reason === "schema").length).toBe(written);
    await newer.close();
  } finally {
    await home.cleanup();
  }
});

test("no subscription is woken by the records of a position", async () => {
  const home = await tempHome();
  try {
    const Positions = record("niwa.subscription.*", z.unknown());
    let woken = 0;
    const niwa = await serving(home.path, [
      producer(),
      consumer(() => undefined, { filter: { kind: "wanted" } }),
      plugin("sub-watch-a", (api) => api.on(Positions, { from: "start" }, () => void woken++)),
      plugin("sub-watch-b", (api) => api.on(Positions, { from: "start" }, () => void woken++)),
    ]);
    for (let n = 0; n < 3; n++) await niwa.emit(Item, { n, kind: "other" });
    await eventually(async () => (await positionsOf(niwa)).some((one) => one.reason === "filtered"));
    const count = (await recordsOf(niwa)).length;
    await Bun.sleep(100);
    expect(woken).toBe(0);
    expect((await recordsOf(niwa)).length).toBe(count);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

/**
 * A handler that waits for the answer to its item, and the items it began, in order. A handler that
 * is woken runs again from its start and replays its steps, so an item is counted once.
 */
function waiter(began: number[]): Handler<{ n: number }> {
  return async (data, step) => {
    if (!began.includes(data.n)) began.push(data.n);
    await step.wait(Answer, { filter: { n: data.n } });
  };
}

test("one record at a time: a second record does not start while the first waits", async () => {
  const home = await tempHome();
  try {
    const began: number[] = [];
    const niwa = await serving(home.path, [producer(), consumer(waiter(began))]);
    await niwa.emit(Item, { n: 1 });
    await niwa.emit(Item, { n: 2 });
    await eventually(() => began.length === 1);
    await Bun.sleep(100);
    expect(began).toEqual([1]);
    await niwa.emit(Answer, { n: 1 });
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 2]);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("one record at a time holds across a restart of the host", async () => {
  const home = await tempHome();
  try {
    const began: number[] = [];
    const first = await serving(home.path, [producer(), consumer(waiter(began))]);
    await first.emit(Item, { n: 1 });
    await first.emit(Item, { n: 2 });
    await eventually(() => began.length === 1);
    await first.close();
    const again = await serving(home.path, [producer(), consumer(waiter(began))]);
    await Bun.sleep(150);
    // The first item is run again from its steps; the second still waits its turn.
    expect(began).toEqual([1]);
    await again.emit(Answer, { n: 1 });
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 2]);
    await again.close();
  } finally {
    await home.cleanup();
  }
});

test("a paused record holds the next one until the owner decides", async () => {
  const home = await tempHome();
  try {
    const began: number[] = [];
    const niwa = await serving(home.path, [
      producer(),
      consumer((data) => {
        began.push(data.n);
        if (data.n === 1) throw new Error("item one fails");
      }),
    ]);
    await niwa.emit(Item, { n: 1 });
    await niwa.emit(Item, { n: 2 });
    await eventually(async () => (await statesOf(niwa)).some((one) => one.state === "paused"));
    await Bun.sleep(100);
    expect(began).toEqual([1]);
    const paused = (await statesOf(niwa)).find((one) => one.state === "paused");
    await niwa.call("niwa.invocation.resolve" as ActionName, { invocation: paused?.invocation, choice: "cancel" });
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 2]);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("a subscription with room for two runs two records at once", async () => {
  const home = await tempHome();
  try {
    const began: number[] = [];
    const niwa = await serving(home.path, [producer(), consumer(waiter(began), { concurrency: 2 })]);
    for (const n of [1, 2, 3]) await niwa.emit(Item, { n });
    await eventually(() => began.length === 2);
    await Bun.sleep(100);
    expect(began).toEqual([1, 2]);
    await niwa.emit(Answer, { n: 2 });
    await eventually(() => began.length === 3);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("a keyed subscription preserves order within a key and lets other keys pass", async () => {
  const home = await tempHome();
  const began: number[] = [];
  const niwa = await serving(home.path, [
    producer(),
    plugin("sub-keyed", (api) => api.on(Item, { concurrency: { by: (data) => data.kind ?? "" } }, waiter(began))),
  ]);
  try {
    const first = await niwa.emit(Item, { n: 1, kind: "a" });
    const second = await niwa.emit(Item, { n: 2, kind: "a" });
    const third = await niwa.emit(Item, { n: 3, kind: "a" });
    const other = await niwa.emit(Item, { n: 4, kind: "b" });
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 4]);
    expect(await admissionsOf(niwa)).toEqual([first.id, other.id]);

    await niwa.emit(Answer, { n: 1 });
    await eventually(() => began.length === 3);
    expect(began).toEqual([1, 4, 2]);
    expect(await admissionsOf(niwa)).toEqual([first.id, other.id, second.id]);

    await niwa.emit(Answer, { n: 2 });
    await eventually(() => began.length === 4);
    expect(began).toEqual([1, 4, 2, 3]);
    expect(await admissionsOf(niwa)).toEqual([first.id, other.id, second.id, third.id]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a thrown handler keeps only its own key until the paused invocation is cancelled", async () => {
  const home = await tempHome();
  const began: number[] = [];
  const niwa = await serving(home.path, [
    producer(),
    plugin("sub-keyed", (api) => {
      api.on(Item, { concurrency: { by: (data) => data.kind ?? "" } }, (data) => {
        began.push(data.n);
        if (data.n === 1) throw new Error("item one fails");
      });
    }),
  ]);
  try {
    await niwa.emit(Item, { n: 1, kind: "a" });
    await niwa.emit(Item, { n: 2, kind: "a" });
    await niwa.emit(Item, { n: 3, kind: "b" });
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 3]);
    const paused = (await statesOf(niwa)).find((one) => one.state === "paused");
    expect(paused).toBeDefined();
    await niwa.call("niwa.invocation.resolve" as ActionName, { invocation: paused?.invocation, choice: "cancel" });
    await eventually(() => began.length === 3);
    expect(began).toEqual([1, 3, 2]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("restart preserves a keyed gap, replays the wait and skips completed admissions beyond it", async () => {
  const home = await tempHome();
  const selected: number[] = [];
  const began: number[] = [];
  const keyed = () => plugin("sub-keyed", (api) => {
    api.declare(Echo);
    api.on(Item, { concurrency: { by: (data) => {
      selected.push(data.n);
      return data.kind ?? "";
    } } }, async (data, step) => {
      began.push(data.n);
      await step.emit(Echo, { n: data.n });
      if (data.n === 1) await step.wait(Answer, { filter: { n: 1 } });
    });
  });
  let niwa = await serving(home.path, [producer(), keyed()]);
  try {
    const first = await niwa.emit(Item, { n: 1, kind: "a" });
    const second = await niwa.emit(Item, { n: 2, kind: "a" });
    const third = await niwa.emit(Item, { n: 3, kind: "b" });
    await eventually(async () => {
      const states = await statesOf(niwa);
      return states.some((one) => one.invocation.endsWith(first.id) && one.state === "waiting")
        && states.some((one) => one.invocation.endsWith(third.id) && one.state === "done");
    });
    expect(await admissionsOf(niwa)).toEqual([first.id, third.id]);
    expect(began).toEqual([1, 3]);
    await niwa.close();

    selected.length = 0;
    began.length = 0;
    niwa = await serving(home.path, [producer(), keyed()]);
    const fourth = await niwa.emit(Item, { n: 4, kind: "b" });
    await eventually(() => began.includes(4));
    expect(began).toEqual([1, 4]);
    expect([...new Set(selected)]).toEqual([2, 4]);
    expect(await admissionsOf(niwa)).toEqual([first.id, third.id, fourth.id]);

    await niwa.emit(Answer, { n: 1 });
    await eventually(async () => (await statesOf(niwa)).some((one) => one.invocation.endsWith(second.id) && one.state === "done"));
    expect(began).toEqual([1, 4, 1, 2]);
    expect(await admissionsOf(niwa)).toEqual([first.id, third.id, fourth.id, second.id]);
    expect((await recordsOf(niwa, Echo.name)).map((row) => row.data)).toEqual([1, 3, 4, 2].map((n) => ({ n })));
    expect((await positionsOf(niwa)).at(-1)?.seq).toBe(fourth.seq);
    await niwa.close();

    niwa = await serving(home.path, [producer(), keyed()]);
    const fifth = await niwa.emit(Item, { n: 5, kind: "a" });
    await eventually(() => began.includes(5));
    expect(began).toEqual([1, 4, 1, 2, 5]);
    expect(await admissionsOf(niwa)).toEqual([first.id, third.id, fourth.id, second.id, fifth.id]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("keyed concurrency validates the declaration and does not consume a record on selector failure", async () => {
  const home = await tempHome();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  let niwa: Host | undefined;
  try {
    for (const concurrency of [0, 1.5, NaN, -Infinity, null, [], {}, { by: "kind" }]) {
      expect(() => createNiwa({ home: home.path }).use(consumer(() => {}, { concurrency } as HandlerOptions))).toThrow(/concurrency/);
    }
    const failed: number[] = [];
    const healthy: number[] = [];
    const throwing = () => plugin("sub-throwing-selector", (api) => {
      api.on(Item, { concurrency: { by: (data) => {
        if (data.n === 1) throw new Error("missing entity");
        return data.n === 2 ? Infinity : data.n;
      } } }, (data) => void failed.push(data.n));
    });
    const fixed = () => plugin("sub-throwing-selector", (api) => {
      api.on(Item, { concurrency: { by: (data) => data.n } }, (data) => void failed.push(data.n));
    });
    niwa = await serving(home.path, [producer(), throwing(), consumer((data) => void healthy.push(data.n))]);
    const first = await niwa.emit(Item, { n: 1 });
    await niwa.emit(Item, { n: 2 });
    await eventually(() => healthy.length === 2);
    expect(failed).toEqual([]);
    expect(errors.some((line) => line.includes(first.id) && line.includes("missing entity"))).toBe(true);
    await niwa.close();

    niwa = await serving(home.path, [producer(), fixed()]);
    await eventually(() => failed.length === 2);
    expect(failed).toEqual([1, 2]);
    await niwa.close();

    niwa = await serving(home.path, [producer(), throwing()]);
    const invalid = await niwa.emit(Item, { n: 2 });
    await eventually(() => errors.some((line) => line.includes(invalid.id) && line.includes("finite number")));
    expect(failed).toEqual([1, 2]);
  } finally {
    await niwa?.close();
    console.error = original;
    await home.cleanup();
  }
});

test("a journal-derived subscriber applies its queries, bounds and keyed concurrency", async () => {
  const home = await tempHome();
  const began: number[] = [];
  let niwa = await serving(home.path, [producer()]);
  try {
    await niwa.emit(Item, { n: 0, kind: "older" });
    const marker = await niwa.emit(Answer, { n: 0 });
    await niwa.emit(Item, { n: 1, kind: "wanted" });
    await niwa.emit(Item, { n: 1, kind: "wanted" });
    await niwa.emit(Item, { n: 2, kind: "ignored" });
    const end = await niwa.emit(Item, { n: 3, kind: "wanted" });
    await niwa.emit(Item, { n: 4, kind: "wanted" });
    await niwa.close();

    niwa = await serving(home.path, [producer(), plugin("sub-dynamic-keyed", (api) => {
      api.subscribers(() => [{
        id: "items",
        queries: [{ type: Item, filter: { kind: "wanted" } }],
        from: marker.seq,
        until: end.seq,
        concurrency: { by: (data) => Item.schema.parse(data).n },
        handler: async (data, step) => {
          const item = Item.schema.parse(data);
          began.push(item.n);
          await step.wait(Answer, { filter: { n: item.n } });
        },
      }]);
    })]);
    await eventually(() => began.length === 2);
    expect(began).toEqual([1, 3]);
    await niwa.emit(Answer, { n: 1 });
    await eventually(async () => (await admissionsOf(niwa)).length === 3);
    expect((await positionsOf(niwa)).at(-1)?.seq).toBe(end.seq);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("busy keys under load leave room for a new key and drain their own queues in order", async () => {
  const home = await tempHome();
  const keys = Array.from({ length: 32 }, (_, n) => String(n));
  const gates = new Map(keys.map((key) => [key, Promise.withResolvers<void>()]));
  const occupied = new Set<string>();
  const seen = new Map<string, number[]>();
  const overlaps: string[] = [];
  const niwa = await serving(home.path, [producer(), plugin("sub-keyed", (api) => {
    api.on(Item, { concurrency: { by: (data) => data.kind ?? "" } }, async (data) => {
      const key = data.kind ?? "";
      if (occupied.has(key)) overlaps.push(key);
      occupied.add(key);
      const order = seen.get(key) ?? [];
      order.push(data.n);
      seen.set(key, order);
      if (data.n === 1) await gates.get(key)?.promise;
      occupied.delete(key);
    });
  })]);
  try {
    for (const n of [1, 2, 3]) {
      for (const kind of keys) await niwa.emit(Item, { n, kind });
    }
    await niwa.emit(Item, { n: 4, kind: "fresh" });
    await eventually(() => seen.has("fresh"));
    expect(occupied.size).toBe(keys.length);
    for (const key of keys) expect(seen.get(key)).toEqual([1]);

    const released = keys.at(-1)!;
    gates.get(released)!.resolve();
    await eventually(() => seen.get(released)?.length === 3);
    expect(occupied.size).toBe(keys.length - 1);
    expect(seen.get(keys[0]!)).toEqual([1]);

    for (const key of [...keys].reverse()) gates.get(key)!.resolve();
    await eventually(() => keys.every((key) => seen.get(key)?.length === 3));
    for (const key of keys) expect(seen.get(key)).toEqual([1, 2, 3]);
    expect(overlaps).toEqual([]);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await niwa.close();
    await home.cleanup();
  }
});

/** The plugin whose handler of the items writes an item itself, and the items it handled. */
function looping(seen: number[], opts: HandlerOptions = {}): Plugin {
  return plugin("sub-loop", (api) => {
    api.declare(Item, Answer);
    api.on(Item, opts, async (data, step) => {
      seen.push(data.n);
      await step.emit(Item, { n: data.n + 1 });
    });
  });
}

test("a subscription is not woken by a record its own invocation caused", async () => {
  const home = await tempHome();
  try {
    const seen: number[] = [];
    const other: number[] = [];
    const niwa = await serving(home.path, [
      looping(seen),
      plugin("sub-other", (api) => api.on(Item, { concurrency: Number.POSITIVE_INFINITY }, (data) => void other.push(data.n))),
    ]);
    await niwa.emit(Item, { n: 1 });
    await eventually(() => other.length === 2);
    await Bun.sleep(100);
    // The other subscription sees the item the loop wrote; the loop does not see it.
    expect(seen).toEqual([1]);
    expect(other).toEqual([1, 2]);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("a reentrant subscription is woken by its own records down to its depth, and says where it stopped", async () => {
  const home = await tempHome();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    const seen: number[] = [];
    const niwa = await serving(home.path, [looping(seen, { reentrant: { depth: 2 } })]);
    await niwa.emit(Item, { n: 1 });
    await eventually(() => seen.length === 3);
    await eventually(async () => (await positionsOf(niwa)).some((one) => one.reason === "reentry"));
    await Bun.sleep(100);
    expect(seen).toEqual([1, 2, 3]);
    expect(errors.some((line) => line.includes("sub-loop/sub-test.item") && line.includes("depth 2"))).toBe(true);
    await niwa.close();
  } finally {
    console.error = original;
    await home.cleanup();
  }
});

test("a new subscription to a type the journal has no record of writes no position until there is one", async () => {
  const home = await tempHome();
  try {
    const seen: number[] = [];
    const niwa = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n))]);
    await niwa.emit(Answer, { n: 0 });
    await Bun.sleep(50);
    expect(await positionsOf(niwa)).toEqual([]);
    await niwa.emit(Item, { n: 1 });
    await eventually(() => seen.length === 1);
    await niwa.close();
    // After a restart it is not new: it goes on from what it admitted.
    const again = await serving(home.path, [producer(), consumer((data) => void seen.push(data.n))]);
    await again.emit(Item, { n: 2 });
    await eventually(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
    expect(await positionsOf(again)).toEqual([]);
    await again.close();
  } finally {
    await home.cleanup();
  }
});

test("a subscription is not woken by a record its invocation caused through an action called as another principal", async () => {
  const home = await tempHome();
  try {
    const seen: number[] = [];
    const write = action("sub-test.write", {
      description: "Write an item.",
      input: z.object({ n: z.number() }),
      output: z.object({}),
      recovery: "repeat",
      effect: "write",
      run: async (input, ctx) => {
        await ctx.emit(Item, { n: input.n });
        return {};
      },
    });
    const niwa = await serving(home.path, [
      plugin("sub-loop", (api) => {
        api.declare(Item, Answer);
        api.action(write);
        api.on(Item, async (data, step) => {
          seen.push(data.n);
          // The record is the action's, written as the principal: its actor is not the handler.
          if (data.n < 5) await step(write, { n: data.n + 1 }, { as: { kind: "plugin", id: "sub-loop" as never } });
        });
      }),
    ]);
    await niwa.emit(Item, { n: 1 });
    await eventually(() => seen.length >= 1);
    await Bun.sleep(200);
    expect(seen).toEqual([1]);
    expect((await recordsOf(niwa, Item.name)).length).toBe(2);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});
