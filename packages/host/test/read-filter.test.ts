// The filters of `niwa.records.read`, and the read that waits for a record: what the CLI's log and
// an MCP client both ask. The action is called as a client calls it, over the wire.

import { expect, test } from "bun:test";

import { actionName, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { StoredRecord } from "@niwa-labs/core";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const READ = actionName("niwa.records.read");

const Ping = record("filter.ping", z.object({ n: z.number(), run: z.string().optional() }), { open: true });
const Pong = record("filter.pong", z.object({ text: z.string() }), { open: true });
const Bare = record("filter.bare", z.undefined(), { open: true });
const Noise = record("filter.noise", z.object({ text: z.string() }), { open: true });

interface Read {
  records: StoredRecord[];
  next: number;
}

async function hosted() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("filter", (api) => api.declare(Ping, Pong, Noise, Bare)));
  await niwa.serve();
  const client = await connectAsOwner(home.path);
  const read = async (input: Record<string, unknown>): Promise<Read> => (await client.call(READ, input)) as Read;
  return {
    niwa,
    read,
    close: async () => {
      await client.close().catch(() => {});
      await niwa.close();
      await home.cleanup();
    },
  };
}

test("a read answers with the records and the position to read after next", async () => {
  const h = await hosted();
  try {
    const first = await h.niwa.emit(Ping, { n: 1 });
    const second = await h.niwa.emit(Ping, { n: 2 });
    const all = await h.read({ from: 0, types: ["filter.ping"] });
    expect(all.records.map((row) => row.id)).toEqual([first.id, second.id]);
    // The read went to the end of the journal, which is as far as the last record of its type or further.
    expect(all.next).toBeGreaterThanOrEqual(second.seq);
    // Past the end nothing is found and the position stays where it was.
    const none = await h.read({ from: all.next, types: ["filter.ping"] });
    expect(none).toEqual({ records: [], next: all.next });
    // A limit stops the read at the last record it kept.
    const one = await h.read({ from: 0, types: ["filter.ping"], limit: 1 });
    expect(one.records.map((row) => row.id)).toEqual([first.id]);
    expect(one.next).toBe(first.seq);
  } finally {
    await h.close();
  }
});

test("a filter narrows by type pattern, actor, subject and text, and the filters hold together", async () => {
  const h = await hosted();
  try {
    await h.niwa.emit(Ping, { n: 1, run: "run_aaaa1111" });
    await h.niwa.emit(Ping, { n: 2, run: "run_bbbb2222" });
    await h.niwa.emit(Pong, { text: "Hello World" });
    await h.niwa.emit(Noise, { text: "noise" });
    // A record with no data is not a match for a text, and does not stop the read.
    await h.niwa.emit(Bare, undefined);

    const types = (found: Read): string[] => found.records.map((row) => String(row.type));
    expect(types(await h.read({ filter: { types: ["filter.p*"] } }))).toEqual(["filter.ping", "filter.ping", "filter.pong"]);
    // A pattern that begins with ! leaves its types out; with nothing else named, everything else stays.
    const without = types(await h.read({ filter: { types: ["!filter.*"] } }));
    expect(without.some((type) => type.startsWith("filter."))).toBe(false);
    expect(without.length).toBeGreaterThan(0);
    expect(types(await h.read({ filter: { types: ["filter.*", "!filter.noise", "!filter.pong", "!filter.bare"] } }))).toEqual(["filter.ping", "filter.ping"]);

    // A subject is found by the field of the data that names it, and an id may be a prefix.
    expect((await h.read({ filter: { run: "run_bbbb" } })).records.map((row) => (row.data as { n: number }).n)).toEqual([2]);
    expect(types(await h.read({ filter: { grep: "hello world" } }))).toEqual(["filter.pong"]);
    expect(types(await h.read({ filter: { actor: "host" } })).length).toBeGreaterThan(0);
    expect((await h.read({ filter: { actor: "nobody" } })).records).toEqual([]);
    expect(types(await h.read({ filter: { types: ["filter.*"], grep: "noise" } }))).toEqual(["filter.noise"]);
  } finally {
    await h.close();
  }
});

test("until, a span of time and a tail pick records from the end or the middle", async () => {
  const h = await hosted();
  try {
    const rows: StoredRecord[] = [];
    for (let n = 1; n <= 5; n += 1) rows.push(await h.niwa.emit(Ping, { n }));
    const numbers = (found: Read) => found.records.map((row) => (row.data as { n: number }).n);
    expect(numbers(await h.read({ tail: 2, filter: { types: ["filter.*"] } }))).toEqual([4, 5]);
    expect(numbers(await h.read({ filter: { types: ["filter.*"], until: rows[2]?.seq } }))).toEqual([1, 2, 3]);
    const until = await h.read({ filter: { types: ["filter.*"], until: rows[2]?.seq } });
    expect(until.next).toBe(rows[2]?.seq ?? -1);
    expect(numbers(await h.read({ filter: { types: ["filter.*"], after: (rows[4]?.at ?? 0) + 1 } }))).toEqual([]);
    expect(numbers(await h.read({ filter: { types: ["filter.*"], before: (rows[0]?.at ?? 0) + 3_600_000 } }))).toEqual([1, 2, 3, 4, 5]);
  } finally {
    await h.close();
  }
});

test("a read with waitMs waits for a record and returns at once when one is written, or empty at the end of the time", async () => {
  const h = await hosted();
  try {
    const last = (await h.read({ from: 0 })).next;
    const started = Date.now();
    const empty = await h.read({ from: last, waitMs: 150, filter: { types: ["filter.*"] } });
    expect(empty.records).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    const waiting = h.read({ from: last, waitMs: 20_000, filter: { types: ["filter.ping"] } });
    await Bun.sleep(100);
    // A record the filter does not want does not end the wait.
    await h.niwa.emit(Noise, { text: "not wanted" });
    await Bun.sleep(100);
    const wanted = await h.niwa.emit(Ping, { n: 7 });
    const found = await waiting;
    expect(found.records.map((row) => row.id)).toEqual([wanted.id]);
    expect(found.next).toBe(wanted.seq);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await h.close();
  }
});
