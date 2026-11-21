/**
 * The lines of a pi session file: a header, then the entries of the conversation tree.
 *
 * HAND-WRITTEN, from `packages/coding-agent/src/core/session-manager.ts` of pi 1.5.2 (commit
 * 22fc026b8): `SessionHeader`, `SessionEntry` and its eleven variants. The same entries come over
 * the RPC wire in `entry_appended`, `get_entries` and `get_tree`.
 */

import { z } from "zod";

import {
  AssistantBlockSchema,
  CustomMessageSchema,
  InputBlockSchema,
  KnownMessageSchema,
  PiJsonSchema,
  SystemMessageSchema,
  UsageSchema,
} from "./messages.ts";

/** The first line of the file: what is known about the session. */
export const SessionHeaderSchema = z.looseObject({
  type: z.literal("session"),
  version: z.number().optional(),
  id: z.string().min(1),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  /** The file of the session this one was forked from. */
  parentSession: z.string().optional(),
});
export type SessionHeader = z.output<typeof SessionHeaderSchema>;

/**
 * The fields every entry carries: its place in the tree. pi migrates an old file when it opens it
 * but does not always write the migration back, so a file on disk may be a version that has no
 * tree (`version` of the header is absent for v1): the fields are optional here.
 */
const base = {
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  timestamp: z.string().optional(),
};

export const MessageEntrySchema = z.looseObject({
  type: z.literal("message"),
  ...base,
  message: KnownMessageSchema,
});

export const ThinkingLevelChangeEntrySchema = z.looseObject({
  type: z.literal("thinking_level_change"),
  ...base,
  thinkingLevel: z.string(),
});

export const ModelChangeEntrySchema = z.looseObject({
  type: z.literal("model_change"),
  ...base,
  provider: z.string(),
  modelId: z.string(),
});

/** Accounting for a call that is not part of the conversation, such as a cache warm. */
export const UsageEntrySchema = z.looseObject({
  type: z.literal("usage"),
  ...base,
  kind: z.string(),
  provider: z.string(),
  model: z.string(),
  usage: UsageSchema,
  note: z.string().optional(),
});

export const CompactionEntrySchema = z.looseObject({
  type: z.literal("compaction"),
  ...base,
  summary: z.string(),
  firstKeptEntryId: z.string().optional(),
  tokensBefore: z.number().optional(),
  details: PiJsonSchema.optional(),
  usage: UsageSchema.optional(),
  fromHook: z.boolean().optional(),
  systemMessage: SystemMessageSchema.optional(),
});

export const BranchSummaryEntrySchema = z.looseObject({
  type: z.literal("branch_summary"),
  ...base,
  fromId: z.string(),
  summary: z.string(),
  details: PiJsonSchema.optional(),
  usage: UsageSchema.optional(),
  fromHook: z.boolean().optional(),
});

/** State an extension keeps in the session; it is not part of the model's context. */
export const CustomEntrySchema = z.looseObject({
  type: z.literal("custom"),
  ...base,
  customType: z.string(),
  data: PiJsonSchema.optional(),
});

/** A message an extension injected into the model's context. */
export const CustomMessageEntrySchema = z.looseObject({
  type: z.literal("custom_message"),
  ...base,
  customType: z.string(),
  content: CustomMessageSchema.shape.content,
  details: PiJsonSchema.optional(),
  display: z.boolean(),
});

/** An append-only change to what one earlier entry contributes to the model's context. */
export const ContextEditEntrySchema = z.looseObject({
  type: z.literal("context_edit"),
  ...base,
  targetId: z.string(),
  replacement: z
    .object({
      content: z.union([z.string(), z.array(z.union([InputBlockSchema, AssistantBlockSchema]))]),
    })
    .nullable(),
});

export const LabelEntrySchema = z.looseObject({
  type: z.literal("label"),
  ...base,
  targetId: z.string(),
  label: z.string().optional(),
});

/** Metadata of the session: the name its owner gave it. */
export const SessionInfoEntrySchema = z.looseObject({
  type: z.literal("session_info"),
  ...base,
  name: z.string().optional(),
});

/** The entries of the conversation tree, by `type`. */
export const SessionEntrySchema = z.discriminatedUnion("type", [
  MessageEntrySchema,
  ThinkingLevelChangeEntrySchema,
  ModelChangeEntrySchema,
  UsageEntrySchema,
  CompactionEntrySchema,
  BranchSummaryEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  ContextEditEntrySchema,
  LabelEntrySchema,
  SessionInfoEntrySchema,
]);
export type SessionEntry = z.output<typeof SessionEntrySchema>;

/** One line of the file: the header or an entry. */
export const FileEntrySchema = z.discriminatedUnion("type", [SessionHeaderSchema, ...SessionEntrySchema.options]);

/** A node of `get_tree`: an entry and what continues from it. */
export interface SessionTreeNode {
  readonly entry: SessionEntry;
  readonly children: readonly SessionTreeNode[];
  readonly label?: string | undefined;
  readonly labelTimestamp?: string | undefined;
}

export const SessionTreeNodeSchema: z.ZodType<SessionTreeNode> = z.lazy(() =>
  z.looseObject({
    entry: SessionEntrySchema,
    children: z.array(SessionTreeNodeSchema),
    label: z.string().optional(),
    labelTimestamp: z.string().optional(),
  }),
);
