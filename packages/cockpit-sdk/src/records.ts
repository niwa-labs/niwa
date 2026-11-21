/**
 * Records as the cockpit receives them, and how a page says which ones it wants.
 *
 * The types come from the client package as types only: its runtime opens sockets and files and
 * has no place in a browser.
 */

import type { NiwaApi } from "@niwa-labs/client";

/** A committed record of the journal. */
export type StoredRecord = Awaited<ReturnType<NiwaApi["records"]["read"]>>[number];

/**
 * Which records the host is asked for, history and live continuation alike: the same query the
 * host's own clients take, in the form that travels. Every field narrows.
 */
export type RecordQuery = {
  /** Exact type names or families written `prefix.*`; every type when absent or empty. */
  types?: readonly string[] | undefined;
  /** Equality on fields of the data, by field name or dotted path. */
  filter?: Readonly<Record<string, unknown>> | undefined;
  /** Only records of this stream. */
  stream?: string | undefined;
  /** The position to read after, exclusive; the start of the journal when absent. */
  from?: number | undefined;
};

/** Which records a reader wants. Every field narrows; an empty match takes every record. */
export type RecordMatch = {
  /**
   * Record type names; none, or an empty list, takes every type. A name ending in `.*` takes
   * every type under that prefix: `workflow.*` matches `workflow.run.started` but not `workflowx.a`.
   */
  types?: readonly string[] | undefined;
  /** Only records of this stream. */
  stream?: string | undefined;
  /** Any further condition on the record. */
  where?: ((record: StoredRecord) => boolean) | undefined;
};

function typeMatches(pattern: string, type: string): boolean {
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export function matchRecord(match: RecordMatch, record: StoredRecord): boolean {
  if (match.stream !== undefined && record.stream !== match.stream) return false;
  if (match.types !== undefined && match.types.length > 0 && !match.types.some((pattern) => typeMatches(pattern, record.type))) return false;
  return match.where === undefined || match.where(record);
}

/** Whether a value read from the wire has every field of a stored record, so a page can rely on them. */
export function isStoredRecord(value: unknown): value is StoredRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const text = (field: string): boolean => typeof r[field] === "string";
  const actor = r.actor as { kind?: unknown } | null;
  return (
    text("id") &&
    typeof r.seq === "number" &&
    Number.isSafeInteger(r.seq) &&
    text("stream") &&
    text("type") &&
    typeof r.schema === "number" &&
    text("root") &&
    (r.cause === null || typeof r.cause === "string") &&
    typeof r.at === "number" &&
    actor !== null &&
    typeof actor === "object" &&
    (actor.kind === "host" || actor.kind === "client" || actor.kind === "handler")
  );
}
