// Records and a scripted host client for the tests.

import type { FollowOptions, HostClient, RecordQuery, StoredRecord } from "../src/index.ts";

export function rec(seq: number, type = "demo.event", stream = "main", data: unknown = {}): StoredRecord {
  return {
    id: `r${seq}`,
    seq,
    stream,
    type,
    schema: 1,
    data,
    actor: { kind: "host" },
    cause: null,
    root: `r${seq}`,
    at: 1_700_000_000_000 + seq,
  } as unknown as StoredRecord;
}

/** A host client whose feed is pushed by the test. */
export function scriptedClient(): {
  client: HostClient;
  push(...records: StoredRecord[]): void;
  fail(error: Error): void;
  opened: number[];
} {
  const opened: number[] = [];
  let push: (records: StoredRecord[]) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const client: HostClient = {
    call: (async () => {
      throw new Error("no calls in this test");
    }) as HostClient["call"],
    info: async () => ({ actions: [] }),
    records: {
      read: async () => [],
      async *since(query: RecordQuery | undefined, opts?: FollowOptions) {
        opened.push(query?.from ?? 0);
        opts?.onOpen?.();
        const queue: StoredRecord[] = [];
        let failure: Error | undefined;
        let wake: () => void = () => {};
        push = (records) => {
          queue.push(...records);
          wake();
        };
        fail = (error) => {
          failure = error;
          wake();
        };
        const aborted = new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve()));
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (failure !== undefined) throw failure;
          const next = new Promise<void>((resolve) => (wake = resolve));
          await Promise.race([next, aborted]);
          if (opts?.signal?.aborted === true) return;
        }
      },
    },
  };
  return { client, push: (...records) => push(records), fail: (error) => fail(error), opened };
}

/** Let pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
