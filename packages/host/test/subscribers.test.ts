// Subscriptions that are data: a plugin reads them from the journal (an installed workflow is one),
// and the host serves each as it serves a handler — its own position, its own identity.

import { expect, test } from "bun:test";

import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin, Subscriber } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Watch = record("subs-test.watch", z.object({ name: z.string(), type: z.string(), kind: z.string().optional() }));
const Unwatch = record("subs-test.unwatch", z.object({ name: z.string() }));
const Ping = record("subs-test.ping", z.object({ n: z.number(), kind: z.string().optional() }));

/**
 * A plugin whose subscribers are the watches written in the journal: each is a subscriber from the
 * position of its watch, and an unwatch ends it at its own position.
 */
function watcher(seen: Array<{ name: string; n: number }>): Plugin {
  return plugin("subs-watcher", (api) => {
    api.declare(Watch, Unwatch, Ping);
    api.subscribers(() => {
      const journal = api.journal?.();
      if (journal === undefined) return [];
      const ends = journal.find({ type: Unwatch.name });
      return journal.find({ type: Watch.name }).map((row): Subscriber => {
        const watch = Watch.schema.parse(row.data);
        const end = ends.find((one) => (one.data as { name: string }).name === watch.name && one.seq > row.seq);
        return {
          id: `watch:${watch.name}`,
          queries: [{ types: [watch.type], ...(watch.kind === undefined ? {} : { filter: { kind: watch.kind } }) }],
          from: row.seq,
          ...(end === undefined ? {} : { until: end.seq }),
          handler: async (_data, step, stored: StoredRecord) => {
            const n = (stored.data as { n: number }).n;
            seen.push({ name: watch.name, n });
            // A subscriber that writes what it watches is not woken by its own record.
            if (watch.name === "a") await step.emit(Ping, { n: n + 100, kind: "x" });
          },
        };
      });
    });
  });
}

test("a subscriber from the journal starts at its own position and ends at its end", async () => {
  const home = await tempHome();
  const seen: Array<{ name: string; n: number }> = [];
  const niwa = createNiwa({ home: home.path });
  niwa.use(watcher(seen));
  try {
    await niwa.serve();
    await niwa.emit(Ping, { n: 1 });
    await niwa.emit(Watch, { name: "b", type: Ping.name, kind: "x" });
    await niwa.emit(Watch, { name: "a", type: Ping.name });
    await niwa.emit(Ping, { n: 2 });
    await niwa.emit(Ping, { n: 3, kind: "x" });
    await niwa.emit(Ping, { n: 4, kind: "y" });
    await eventually(() => seen.filter((one) => one.name === "a").length === 3);
    await niwa.emit(Unwatch, { name: "a" });
    await niwa.emit(Ping, { n: 5, kind: "x" });
    await eventually(() => seen.filter((one) => one.name === "b").length === 5);
    await Bun.sleep(100);
    const of = (name: string): number[] => seen.filter((one) => one.name === name).map((one) => one.n).sort((x, y) => x - y);
    // The watch of a began after the first ping and ended before the last; it never sees its own echoes.
    expect(of("a")).toEqual([2, 3, 4]);
    // The watch of b holds its filter, and sees what a wrote.
    expect(of("b")).toEqual([3, 5, 102, 103, 104]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a subscriber's position survives a restart", async () => {
  const home = await tempHome();
  const seen: Array<{ name: string; n: number }> = [];
  try {
    const first = createNiwa({ home: home.path });
    first.use(watcher(seen));
    await first.serve();
    await first.emit(Watch, { name: "a", type: Ping.name, kind: "x" });
    await first.emit(Ping, { n: 1, kind: "x" });
    await eventually(() => seen.length === 1);
    await first.close();
    const again = createNiwa({ home: home.path });
    again.use(watcher(seen));
    await again.serve();
    await again.emit(Ping, { n: 2, kind: "x" });
    await eventually(() => seen.length === 2);
    await Bun.sleep(100);
    expect(seen.map((one) => one.n)).toEqual([1, 2]);
    expect((await again.records.read()).length).toBeGreaterThan(0);
    await again.close();
  } finally {
    await home.cleanup();
  }
});
