// The feed is read whole and then followed, and neither waits for the journal to fall silent.
//
//   1. the list as it stands is what a read answers, however late the live subscription says anything
//   2. a followed feed starts with that list and goes on from its position, so no record is lost between the two
//   3. a steady stream of records still gets its lists out: they are sent while it runs, not after it ends

import { expect, test } from "bun:test";

import { recordId, recordTypeName, seq, streamId, timestamp } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

import { followFeed, readFeed } from "../src/feed.ts";

function request(at: number, id: string): StoredRecord {
  return {
    id: recordId(`rec_${id}`),
    seq: seq(at),
    stream: streamId("main"),
    type: recordTypeName("request.created"),
    schema: 1,
    data: { id, to: { kind: "owner" }, input: { kind: "choice", title: `Question ${id}`, options: [] } },
    actor: { kind: "host" },
    cause: null,
    root: recordId(`rec_${id}`),
    at: timestamp(at),
  };
}

/** A journal that holds `history`, then says `live` one record at a time, `gap` milliseconds apart. */
function journal(history: StoredRecord[], live: StoredRecord[], gap: number): { api: NiwaApi; since: Array<number | undefined> } {
  const since: Array<number | undefined> = [];
  const api = {
    records: {
      read: async (query?: { from?: number }) => history.filter((record) => record.seq > (query?.from ?? 0)),
      since: (query?: { from?: number }) => {
        since.push(query?.from);
        return (async function* () {
          for (const record of live) {
            await Bun.sleep(gap);
            yield record;
          }
          await new Promise(() => undefined);
        })();
      },
    },
  } as unknown as NiwaApi;
  return { api, since };
}

test("the feed as it stands does not wait for the live subscription to say anything", async () => {
  const { api } = journal([request(1, "a")], [], 100);
  const feed = await readFeed(api);
  expect(feed.map((entry) => entry.id)).toEqual(["a"]);
});

test("a followed feed starts with the list as it stands and goes on from the last record it read", async () => {
  const { api, since } = journal([request(1, "a"), request(2, "b")], [request(3, "c")], 10);
  const lists: string[][] = [];
  const followed = await followFeed(api, (entries) => lists.push(entries.map((entry) => entry.id)), () => undefined);
  try {
    expect(followed.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(since).toEqual([2]);
    await Bun.sleep(150);
    expect(lists).toEqual([["a", "b", "c"]]);
  } finally {
    followed.stop();
  }
});

test("a steady stream of records gets its lists out while it runs", async () => {
  const live = Array.from({ length: 60 }, (_, index) => request(index + 2, `r${String(index)}`));
  const { api } = journal([request(1, "a")], live, 10);
  const lists: number[] = [];
  const followed = await followFeed(api, (entries) => lists.push(entries.length), () => undefined);
  try {
    await Bun.sleep(300);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(lists.at(-1)).toBeGreaterThan(lists[0] ?? 0);
  } finally {
    followed.stop();
  }
});
