/**
 * trace.ts — what was done and why.
 *
 * Two directions, both from the core's own observation API:
 *
 * - UP: the causes of a record — what it depends on. Walking up far enough reaches the external
 *   input that started the whole chain: the record whose cause is nothing.
 * - DOWN: the trace of a record — everything that grew from it.
 *
 * Every record of the chain links to its own trace page, so from any result one can walk to the
 * message that started it.
 */

import type { NiwaApi } from "@niwa-labs/client";
import type { RecordId, StoredRecord } from "@niwa-labs/core";

/** One record of a chain, as the page shows it. */
export interface ChainRecord {
  /** The id of the record. */
  readonly id: string;
  /** The type of the record: what kind of fact it is. */
  readonly type: string;
  /** The data of the record, as it was written. */
  readonly data: unknown;
  /** Who wrote it. */
  readonly actor: string;
  /** The record it was made from, when it was made from one. */
  readonly cause: string | null;
  /** The first record of the chain it belongs to. */
  readonly root: string;
  /** When it was written. */
  readonly at: number;
  /** How far down from the start of the walk it is; 0 for the start itself and for every cause. */
  readonly depth: number;
}

/** The chain of one record: what it depends on, and what grew from it. */
export interface Chain {
  /** The record the chain is about. */
  readonly record: string;
  /** What it depends on: the walk UP. The external input is the last of them. */
  readonly causes: readonly ChainRecord[];
  /** What grew from it: the walk DOWN. */
  readonly trace: readonly ChainRecord[];
  /** The record that started the chain: the one whose cause is nothing. */
  readonly root: string | null;
}

/** How a record says who wrote it. */
function actorOf(record: StoredRecord): string {
  const actor = record.actor;
  if (actor.kind === "host") return "host";
  if (actor.kind === "client") return actor.id;
  return actor.handler;
}

/**
 * The chain of a record: what it depends on, and what grew from it.
 *
 * The root is the one the journal recorded on the record itself; an unknown record has none.
 */
export async function chainOf(api: NiwaApi, id: RecordId): Promise<Chain> {
  const [causes, traced] = await Promise.all([api.causes(id), api.trace(id)]);
  const start = traced.find((record) => record.depth === 0);
  return {
    record: id,
    causes: causes.map((record) => toChain(record, 0)),
    trace: traced.map((record) => toChain(record, record.depth)),
    root: start?.root ?? null,
  };
}

/** One record of a chain, as the page shows it. */
function toChain(record: StoredRecord, depth: number): ChainRecord {
  return {
    id: record.id,
    type: record.type,
    data: record.data,
    actor: actorOf(record),
    cause: record.cause,
    root: record.root,
    at: record.at,
    depth,
  };
}
