/**
 * The records of the history side: what a read, a search and the coverage of a transcript are given and answer with.
 * The transcript itself is never written into the journal.
 */

import { z } from "zod";

import { actionRef, record } from "@niwa-labs/core";
import { BriefSchema, DigestEntrySchema, DigestModeSchema, FileIndexSchema } from "@niwa-labs/digest";
import {
  AssistantRecordSchema,
  ChecklistRecordSchema,
  CompactionRecordSchema,
  HarnessIdSchema,
  LocatorSchema,
  SessionIdSchema,
  NestedRecordSchema,
  PermissionRecordSchema,
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
  ChecklistRecordSchema,
  PermissionRecordSchema,
  CompactionRecordSchema,
  NestedRecordSchema,
  // The raw data of an unfamiliar record is kept by the reading side, not published here.
  UnknownRecordSchema.omit({ raw: true }),
]);

export { FileIndexSchema };

/** How much of a session a read keeps: every record (`full`), a digest, or a brief. */
export const ReadModeSchema = DigestModeSchema;

/** How many tokens a window of a compressed read holds when it is not told. */
export const DEFAULT_READ_BUDGET = 40_000;

/** A window of a compressed read: what it holds, where the next starts, and the file index to give it. */
export const DigestReadSchema = z.object({
  view: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("digest"), entries: z.array(DigestEntrySchema) }),
    z.object({ mode: z.literal("brief"), brief: BriefSchema }),
  ]),
  /** Where the next window reads from (`from`); `null` when this one read to the end. */
  next: LocatorSchema.nullable(),
  /** The last record the window holds: where a session that still grows is read on from later. */
  upto: LocatorSchema.nullable(),
  /** The file index after this window: what the next read is given as `files`. */
  files: FileIndexSchema,
  /** How many records left nothing in the window. */
  omitted: z.number().int().nonnegative(),
  /**
   * True when the read started over: the position it was given belonged to another source, so the
   * window is the session from its beginning, and what was gathered from the windows before no longer holds.
   */
  restarted: z.boolean(),
});

/** A watch of a session began: the session, its harness, the directory it works in when the harness says, and its process when known. */
export const HistorySessionSeen = record(
  "history.session.seen",
  z.object({
    session: SessionIdSchema,
    harness: HarnessIdSchema,
    cwd: z.string().optional(),
    /** The process of the harness the session runs in, when the watch was given it. */
    pid: z.number().int().positive().optional(),
  }),
);

/** A watched session wrote nothing for a while: what it holds up to here can be worked on. */
export const HistorySessionPaused = record(
  "history.session.paused",
  z.object({ session: SessionIdSchema, upto: LocatorSchema, why: z.enum(["idle"]) }),
);

/**
 * What told a watch that its session is over:
 *
 * - `session-ended` — niwa ran the session, and its control side closed it;
 * - `end-hook` — the harness said so itself, through the insert inside it;
 * - `idle` — the transcript grew no record for longer than the watch waits;
 * - `process-gone` — the process of the harness the session ran in is gone;
 * - `new-binding` — another session of the same harness took its place in the same directory.
 */
export const EndSignalSchema = z.enum(["session-ended", "end-hook", "idle", "process-gone", "new-binding"]);
export type EndSignal = z.output<typeof EndSignalSchema>;

/** The signals that only suggest an end: the others say it. */
export const GUESSED_SIGNALS: readonly EndSignal[] = ["idle", "process-gone", "new-binding"];

/**
 * A watched session is over: `exact` when niwa or the harness said so, `guessed` when only a sign
 * points to it, which is all a transcript can tell of another harness's session.
 */
export const HistorySessionEnded = record(
  "history.session.ended",
  z.object({ session: SessionIdSchema, certainty: z.enum(["exact", "guessed"]), why: EndSignalSchema.optional() }),
);

/** A watch was stopped before the session ended. */
export const HistorySessionUnwatched = record("history.session.unwatched", z.object({ session: SessionIdSchema }));

/** How far the agent's checklist is, written when it changes; the checklist itself is read on demand. */
export const SessionProgress = record(
  "session.progress",
  z.object({ session: SessionIdSchema, done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
);

/** The record types the history plugin declares. */
export const HISTORY_TYPES = [HistorySessionSeen, HistorySessionPaused, HistorySessionEnded, HistorySessionUnwatched, SessionProgress] as const;

export const historyWatch = actionRef("history.watch", {
  description:
    "Follows a session of any harness while it grows: writes how far its checklist is when that changes, when it pauses, and when it ends (a guess for a session niwa did not start). Given the process of the harness the session runs in, its exit is taken for a sign of the end. Watching a session already watched changes nothing. A session niwa starts is watched by itself.",
  input: z.object({ session: SessionIdSchema, pid: z.number().int().positive().optional() }),
  output: z.object({ watching: z.boolean() }),
});

export const historySignal = actionRef("history.signal", {
  description:
    "Tells the watch of a session a sign of its end: `end-hook` (the harness said so) ends it exactly, `process-gone` and `new-binding` as a guess. A session nobody watches is left as it is.",
  input: z.object({ session: SessionIdSchema, signal: z.enum(["end-hook", "process-gone", "new-binding"]) }),
  output: z.object({ ended: z.boolean() }),
});

export const historyUnwatch = actionRef("history.unwatch", {
  description: "Stops following a session.",
  input: z.object({ session: SessionIdSchema }),
  output: z.object({ stopped: z.boolean() }),
});
