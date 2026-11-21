/**
 * What a compressed reading of a session is made of. Every entry names the record it came from
 * (`source`): its locator, so the whole of it can be read again, and a digest of it, so a reader can
 * tell the record is still the one that was compressed.
 */

import { z } from "zod";

import { ChecklistItemSchema, LocatorSchema, SessionIdSchema, SessionRecordSchema, ToolCategorySchema } from "@niwa-labs/harness";

/** How much of a session a reading keeps. */
export const DigestModeSchema = z.enum(["full", "digest", "brief"]);
export type DigestMode = z.output<typeof DigestModeSchema>;

/** The record an entry came from. */
export const SourceSchema = z.object({
  locator: LocatorSchema,
  /** The first twelve hex digits of the SHA-256 of the record as the reading side gave it. */
  digest: z.string().regex(/^[0-9a-f]{12}$/),
});
export type Source = z.output<typeof SourceSchema>;

/** How a tool call ended: `pending` while its result is not in what was read. */
export const CallStatusSchema = z.enum(["done", "failed", "pending"]);
export type CallStatus = z.output<typeof CallStatusSchema>;

const ChecklistProgressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(ChecklistItemSchema),
});

/** One entry of a digest. */
export const DigestEntrySchema = z.discriminatedUnion("kind", [
  /** What the person said, whole, without what the harness wrapped around it. */
  z.object({ kind: z.literal("user"), text: z.string(), source: SourceSchema }),
  /** What the agent said, whole. */
  z.object({ kind: z.literal("assistant"), text: z.string(), source: SourceSchema }),
  /** What the agent thought, whole; a sealed thought has no text. */
  z.object({ kind: z.literal("thinking"), text: z.string(), redacted: z.boolean(), source: SourceSchema }),
  /**
   * A tool call on one line: what it does, what it is about, how it ended, its arguments cut short,
   * and its result cut in the middle. Paths are written once and referred to by the file index after.
   */
  z.object({
    kind: z.literal("tool"),
    callId: z.string().min(1),
    category: ToolCategorySchema,
    name: z.string().min(1),
    target: z.string().optional(),
    args: z.string().optional(),
    status: CallStatusSchema,
    result: z.string().optional(),
    source: SourceSchema,
    /** The record of the result, when it was read. */
    resultSource: SourceSchema.optional(),
  }),
  /** The result of a call made before what was read. */
  z.object({
    kind: z.literal("result"),
    callId: z.string().min(1),
    status: CallStatusSchema,
    result: z.string().optional(),
    source: SourceSchema,
  }),
  z.object({ kind: z.literal("compaction"), summary: z.string(), source: SourceSchema }),
  z.object({ kind: z.literal("checklist"), ...ChecklistProgressSchema.shape, source: SourceSchema }),
  z.object({
    kind: z.literal("permission"),
    tool: z.string().optional(),
    outcome: z.enum(["allowed", "denied", "unanswered"]),
    source: SourceSchema,
  }),
  z.object({ kind: z.literal("nested"), child: SessionIdSchema, source: SourceSchema }),
]);
export type DigestEntry = z.output<typeof DigestEntrySchema>;

/** A message with the record it came from. */
const SaidSchema = z.object({ text: z.string(), source: SourceSchema });

/** A session in brief: what was asked, what was answered, what was changed and how far it got. */
export const BriefSchema = z.object({
  /** The person's messages. */
  asked: z.array(SaidSchema),
  /** The last message of the agent in each turn. */
  answered: z.array(SaidSchema),
  /** The paths edit calls named, each once. */
  changed: z.array(z.string()),
  /** How many calls of each category were made. */
  calls: z.partialRecord(ToolCategorySchema, z.number().int().positive()),
  /** How many calls failed. */
  failed: z.number().int().nonnegative(),
  /** The agent's checklist as it last stood, when it kept one. */
  checklist: ChecklistProgressSchema.optional(),
  /**
   * Where the session stands: `answered` when the agent spoke last, `working` when a call or a
   * message waits for it, `empty` when nothing was read.
   */
  outcome: z.enum(["answered", "working", "empty"]),
});
export type Brief = z.output<typeof BriefSchema>;

/** A reading in one of the modes. */
export const DigestViewSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full"), records: z.array(SessionRecordSchema) }),
  z.object({ mode: z.literal("digest"), entries: z.array(DigestEntrySchema) }),
  z.object({ mode: z.literal("brief"), brief: BriefSchema }),
]);
export type DigestView = z.output<typeof DigestViewSchema>;
