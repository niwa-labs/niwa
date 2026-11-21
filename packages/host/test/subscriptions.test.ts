// A subscription of a plugin: where it starts, what it remembers across restarts, how many of its
// records run at once, and which records never wake it.

import { expect, test } from "bun:test";

import { CORE_TYPES, record, seq } from "@niwa-labs/core";
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
  niwa.records.read(seq(0)).then((rows) => (type === undefined ? rows : rows.filter((row) => row.type === type)));

const positionsOf = async (niwa: Host): Promise<Array<{ subscription: string; seq: number; reason: string }>> =>
  (await recordsOf(niwa, CORE_TYPES.subscriptionPosition)).map((row) => row.data as { subscription: string; seq: number; reason: string });

const statesOf = async (niwa: Host): Promise<Array<{ invocation: string; state: string }>> =>
  (await recordsOf(niwa, CORE_TYPES.invocationState)).map((row) => row.data as { invocation: string; state: string });

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
    await step.wait(Answer, (answer) => answer.n === data.n);
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
