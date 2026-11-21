/**
 * Records as the cockpit receives them, and how a page says which ones it wants.
 *
 * The types come from the client package as types only: its runtime opens sockets and files and
 * has no place in a browser.
 */

import type { NiwaApi } from "@niwa-labs/client";

/** A committed record of the journal. */
export type StoredRecord = Awaited<ReturnType<NiwaApi["records"]["read"]>>[number];

/** Which records a reader wants. Every field narrows; an empty match takes every record. */
export type RecordMatch = {
  /**
   * Record type names. A name ending in `.*` takes every type under that prefix:
   * `workflow.*` matches `workflow.run.started` but not `workflowx.a`.
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
  if (match.types !== undefined && !match.types.some((pattern) => typeMatches(pattern, record.type))) return false;
  return match.where === undefined || match.where(record);
}
