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

  test("a failure that retrying cannot fix leaves the stream failed", async () => {
    const { client, fail } = scriptedClient();
    const stream = createRecordStream(client);
    stream.start();
    await settle();
    fail(new Error("log in again"));
    await settle();
    expect(stream.store.getState()).toMatchObject({ status: "failed", error: "log in again" });
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
});
