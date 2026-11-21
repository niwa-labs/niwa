// A core client with no host behind it, for the tests of the server's lifecycle and of what it watches.

import { actionName } from "@niwa-labs/core";
import type { ActionName, Description, StoredRecord } from "@niwa-labs/core";
import { HostError } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";

/** One action the fake host declares. */
export function declared(name: string, input: Record<string, unknown> = { type: "object", properties: {} }): Description["actions"][number] {
  return { name: actionName(name), description: `The action ${name}.`, recovery: "repeat", effect: "read", input, output: { type: "object" } };
}

/** What a read of the journal does on the fake host. */
export type ReadMode = "allowed" | "denied";

/** A host the tests drive: what it declares and what its journal holds are theirs to change. */
export class FakeHost {
  actions: Description["actions"] = [];
  /** The answers of the actions that are called, by action name. */
  readonly answers = new Map<string, (input: unknown) => unknown>();
  readMode: ReadMode = "allowed";
  /** How many times each action was called. */
  readonly calls: string[] = [];
  /** How many core clients were opened, and how many of them are still open. */
  opened = 0;
  open = 0;
  /** How long closing a client takes. */
  closeMs = 0;
  /** The queries the live subscriptions were opened with. */
  readonly subscriptions: Array<{ from?: number; types?: readonly string[] }> = [];
  private feeds = new Set<{ push: (record: StoredRecord) => void; end: () => void }>();
  private last = 0;

  /** The opener to give the server: one fake client per session. */
  readonly connect = async (): Promise<NiwaApi> => {
    this.opened += 1;
    this.open += 1;
    return this.api();
  };

  /** Commit a record: the live subscriptions receive it. */
  commit(type: string): StoredRecord {
    this.last += 1;
    const record = { seq: this.last, type, data: {} } as unknown as StoredRecord;
    for (const feed of this.feeds) feed.push(record);
    return record;
  }

  private api(): NiwaApi {
    let closed = false;
    const refuseUnlessAllowed = (): void => {
      if (this.readMode === "denied") {
        throw new HostError("niwa.records.read is not allowed", "DeniedError", { grant: "grant-1", missing: "call:niwa.records.read" });
      }
    };
    const api = {
      describe: async (): Promise<Description> => ({ actions: this.actions, types: [] }),
      call: async (action: ActionName | string, input: unknown): Promise<unknown> => {
        const name = String(action);
        this.calls.push(name);
        if (name === "niwa.records.read") {
          refuseUnlessAllowed();
          return { records: [], next: this.last };
        }
        const answer = this.answers.get(name);
        if (answer === undefined) throw new HostError(`no answer for ${name}`);
        return answer(input);
      },
      records: {
        read: async () => {
          refuseUnlessAllowed();
          return [];
        },
        since: (query?: { from?: number; types?: readonly string[] }) => {
          refuseUnlessAllowed();
          this.subscriptions.push({ ...(query?.from === undefined ? {} : { from: query.from }), ...(query?.types === undefined ? {} : { types: query.types }) });
          const waiting: Array<(next: IteratorResult<StoredRecord>) => void> = [];
          const queued: StoredRecord[] = [];
          let ended = false;
          const feed = {
            push: (record: StoredRecord) => {
              const wake = waiting.shift();
              if (wake === undefined) queued.push(record);
              else wake({ value: record, done: false });
            },
            end: () => {
              ended = true;
              for (const wake of waiting.splice(0)) wake({ value: undefined, done: true });
              this.feeds.delete(feed);
            },
          };
          this.feeds.add(feed);
          const iterator: AsyncIterableIterator<StoredRecord> = {
            [Symbol.asyncIterator]: () => iterator,
            next: () => {
              const record = queued.shift();
              if (record !== undefined) return Promise.resolve({ value: record, done: false });
              if (ended) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiting.push(resolve));
            },
            return: async () => {
              feed.end();
              return { value: undefined, done: true };
            },
          };
          return iterator;
        },
      },
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await new Promise((resolve) => setTimeout(resolve, this.closeMs));
        this.open -= 1;
        for (const feed of [...this.feeds]) feed.end();
      },
    };
    return api as unknown as NiwaApi;
  }
}

/** Wait until a condition holds. */
export async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
