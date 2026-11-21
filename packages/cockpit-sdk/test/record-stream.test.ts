import { describe, expect, test } from "bun:test";

import { createRecordStream, defineProjection, matchRecord, recordList, type StoredRecord } from "../src/index.ts";
import { rec, scriptedClient, settle } from "./fixtures.ts";

const counter = defineProjection<{ n: number }>({
  match: { types: ["run.*"] },
  initial: { n: 0 },
  reduce: (state) => ({ n: state.n + 1 }),
});

describe("matching", () => {
  test("type prefixes, streams and conditions narrow together", () => {
    const r = rec(1, "run.step.done", "run-1");
    expect(matchRecord({}, r)).toBe(true);
    expect(matchRecord({ types: ["run.*"] }, r)).toBe(true);
    expect(matchRecord({ types: ["run.step.done"] }, r)).toBe(true);
    expect(matchRecord({ types: ["runx.*", "run"] }, r)).toBe(false);
    // As in a query to the host, no types means every type.
    expect(matchRecord({ types: [] }, r)).toBe(true);
    expect(matchRecord({ types: ["run.*"], stream: "run-2" }, r)).toBe(false);
    expect(matchRecord({ where: (x) => x.seq > 1 }, r)).toBe(false);
  });
});

describe("the record stream", () => {
  test("follows the feed and reports its state", async () => {
    const { client, push } = scriptedClient();
    const stream = createRecordStream(client);
    expect(stream.store.getState().status).toBe("idle");
    stream.start(0);
    await settle();
    expect(stream.store.getState().status).toBe("live");
    push(rec(1), rec(2));
    await settle();
    expect(stream.store.getState().seq).toBe(2);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([1, 2]);
    stream.stop();
    expect(stream.store.getState().status).toBe("idle");
  });

  test("a failure that retrying cannot fix leaves the stream failed until it is started again", async () => {
    const { client, fail, opened } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start();
    await settle();
    fail(new Error("log in again"));
    await settle();
    expect(stream.store.getState()).toMatchObject({ status: "failed", error: "log in again" });
    stream.start();
    await settle();
    expect(stream.store.getState().status).toBe("live");
    expect(opened).toEqual([0, 0]);
    stream.stop();
  });

  test("a burst from the feed is one update of the store", async () => {
    const { client, push } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start();
    await settle();
    let updates = 0;
    const unsubscribe = stream.store.subscribe(() => (updates += 1));
    push(rec(1), rec(2), rec(3), rec(4), rec(5));
    await settle();
    expect(stream.store.getState().seq).toBe(5);
    expect(updates).toBe(1);
    unsubscribe();
    stream.stop();
  });

  test("a projection folds only new matching records and keeps its state otherwise", () => {
    const stream = createRecordStream(scriptedClient().client);
    stream.ingest([rec(1, "run.started"), rec(2, "task.opened")]);
    const first = stream.project(counter);
    expect(first).toEqual({ n: 1 });
    expect(stream.project(counter)).toBe(first);
    stream.ingest([rec(3, "task.closed")]);
    expect(stream.project(counter)).toBe(first);
    stream.ingest([rec(4, "run.step.done"), rec(5, "run.finished")]);
    expect(stream.project(counter)).toEqual({ n: 3 });
  });

  test("older records are merged in order and projections fold again from the start", () => {
    const stream = createRecordStream(scriptedClient().client);
    stream.ingest([rec(5, "run.started"), rec(6, "run.step.done")]);
    expect(stream.project(counter)).toEqual({ n: 2 });
    stream.ingest([rec(2, "run.started"), rec(3, "task.opened"), rec(5, "run.started")]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([2, 3, 5, 6]);
    expect(stream.store.getState().seq).toBe(6);
    expect(stream.project(counter)).toEqual({ n: 3 });
  });

  test("records that fill a gap are merged; history the limit drops at once changes nothing", () => {
    const stream = createRecordStream(scriptedClient().client, { retain: 3 });
    stream.ingest([rec(4, "run.started"), rec(5, "run.started"), rec(10, "run.started")]);
    const before = stream.project(counter);
    expect(before).toEqual({ n: 3 });
    stream.ingest([rec(1, "run.started")]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([4, 5, 10]);
    expect(stream.project(counter)).toBe(before);
    stream.ingest([rec(8, "run.started")]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([5, 8, 10]);
    expect(stream.project(counter)).toEqual({ n: 3 });
  });

  test("ingesting skips known positions and keeps order", () => {
    const stream = createRecordStream(scriptedClient().client);
    stream.ingest([rec(3), rec(1), rec(2)]);
    stream.ingest([rec(2), rec(4)]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4]);
  });

  test("only `retain` records are kept, and a list projection keeps its newest `limit`", () => {
    const stream = createRecordStream(scriptedClient().client, { retain: 3 });
    const list = recordList({}, 2);
    stream.ingest([rec(1), rec(2)]);
    expect(stream.project(list).map((r: StoredRecord) => Number(r.seq))).toEqual([1, 2]);
    stream.ingest([rec(3), rec(4), rec(5)]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([3, 4, 5]);
    expect(stream.project(list).map((r: StoredRecord) => Number(r.seq))).toEqual([4, 5]);
  });

  test("a projection needs a reducer", () => {
    expect(() => defineProjection({ match: {}, initial: 0 })).toThrow("reduce");
  });

  test("history read while the feed is open does not make the feed skip the records in between", async () => {
    const { client, push } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start(9);
    await settle();
    stream.ingest([rec(12)]);
    push(rec(10), rec(11), rec(12), rec(13));
    await settle();
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([10, 11, 12, 13]);
    expect(stream.store.getState().seq).toBe(13);
    stream.stop();
  });

  test("a record that fills a gap is folded into the projections that match it", async () => {
    const { client, push } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start(0);
    await settle();
    stream.ingest([rec(3, "run.started")]);
    expect(stream.project(counter)).toEqual({ n: 1 });
    push(rec(1, "run.started"), rec(2, "run.started"), rec(3, "run.started"));
    await settle();
    expect(stream.project(counter)).toEqual({ n: 3 });
    stream.stop();
  });

  test("a position comes once, in a batch and across sources", async () => {
    const stream = createRecordStream(scriptedClient().client);
    stream.ingest([rec(5), rec(5), rec(6)]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([5, 6]);
    stream.ingest([rec(6), rec(4), rec(4)]);
    expect(stream.store.getState().records.map((r) => Number(r.seq))).toEqual([4, 5, 6]);
  });

  test("a feed that failed before its first record resumes after the position it was started at", async () => {
    const { client, fail, opened } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start(20_000);
    await settle();
    fail(new Error("the feed broke"));
    await settle();
    stream.start();
    await settle();
    expect(opened).toEqual([20_000, 20_000]);
    stream.stop();
  });

  test("a restarted feed resumes after what it delivered, not after what was read another way", async () => {
    const { client, push, fail, opened } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start(0);
    await settle();
    stream.ingest([rec(40)]);
    push(rec(1), rec(2));
    await settle();
    fail(new Error("the feed broke"));
    await settle();
    stream.start();
    await settle();
    expect(opened).toEqual([0, 2]);
    stream.stop();
  });
});
