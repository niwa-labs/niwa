/**
 * A simple search through a session's transcript.
 *
 * The transcript is read through the harness's reading side, as `session.read` reads it, and
 * nothing is copied: a query is matched against each record as it goes by. The match is plain
 * text: every word of the query must be in the record, case aside. There is no index and no
 * embedding.
 *
 * The index of a match counts every record the reading side gives, from the first one, so it is
 * the same index a later fetch of a record uses.
 */

import { failedCoverage } from "@niwa-labs/harness";
import type { Coverage, SessionId, SessionReading, SessionRecord } from "@niwa-labs/harness";

import { DEFAULT_SEARCH_LIMIT } from "./records.ts";
import type { SearchMatch, SearchQuery } from "./records.ts";

/** How far around the match a snippet reaches, on each side. */
const SNIPPET_REACH = 60;

/** The words of a query, lower case. */
function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
}

/**
 * The snippet of a text that holds every word of the query, or `undefined` when it does not.
 *
 * The snippet is the text around the first word found, whitespace collapsed, cut with "…" where
 * the text goes on.
 */
export function matchText(text: string, query: string): string | undefined {
  const words = wordsOf(query);
  if (words.length === 0) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at < 0) return undefined;
    if (first < 0 || at < first) first = at;
  }
  const start = Math.max(0, first - SNIPPET_REACH);
  const end = Math.min(flat.length, first + SNIPPET_REACH);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** A value as text: a string as it is, anything else as JSON. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** The text of a record that a search looks in; an unknown or nested record has none. */
export function recordText(record: SessionRecord): string | undefined {
  switch (record.kind) {
    case "user":
    case "assistant":
    case "thinking":
      return record.text;
    case "compaction":
      return record.summary;
    case "tool-call":
      return `${record.name} ${asText(record.input)}`;
    case "tool-result":
      return `${record.name ?? ""} ${asText(record.output)}`;
    case "nested":
    case "unknown":
      return undefined;
  }
}

/**
 * Search the records of a transcript.
 *
 * It reads only as far as it needs: once it has the matches it answers with and knows whether
 * there are more, it stops reading.
 */
export async function searchRecords(
  records: AsyncIterable<SessionRecord>,
  query: SearchQuery,
): Promise<{ matches: SearchMatch[]; more: boolean }> {
  const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = query.offset ?? 0;
  const matches: SearchMatch[] = [];
  let found = 0;
  let index = 0;
  for await (const record of records) {
    const text = recordText(record);
    const snippet = text === undefined ? undefined : matchText(text, query.query);
    if (snippet !== undefined) {
      if (found >= offset + limit) return { matches, more: true };
      if (found >= offset) matches.push({ index, kind: record.kind, locator: record.locator, snippet });
      found += 1;
    }
    index += 1;
  }
  return { matches, more: false };
}

/**
 * Search a session through its reading side, and say how much of it was read.
 *
 * A read that fails is not "no matches": what matched before the failure is kept, and the coverage
 * says `failed` with the reason. A session the side does not hold, or holds empty, is said in the
 * coverage too, so a search that found nothing can be told from one that could not look.
 */
export async function searchTranscript(
  reading: SessionReading,
  id: SessionId,
  query: SearchQuery,
): Promise<{ matches: SearchMatch[]; more: boolean; coverage: Coverage }> {
  let failure: string | undefined;
  const guarded = async function* (): AsyncGenerator<SessionRecord> {
    try {
      yield* reading.read(id);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  };
  const found = await searchRecords(guarded(), query);
  if (failure !== undefined) return { ...found, coverage: failedCoverage(failure) };
  try {
    return { ...found, coverage: await reading.coverage(id) };
  } catch (error) {
    return { ...found, coverage: failedCoverage(error instanceof Error ? error.message : String(error)) };
  }
}
