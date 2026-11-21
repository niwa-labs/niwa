/**
 * Groups of branches over `scope`: a keyed map in the order of its input, a stream read in the
 * order of outcomes and the two ways to choose from it, map-reduce in batches, a swarm of workers
 * and a consensus of seats. A branch's failure is a value (`Settled`), except a refusal of the grant
 * or a spent budget, which every helper throws.
 */

import type { Stream } from "@niwa-labs/script";

import { agentOptions, checkKey, checkKeys, errorOf, isFatal, script, seatKeys } from "./script.ts";
import type { Seat } from "./script.ts";
import type { Settled } from "./types.ts";

/** Branches at once by key, the answer in the same shape; a branch that fails cancels the others and its error is thrown. */
export function parallel<K extends string, T>(branches: Record<K, () => Promise<T>>, opts: { concurrency?: number } = {}): Promise<Record<K, T>> {
  return script().parallel(branches, opts) as Promise<Record<K, T>>;
}

/**
 * Run `fn` for every item, each in a branch keyed by `opts.key(item)`, at most `concurrency` at once.
 * The outcomes come in the order of the items, whichever ended first.
 */
export async function map<I, T>(
  key: string,
  items: readonly I[],
  opts: { key: (item: I) => string; concurrency?: number },
  fn: (item: I) => Promise<T>,
): Promise<Settled<T>[]> {
  checkKey(key, "the key of a map");
  const keys = checkKeys(items.map(opts.key), "the key of an item");
  return script().scope(key, opts.concurrency === undefined ? undefined : { concurrency: opts.concurrency }, async (s) => {
    const branches = items.map((item, index) => s.start(keys[index] as string, () => fn(item)));
    const out: Settled<T>[] = [];
    for (const branch of branches) {
      const settled = await branch.settled();
      // A refusal of the grant is not a value: the original error leaves the map, and the scope cancels the rest.
      if (!settled.ok && isFatal(settled.error)) await branch.value();
      out.push(settled);
    }
    return out;
  });
}

/** Branches read one outcome at a time, in the order the host committed them. Closing the stream cancels the rest. */
export function stream<K extends string, T>(key: string, branches: Record<K, () => Promise<T>>, opts: { concurrency?: number } = {}): Stream<K, T> {
  checkKey(key, "the key of a stream");
  checkKeys(Object.keys(branches), "the key of a branch");
  return script().stream(key, branches, opts) as Stream<K, T>;
}

/** The first outcome of a stream that succeeded and passes `pass`; the stream stays open. Null when none did. */
export async function firstPassing<K extends string, T>(s: Stream<K, T>, pass: (value: T) => boolean): Promise<{ key: K; value: T } | null> {
  for (let got = await s.next(); got !== null; got = await s.next()) {
    if (got.result.ok && pass(got.result.value)) return { key: got.key, value: got.result.value };
    if (!got.result.ok && isFatal(got.result.error)) throw errorOf(got.result);
  }
  return null;
}

/** Every outcome of a stream, then the one `rank` picks. The pick must be a branch that succeeded. */
export async function rankAll<K extends string, T>(
  s: Stream<K, T>,
  rank: (all: Record<K, Settled<T>>) => Promise<K>,
): Promise<{ key: K; value: T; all: Record<K, Settled<T>> }> {
  const all = await s.rest();
  for (const settled of Object.values<Settled<T>>(all)) if (!settled.ok && isFatal(settled.error)) throw errorOf(settled);
  const key = await rank(all);
  const picked = all[key];
  if (picked === undefined) throw new Error(`rankAll: "${key}" is not a branch of the stream`);
  if (!picked.ok) throw new Error(`rankAll: "${key}" failed (${picked.error.message}), it cannot be picked`);
  return { key, value: picked.value, all };
}

/**
 * Map items in batches of `batch` (8 by default) and reduce the outcomes. A batch is keyed by the
 * key of its first item; the outcomes reach `reduce` in the order of the batches.
 */
export async function mapReduce<I, M, R>(
  key: string,
  items: readonly I[],
  opts: { batch?: number; key: (item: I) => string; map: (batch: I[]) => Promise<M>; reduce: (parts: Settled<M>[]) => Promise<R>; concurrency?: number },
): Promise<R> {
  checkKey(key, "the key of a map-reduce");
  const size = opts.batch ?? 8;
  if (!Number.isInteger(size) || size < 1) throw new TypeError(`mapReduce: a batch is a whole number of items, at least one, not ${String(size)}`);
  checkKeys(items.map(opts.key), "the key of an item");
  const batches: I[][] = [];
  for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
  return script().scope(key, undefined, async () => {
    const parts = await map("map", batches, { key: (batch) => opts.key(batch[0] as I), ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, opts.map);
    return opts.reduce(parts);
  });
}

/**
 * Workers on briefs, each in a branch keyed by the brief's id. A result `valid` refuses is dropped;
 * with `respawn: 1` a worker that failed or was refused runs once more. `gaps` are the briefs with
 * no result in the end, `dropped` those whose result was refused.
 */
export async function swarm<B, R>(
  key: string,
  opts: { briefs: Record<string, B>; worker: (brief: B, id: string) => Promise<R>; valid?: (result: R, brief: B) => boolean; respawn?: 0 | 1; concurrency?: number },
): Promise<{ results: Record<string, R>; gaps: string[]; dropped: string[] }> {
  checkKey(key, "the key of a swarm");
  const ids = checkKeys(Object.keys(opts.briefs), "the id of a brief");
  const tries = 1 + (opts.respawn ?? 0);
  const outcomes = await map(key, ids, { key: (id) => id, ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, async (id) => {
    const brief = opts.briefs[id] as B;
    let refused = false;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let result: R;
      try {
        result = await opts.worker(brief, id);
      } catch (error) {
        if (error instanceof Error && isFatal(error)) throw error;
        if (attempt === tries) throw error;
        continue;
      }
      if (opts.valid === undefined || opts.valid(result, brief)) return { kept: true as const, result };
      refused = true;
    }
    return { kept: false as const, refused };
  });
  const results: Record<string, R> = {};
  const gaps: string[] = [];
  const dropped: string[] = [];
  outcomes.forEach((outcome, index) => {
    const id = ids[index] as string;
    if (outcome.ok && outcome.value.kept) results[id] = outcome.value.result;
    else {
      gaps.push(id);
      if (outcome.ok && outcome.value.refused) dropped.push(id);
    }
  });
  return { results, gaps, dropped };
}

/** The same work on every seat, then `agree` on the values that came back: null when they do not agree. */
export async function consensus<T>(
  key: string,
  opts: { seats: readonly Seat[]; run: (seat: Seat) => Promise<T>; agree: (all: T[]) => T | null },
): Promise<{ value: T | null; all: Settled<T>[] }> {
  const keys = seatKeys(opts.seats, "the key of a seat");
  const all = await map(key, opts.seats.map((seat, index) => ({ seat, key: keys[index] as string })), { key: (one) => one.key }, (one) => opts.run(one.seat));
  const values = all.flatMap((settled) => (settled.ok ? [settled.value] : []));
  return { value: values.length === 0 ? null : opts.agree(values), all };
}

/** Ask a seat with a schema: the call `agent()` makes for a seat. */
export function askSeat<T>(seat: Seat, prompt: string, schema: import("zod").z.ZodType<T>): Promise<T> {
  return script().agent(prompt, { ...agentOptions(seat), schema }) as Promise<T>;
}
