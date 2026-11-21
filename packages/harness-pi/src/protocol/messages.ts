/**
 * pi's messages, as they cross the wire and as they sit in a session file.
 *
 * HAND-WRITTEN. pi publishes these only as TypeScript types, not as zod or JSON Schema, so there is
 * nothing to generate them from. Upstream: `@earendil-works/pi-coding-agent` 1.5.2 (commit 22fc026b8
 * of github.com/earendil-works/pi), `packages/ai/src/types.ts` (`Message` and its content blocks,
 * `Usage`) and `packages/coding-agent/src/core/messages.ts` (the messages the coding agent adds).
 * `models.schema.json` in that repo describes the `models.json` config file, not the wire.
 *
 * The fields that say when and by what a message was made (`timestamp`, `api`, `provider`, `usage`,
 * `stopReason`) are optional: a session file outlives the pi that wrote it, and a reader of what
 * pi already holds must read the older ones too. What the readers use is required.
 *
 * Every object is `looseObject`: pi grows fields, and a field this snapshot does not know is carried
 * and never an error. A variant this snapshot does not know at all is another matter, and each
 * union here is closed on purpose so that the code that reads it is an exhaustive switch.
 */

import { z } from "zod";

/** The id niwa gives a command; pi echoes it in the answer. */
export const RequestIdSchema = z.string().brand<"PiRequestId">();
export type RequestId = z.output<typeof RequestIdSchema>;

/** The id pi gives a request of an extension; niwa echoes it in the answer. */
export const DialogIdSchema = z.string().brand<"PiDialogId">();
export type DialogId = z.output<typeof DialogIdSchema>;

/** A JSON value: what a tool, a custom entry or an extension puts in a message is owned by its producer. */
export const PiJsonSchema = z.json();

/** The thinking levels of pi, `off` included. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

/* ----------------------------------------------------------------- usage */

/** What a response cost: tokens and money. */
export const UsageSchema = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
    totalFromProvider: z.boolean().optional(),
  }),
});
export type Usage = z.output<typeof UsageSchema>;

/* -------------------------------------------------------- content blocks */

export const TextContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});

/** The model's reasoning; `redacted` carries it encrypted in `thinkingSignature`. */
export const ThinkingContentSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});

export const ImageContentSchema = z.looseObject({
  type: z.literal("image"),
  /** Base64. */
  data: z.string(),
  mimeType: z.string(),
});

/** A call the model made to a tool. */
export const ToolCallSchema = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), PiJsonSchema),
  thoughtSignature: z.string().optional(),
  namespace: z.string().optional(),
  argumentsError: z.string().optional(),
});

/** A block of what the model said. */
export const AssistantContentSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ThinkingContentSchema,
  ToolCallSchema,
]);

/** A block of what a person or a tool said: words or an image. */
export const InputContentSchema = z.discriminatedUnion("type", [TextContentSchema, ImageContentSchema]);

/**
 * A block this snapshot cannot place: of a type it has not got, or of a known type that is not shaped
 * as it says. It is carried whole, so that a message does not become unknown, and its other blocks
 * are not lost, because one of them is new.
 */
export const UnrecognizedBlockSchema = PiJsonSchema.transform((raw) => ({ type: "unrecognized" as const, raw }));

/** The blocks of an assistant message, with the one that cannot be placed. */
export const AssistantBlockSchema = z.union([AssistantContentSchema, UnrecognizedBlockSchema]);
export type AssistantBlock = z.output<typeof AssistantBlockSchema>;

/** The blocks of a message of a person or a tool, with the one that cannot be placed. */
export const InputBlockSchema = z.union([InputContentSchema, UnrecognizedBlockSchema]);
export type InputBlock = z.output<typeof InputBlockSchema>;

/** The content of a message that may be a bare string. */
const TextOrBlocksSchema = z.union([z.string(), z.array(InputBlockSchema)]);

/* -------------------------------------------------------------- messages */

/** The harness talking: the prompt, and the tools it adds or removes. */
export const SystemMessageSchema = z.looseObject({
  role: z.literal("system"),
  content: z.union([z.string(), z.array(TextContentSchema)]),
  sections: z.record(z.string(), z.string().nullable()).optional(),
  toolsAdded: z.array(z.looseObject({ name: z.string(), description: z.string() })).optional(),
  toolsRemoved: z.array(z.looseObject({ name: z.string() })).optional(),
  timestamp: z.number().optional(),
});

export const UserMessageSchema = z.looseObject({
  role: z.literal("user"),
  content: TextOrBlocksSchema,
  timestamp: z.number().optional(),
});

export const AssistantMessageSchema = z.looseObject({
  role: z.literal("assistant"),
  /** A bare string is what the oldest files hold. */
  content: z.union([z.string(), z.array(AssistantBlockSchema)]),
  api: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  providerThinkingLevel: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  diagnostics: z
    .array(z.looseObject({ type: z.string(), timestamp: z.number(), error: PiJsonSchema.optional(), details: PiJsonSchema.optional() }))
    .optional(),
  usage: UsageSchema.optional(),
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]).optional(),
  deferred: PiJsonSchema.optional(),
  errorMessage: z.string().optional(),
  rawStopReason: z.string().optional(),
  endTurn: z.boolean().optional(),
  timestamp: z.number().optional(),
  durationMs: z.number().optional(),
});

export const ToolResultMessageSchema = z.looseObject({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string().optional(),
  content: TextOrBlocksSchema,
  details: PiJsonSchema.optional(),
  usage: UsageSchema.optional(),
  nestedCalls: PiJsonSchema.optional(),
  isError: z.boolean().optional(),
  timestamp: z.number().optional(),
  durationMs: z.number().optional(),
});

/** A command the owner ran with `!`. */
export const BashExecutionMessageSchema = z.looseObject({
  role: z.literal("bashExecution"),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().optional(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  fullOutputPath: z.string().optional(),
  excludeFromContext: z.boolean().optional(),
  timestamp: z.number().optional(),
});

/** A message an extension injected. */
export const CustomMessageSchema = z.looseObject({
  role: z.literal("custom"),
  customType: z.string(),
  content: TextOrBlocksSchema,
  display: z.boolean(),
  details: PiJsonSchema.optional(),
  timestamp: z.number().optional(),
});

export const BranchSummaryMessageSchema = z.looseObject({
  role: z.literal("branchSummary"),
  summary: z.string(),
  fromId: z.string().nullable(),
  timestamp: z.number().optional(),
});

export const CompactionSummaryMessageSchema = z.looseObject({
  role: z.literal("compactionSummary"),
  summary: z.string(),
  tokensBefore: z.number(),
  timestamp: z.number().optional(),
});

/** The messages this snapshot knows, by `role`: the union a reader narrows with a switch. */
export const KnownMessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  BashExecutionMessageSchema,
  CustomMessageSchema,
  BranchSummaryMessageSchema,
  CompactionSummaryMessageSchema,
]);
export type KnownMessage = z.output<typeof KnownMessageSchema>;

/**
 * A message of a role this snapshot does not know, or one of a known role whose body has grown past
 * the snapshot. The live path never reads a message beyond its `role`, so a message pi grew is no
 * reason to lose the event that carries it: a run's end must still be a run's end.
 */
export const UnrecognizedMessageSchema = z.looseObject({ role: z.string() });

/** A message on the live wire: a known one, or one that is carried as it came. */
export const AgentMessageSchema = z.union([KnownMessageSchema, UnrecognizedMessageSchema]);
export type AgentMessage = z.output<typeof AgentMessageSchema>;
