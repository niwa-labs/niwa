/**
 * The live record stream of the cockpit: one connection to the host's feed, shared by every
 * page and module, kept in a store that components subscribe to.
 *
 * Pages do not keep their own copy of the journal. They describe what they want as a
 * projection — which records, and how to fold them into a view — and read the folded state.
 * A projection is folded incrementally and its state is cached per stream, so a component
 * re-renders only when a record it cares about arrives.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import type { HostClient } from "./host-client.ts";
import { matchRecord, type RecordMatch, type StoredRecord } from "./records.ts";

export type StreamStatus =
  /** Not started, or stopped. */
  | "idle"
  /** Started; no record or confirmation from the feed yet. */
  | "connecting"
  | "live"
  /** The feed broke; it is being reopened after the last record received. */
  | "retrying"
  /** The feed ended with an error that retrying cannot fix, such as a lost login. */
  | "failed";

export type StreamState = {
  status: StreamStatus;
  /** The position of the last record received; the stream resumes after it. */
  seq: number;
  /** The records received, oldest first, at most `retain` of them. */
  records: readonly StoredRecord[];
  /** Why the stream failed. */
  error: string | undefined;
};

/** A view folded from the records that match. */
export type Projection<S> = {
  readonly match: RecordMatch;
  readonly initial: S;
  /** Fold one record into the state. Return the same state when nothing changed. */
  readonly reduce?: ((state: S, record: StoredRecord) => S) | undefined;
  /** Fold several records at once, oldest first; used in place of `reduce` when given. */
  readonly reduceMany?: ((state: S, records: readonly StoredRecord[]) => S) | undefined;
};

export function defineProjection<S>(projection: Projection<S>): Projection<S> {
  if (projection.reduce === undefined && projection.reduceMany === undefined) {
    throw new TypeError("a projection needs reduce or reduceMany");
  }
  return projection;
}

/** The matching records themselves, the newest `limit` of them. */
export function recordList(match: RecordMatch, limit = 500): Projection<readonly StoredRecord[]> {
  return defineProjection<readonly StoredRecord[]>({
    match,
    initial: [],
    reduceMany: (state, records) => {
      const next = state.concat(records);
      return next.length > limit ? next.slice(next.length - limit) : next;
    },
  });
}

export interface RecordStream {
  readonly store: StoreApi<StreamState>;
  /** Open the feed after the given position. Starting a started stream does nothing. */
  start(after?: number): void;
  stop(): void;
  /** Add records read some other way, such as a history page; known positions are skipped. */
  ingest(records: readonly StoredRecord[]): void;
  /** The current state of a projection, folded up to the newest record. */
  project<S>(projection: Projection<S>): S;
}

export type RecordStreamOptions = {
  /** How many records the stream keeps in memory; older ones are dropped. */
  retain?: number | undefined;
};

type Folded = { seq: number; state: unknown };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The index of the first record after `seq`, by binary search over positions. */
function firstAfter(records: readonly StoredRecord[], seq: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (records[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A stream over a host client.
 *
 * A projection sees the records from where the stream started, as far as `retain` keeps them:
 * one first read after older records were dropped begins at the oldest record still kept.
 */
export function createRecordStream(client: HostClient, options: RecordStreamOptions = {}): RecordStream {
  const retain = options.retain ?? 10_000;
  const store = createStore<StreamState>(() => ({ status: "idle", seq: 0, records: [], error: undefined }));
  const folded = new WeakMap<Projection<unknown>, Folded>();
  let abort: AbortController | undefined;

  function append(incoming: readonly StoredRecord[]): void {
    const { records, seq } = store.getState();
    const fresh = incoming.filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0) return;
    const all = records.concat(fresh);
    store.setState({
      records: all.length > retain ? all.slice(all.length - retain) : all,
      seq: fresh[fresh.length - 1]!.seq,
    });
  }

  async function follow(after: number, signal: AbortSignal): Promise<void> {
    try {
      // Records come one by one; those that arrive in the same task are committed together.
      let batch: StoredRecord[] = [];
      let flush: Promise<void> | undefined;
      const feed = {
        signal,
        onOpen: () => store.setState({ status: "live", error: undefined }),
        onRetry: (error: unknown) => store.setState({ status: "retrying", error: describe(error) }),
      };
      for await (const record of client.records.since(after, feed)) {
        batch.push(record);
        flush ??= Promise.resolve().then(() => {
          const taken = batch;
          batch = [];
          flush = undefined;
          if (!signal.aborted) append(taken);
        });
      }
      await flush;
    } catch (error) {
      if (signal.aborted) return;
      store.setState({ status: "failed", error: describe(error) });
    }
  }

  return {
    store,
    start(after = store.getState().seq) {
      if (abort !== undefined) return;
      abort = new AbortController();
      store.setState({ status: "connecting", error: undefined });
      void follow(after, abort.signal);
    },
    stop() {
      abort?.abort();
      abort = undefined;
      store.setState({ status: "idle" });
    },
    ingest: append,
    project<S>(projection: Projection<S>): S {
      const { records } = store.getState();
      const key = projection as Projection<unknown>;
      const cached = folded.get(key) ?? { seq: -1, state: projection.initial };
      const from = firstAfter(records, cached.seq);
      if (from >= records.length) {
        if (!folded.has(key)) folded.set(key, cached);
        return cached.state as S;
      }
      const matching = records.slice(from).filter((r) => matchRecord(projection.match, r));
      let state = cached.state as S;
      if (matching.length > 0) {
        if (projection.reduceMany !== undefined) state = projection.reduceMany(state, matching);
        else for (const r of matching) state = projection.reduce!(state, r);
      }
      folded.set(key, { seq: records[records.length - 1]!.seq, state });
      return state;
    },
  };
}
