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

/**
 * The stream as modules see it: they read and subscribe, the cockpit alone opens, stops and
 * feeds it.
 */
export interface RecordFeed {
  readonly store: Pick<StoreApi<StreamState>, "getState" | "getInitialState" | "subscribe">;
  /**
   * The current state of a projection, folded up to the newest record. The fold is cached by
   * the projection object, so define projections once, at module scope, not inside a render.
   */
  project<S>(projection: Projection<S>): S;
}

export interface RecordStream extends RecordFeed {
  readonly store: StoreApi<StreamState>;
  /** Open the feed after the given position. Starting a started stream does nothing; a failed one starts again. */
  start(after?: number): void;
  stop(): void;
  /**
   * Add records read some other way, such as a page of history. Records older than those held
   * are merged in order and every projection is folded again from the start.
   */
  ingest(records: readonly StoredRecord[]): void;
}

export type RecordStreamOptions = {
  /** How many records the stream keeps in memory; older ones are dropped. */
  retain?: number | undefined;
};

type Folded = { generation: number; seq: number; state: unknown };

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
  // Bumped when older records are merged in: every cached fold is then stale.
  let generation = 0;

  function keep(all: readonly StoredRecord[]): readonly StoredRecord[] {
    return all.length > retain ? all.slice(all.length - retain) : all;
  }

  function append(incoming: readonly StoredRecord[]): void {
    const { records, seq } = store.getState();
    const fresh = incoming.filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0) return;
    store.setState({ records: keep(records.concat(fresh)), seq: fresh[fresh.length - 1]!.seq });
  }

  function ingest(incoming: readonly StoredRecord[]): void {
    const { records, seq } = store.getState();
    const known = new Set(records.map((r) => r.seq));
    const unknown = incoming.filter((r) => !known.has(r.seq));
    // Records after the newest held simply extend the stream.
    if (unknown.every((r) => r.seq > seq)) return append(unknown);
    const merged = new Map<number, StoredRecord>();
    for (const r of [...records, ...unknown]) merged.set(r.seq, r);
    const all = keep([...merged.values()].sort((a, b) => a.seq - b.seq));
    // Records that land before the newest one change what every projection has seen, unless
    // the retention limit drops them again at once.
    if (all.some((r) => r.seq <= seq && !known.has(r.seq))) generation += 1;
    store.setState({ records: all, seq: Math.max(seq, all[all.length - 1]?.seq ?? seq) });
  }

  async function follow(after: number, signal: AbortSignal): Promise<void> {
    try {
      // Records come one by one; those that arrive before the next task are committed together,
      // so a burst from the feed is one update of the store.
      let batch: StoredRecord[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = (): void => {
        timer = undefined;
        const taken = batch;
        batch = [];
        if (!signal.aborted) append(taken);
      };
      const feed = {
        signal,
        onOpen: () => store.setState({ status: "live", error: undefined }),
        onRetry: (error: unknown) => store.setState({ status: "retrying", error: describe(error) }),
      };
      try {
        for await (const record of client.records.since(after, feed)) {
          batch.push(record);
          timer ??= setTimeout(flush, 0);
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
          flush();
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      // Let a later start open the feed again.
      if (abort?.signal === signal) abort = undefined;
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
    ingest,
    project<S>(projection: Projection<S>): S {
      const { records } = store.getState();
      const key = projection as Projection<unknown>;
      const previous = folded.get(key);
      const cached = previous?.generation === generation ? previous : { generation, seq: -1, state: projection.initial };
      const from = firstAfter(records, cached.seq);
      if (from >= records.length) {
        if (previous !== cached) folded.set(key, cached);
        return cached.state as S;
      }
      const matching = records.slice(from).filter((r) => matchRecord(projection.match, r));
      let state = cached.state as S;
      if (matching.length > 0) {
        if (projection.reduceMany !== undefined) state = projection.reduceMany(state, matching);
        else for (const r of matching) state = projection.reduce!(state, r);
      }
      folded.set(key, { generation, seq: records[records.length - 1]!.seq, state });
      return state;
    },
  };
}
