/**
 * The records of the history side: what a read, a search and the coverage of a transcript are given and answer with.
 * The transcript itself is never written into the journal.
 */

import { z } from "zod";

import {
  AssistantRecordSchema,
  CompactionRecordSchema,
  NestedRecordSchema,
  ThinkingRecordSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  UnknownRecordSchema,
  UserRecordSchema,
} from "@niwa-labs/harness";

/** How many matches a search answers with when it is not told. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** How many matches a search answers with at most. */
export const MAX_SEARCH_LIMIT = 200;

/** What a search is given, beside what it searches in. */
export const SearchQuerySchema = z.object({
  /** The text looked for: every word of it must be in a record, case aside. */
  query: z.string().trim().min(1),
  /** How many matches to answer with. Default: 20. */
  limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
  /** How many matches to skip first. Default: 0. */
  offset: z.number().int().nonnegative().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** One record that matched. */
export const SearchMatchSchema = z.object({
  /** The number of the record in the transcript, counted from 0 over every record. */
  index: z.number().int().nonnegative(),
  /** The kind of the record. */
  kind: z.string().min(1),
  /** Where the record is, as the reading side names it. */
  locator: z.string().min(1),
  /** A short piece of the record around the first word that matched. */
  snippet: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

/** How much was read: only `empty` says there is nothing. */
export const CoverageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-scanned") }),
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

/**
 * The record of a session, as the actions report it.
 *
 * The same kinds the reading side speaks (the harness reading contract), each with its own fields: the
 * text of a message, the name and the input of a tool call, the summary of a compaction, the id
 * of a nested session. `raw` stays out: the harness's own record whole is asked for separately,
 * on demand.
 */
export const SessionRecordSchema = z.discriminatedUnion("kind", [
  UserRecordSchema,
  AssistantRecordSchema,
  ThinkingRecordSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  CompactionRecordSchema,
  NestedRecordSchema,
  // The raw data of an unfamiliar record is kept by the reading side, not published here.
  UnknownRecordSchema.omit({ raw: true }),
]);
