/**
 * Causes and links: how one record is connected to another.
 *
 * `cause` and `root` are the primary, readable chain: one cause per record, set by the runtime
 * and never by the author of the code. A record can depend on more than one thing — a merged
 * result depends on several reports — and those other dependencies are rows in a link table,
 * indexed both ways.
 *
 * Two queries are part of the core:
 *
 * - `trace(id)` walks DOWN: from a record to everything that grew from it, through causes and
 *   links, depth-first, each record once.
 * - `causes(id)` walks UP: from a record to what it depends on, through its cause and its links.
 *
 * The link table lives in the journal's own database, so a link is committed together with the
 * record it belongs to: a record that exists has its links.
 */

import type { Journal, RecordId, StoredRecord, TracedRecord } from "./types.ts";

/**
 * Walk DOWN from a record: everything that grew from it, through causes and links.
 *
 * Listed depth-first, each record once. The depth is the shortest way down: a record the start
 * caused directly is at depth 1 even when a link also reaches it through a longer path. The record
 * the trace started from is at depth 0.
 *
 * The walk is over the committed journal, so it answers what is true now, not what is still
 * coming.
 */
export function trace(journal: Journal, id: RecordId): TracedRecord[] {
  if (journal.get(id) === undefined) return [];

  const children = new Map<RecordId, RecordId[]>();
  const childrenOf = (of: RecordId): RecordId[] => {
    let found = children.get(of);
    if (found === undefined) {
      found = journal.dependentsOf(of);
      children.set(of, found);
    }
    return found;
  };

  const depth = new Map<RecordId, number>([[id, 0]]);
  for (let level = [id], d = 1; level.length > 0; d++) {
    const next: RecordId[] = [];
    for (const parent of level) {
      for (const child of childrenOf(parent)) {
        if (depth.has(child)) continue;
        depth.set(child, d);
        next.push(child);
      }
    }
    level = next;
  }

  const out: TracedRecord[] = [];
  const listed = new Set<RecordId>();
  const stack: RecordId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || listed.has(current)) continue;
    listed.add(current);
    const record = journal.get(current);
    if (record === undefined) continue;
    out.push({ ...record, depth: depth.get(current) ?? 0 });
    // Pushed in reverse, so the first child is walked first.
    stack.push(...childrenOf(current).toReversed());
  }
  return out;
}

/**
 * Walk UP from a record: what it depends on, through its cause and its links.
 *
 * Depth-first, each record once, and the start is not included: the answer is what the record
 * was made of, not the record itself. A record's cause comes before its links, which keep the
 * order they were written in.
 */
export function causes(journal: Journal, id: RecordId): StoredRecord[] {
  const seen = new Set<RecordId>();
  const out: StoredRecord[] = [];
  const stack: RecordId[] = [id];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const record = journal.get(current);
    if (record === undefined) continue;
    if (current !== id) out.push(record);

    const parents = journal.linksOf(current);
    if (record.cause !== null) parents.unshift(record.cause);
    // Pushed in reverse, so the first parent is walked first.
    for (let i = parents.length - 1; i >= 0; i--) {
      const parent = parents[i];
      if (parent !== undefined) stack.push(parent);
    }
  }
  return out;
}
