// A query of a subscriber is the query of the core: it names a stream as a read does.

import { expect, test } from "bun:test";

import { record } from "@niwa-labs/core";
import type { RecordQuery, StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Subscriber } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Beat = record("contract.beat", z.object({ n: z.number() }), { open: true });
const Pulse = record("contract.pulse", z.object({ n: z.number() }), { open: true });

const declares = plugin("contract-types", (api) => api.declare(Beat, Pulse));

test("one query on a stream gives the same records read and subscribed", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const seen: number[] = [];
  let query: RecordQuery | undefined;
  try {
    niwa.use(
      declares,
      plugin("contract-subscriber", (api) => {
        api.subscribers(
          (): Subscriber[] =>
            query === undefined
              ? []
              : [{ id: "one-stream", queries: [query], from: 0, handler: async (_data, _step, stored: StoredRecord) => void seen.push((stored.data as { n: number }).n) }],
        );
      }),
    );
    await niwa.serve();
    const first = await niwa.emit(Beat, { n: 1 });
    query = { types: ["contract.*"], stream: first.stream };
    await niwa.emit(Pulse, { n: 2 });
    await niwa.emit(Beat, { n: 3 });
    await eventually(() => seen.length >= 2);
    await Bun.sleep(100);
    expect(seen.sort()).toEqual([1, 3]);
    expect((await niwa.records.read(query)).map((row) => (row.data as { n: number }).n)).toEqual([1, 3]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a query of a subscriber that carries a position of its own wakes it on nothing", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const seen: number[] = [];
  try {
    niwa.use(
      declares,
      plugin("contract-subscriber", (api) => {
        api.subscribers((): Subscriber[] => [
          { id: "placed", queries: [{ types: ["contract.*"], from: 0 } as RecordQuery], from: 0, handler: async (_data, _step, stored: StoredRecord) => void seen.push((stored.data as { n: number }).n) },
        ]);
      }),
    );
    await niwa.serve();
    await niwa.emit(Beat, { n: 1 });
    await Bun.sleep(150);
    expect(seen).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
