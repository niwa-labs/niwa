// One record query for every reader: the read action, a client's snapshot and its live
// continuation take the same query and give the same records.

import { expect, test } from "bun:test";

import { actionName, record } from "@niwa-labs/core";
import type { RecordQuery, StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { connectAsOwner, eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const READ = actionName("niwa.records.read");

const Ping = record("query.ping", z.object({ n: z.number(), to: z.object({ kind: z.string() }) }), { open: true });
const Pong = record("query.pong", z.object({ n: z.number(), to: z.object({ kind: z.string() }) }), { open: true });
const Other = record("other.ping", z.object({ n: z.number(), to: z.object({ kind: z.string() }) }), { open: true });

async function hosted() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("query", (api) => api.declare(Ping, Pong, Other)));
  await niwa.serve();
  const client = await connectAsOwner(home.path);
  return {
    niwa,
    client,
    close: async () => {
      await client.close().catch(() => {});
      await niwa.close();
      await home.cleanup();
    },
  };
}

const numbers = (rows: readonly StoredRecord[]): number[] => rows.map((row) => (row.data as { n: number }).n);

test("the read action takes a family and equality on a path, and refuses a pattern of another language", async () => {
  const h = await hosted();
  try {
    await h.client.emit(Ping, { n: 1, to: { kind: "session" } });
    await h.client.emit(Pong, { n: 2, to: { kind: "agent" } });
    await h.client.emit(Other, { n: 3, to: { kind: "session" } });
    await h.client.emit(Pong, { n: 4, to: { kind: "session" } });
    const family = (await h.client.call(READ, { types: ["query.*"] })) as { records: StoredRecord[] };
    expect(numbers(family.records)).toEqual([1, 2, 4]);
    const filtered = (await h.client.call(READ, { types: ["query.*"], filter: { "to.kind": "session" } })) as { records: StoredRecord[] };
    expect(numbers(filtered.records)).toEqual([1, 4]);
    await expect(h.client.call(READ, { types: ["!query.*"] })).rejects.toThrow();
    await expect(h.client.call(READ, { types: ["query.p*"] })).rejects.toThrow();
    // A field the read does not take is refused, not ignored: `type` is not a field of a query.
    await expect(h.client.call(READ, { type: "query.ping" })).rejects.toThrow();
  } finally {
    await h.close();
  }
});

test("a snapshot and its live continuation with one query give what the live query alone gives", async () => {
  const h = await hosted();
  try {
    const query: RecordQuery = { types: ["query.*"], filter: { "to.kind": "session" } };
    await h.client.emit(Ping, { n: 1, to: { kind: "session" } });
    await h.client.emit(Pong, { n: 2, to: { kind: "agent" } });
    await h.client.emit(Other, { n: 3, to: { kind: "session" } });

    const snapshot = await h.client.records.read(query);
    const continued: StoredRecord[] = [];
    const alone: StoredRecord[] = [];
    const follow = async (into: StoredRecord[], from: RecordQuery) => {
      for await (const row of h.client.records.since(from)) {
        into.push(row);
        if ((row.data as { n: number }).n === 7) return;
      }
    };
    const both = Promise.all([
      follow(continued, { ...query, from: snapshot.at(-1)?.seq ?? 0 }),
      follow(alone, query),
    ]);
    await h.client.emit(Pong, { n: 4, to: { kind: "session" } });
    await h.client.emit(Other, { n: 5, to: { kind: "session" } });
    await h.client.emit(Ping, { n: 6, to: { kind: "agent" } });
    await h.client.emit(Ping, { n: 7, to: { kind: "session" } });
    await both;
    expect(numbers([...snapshot, ...continued])).toEqual([1, 4, 7]);
    expect(numbers(alone)).toEqual([1, 4, 7]);
    // The host's own reader answers the same.
    expect(numbers(await h.niwa.records.read(query))).toEqual([1, 4, 7]);
    await eventually(() => true);
  } finally {
    await h.close();
  }
});
