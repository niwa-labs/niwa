/**
 * pi's answers to the commands niwa writes, in its RPC mode.
 *
 * HAND-WRITTEN, from `RpcResponse`, `RpcSessionState` and `RpcSlashCommand` in
 * `packages/coding-agent/src/modes/rpc/rpc-types.ts` of pi 1.5.2 (commit 22fc026b8), and the types
 * they name: `Model`, `SessionStats`, `CompactionResult`, `BashResult`, `SourceInfo`.
 *
 * An answer is an error (`success: false`, which any command can have) or a success whose shape is
 * the command's own, so the schema is the one union of the other and a union by `command`.
 * `get_state` and `get_available_models` carry a model, which has many fields; only those every
 * model has are required.
 */

import { z } from "zod";

import { SessionEntrySchema, SessionTreeNodeSchema } from "./entries.ts";
import { CompactionResultSchema } from "./events.ts";
import { AgentMessageSchema, RequestIdSchema, ThinkingLevelSchema } from "./messages.ts";

const id = RequestIdSchema.optional();

/**
 * A model of pi's catalog: it is named by its provider and id, and carries much more that niwa does
 * not read. The provider is optional: a model that names none is known by its id alone.
 */
export const ModelSchema = z.looseObject({
  id: z.string(),
  provider: z.string().optional(),
  name: z.string().optional(),
  api: z.string().optional(),
  baseUrl: z.string().optional(),
  input: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  cost: z
    .looseObject({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    })
    .optional(),
});
export type Model = z.output<typeof ModelSchema>;

const QueueModeSchema = z.enum(["all", "one-at-a-time"]);

/**
 * What `get_state` says. The identity of the session is `sessionId` with `sessionFile`, and the
 * session cannot be named without the first: it is the one required field, so that a pi that
 * changes its other fields still starts.
 */
export const SessionStateSchema = z.looseObject({
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  sessionName: z.string().optional(),
  model: ModelSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  isStreaming: z.boolean().optional(),
  isCompacting: z.boolean().optional(),
  steeringMode: QueueModeSchema.optional(),
  followUpMode: QueueModeSchema.optional(),
  autoCompactionEnabled: z.boolean().optional(),
  messageCount: z.number().optional(),
  pendingMessageCount: z.number().optional(),
});
export type SessionState = z.output<typeof SessionStateSchema>;

const SourceInfoSchema = z.looseObject({
  path: z.string(),
  source: z.string(),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
  baseDir: z.string().optional(),
  changelogPath: z.string().optional(),
});

/** A command that can be invoked through a prompt. */
export const SlashCommandSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  source: z.enum(["extension", "prompt", "skill"]),
  sourceInfo: SourceInfoSchema,
});

const SessionStatsSchema = z.looseObject({
  sessionFile: z.string().optional(),
  sessionId: z.string(),
  userMessages: z.number(),
  assistantMessages: z.number(),
  toolCalls: z.number(),
  toolResults: z.number(),
  totalMessages: z.number(),
  tokens: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
  cost: z.number(),
  contextUsage: z
    .looseObject({ tokens: z.number().nullable(), contextWindow: z.number(), percent: z.number().nullable() })
    .optional(),
});

const BashResultSchema = z.looseObject({
  output: z.string(),
  exitCode: z.number().optional(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  fullOutputPath: z.string().optional(),
});

const Disposition = z.enum(["handled", "queued"]);
const Cancelled = z.looseObject({ cancelled: z.boolean() });

/** A success that carries data. */
function withData<C extends string, D extends z.ZodType>(command: C, data: D) {
  return z.looseObject({
    id,
    type: z.literal("response"),
    command: z.literal(command),
    success: z.literal(true),
    data,
  });
}

/** A success whose data a pi of an older version leaves out. */
function withOptionalData<C extends string, D extends z.ZodType>(command: C, data: D) {
  return z.looseObject({
    id,
    type: z.literal("response"),
    command: z.literal(command),
    success: z.literal(true),
    data: data.optional(),
  });
}

/** A success that carries nothing. */
function bare<C extends string>(command: C) {
  return z.looseObject({ id, type: z.literal("response"), command: z.literal(command), success: z.literal(true) });
}

/** The success answers, by `command`. */
export const SuccessResponseSchema = z.discriminatedUnion("command", [
  // Prompting
  // A pi older than the dispositions answers these three with no data, and niwa reads none.
  withOptionalData("prompt", z.looseObject({ disposition: z.enum(["started", "handled", "queued"]) })),
  withOptionalData("steer", z.looseObject({ disposition: Disposition })),
  withOptionalData("follow_up", z.looseObject({ disposition: Disposition })),
  bare("abort"),
  withData("clear_queue", z.looseObject({ steering: z.array(z.string()), followUp: z.array(z.string()) })),
  withData("new_session", Cancelled),
  // State
  withData("get_state", SessionStateSchema),
  // Model
  withData("set_model", ModelSchema),
  withData(
    "cycle_model",
    z
      .looseObject({ model: ModelSchema, thinkingLevel: ThinkingLevelSchema, isScoped: z.boolean() })
      .nullable(),
  ),
  withData("get_available_models", z.looseObject({ models: z.array(ModelSchema) })),
  // Thinking
  bare("set_thinking_level"),
  withData("cycle_thinking_level", z.looseObject({ level: ThinkingLevelSchema }).nullable()),
  withData("get_available_thinking_levels", z.looseObject({ levels: z.array(ThinkingLevelSchema) })),
  // Queue modes
  bare("set_steering_mode"),
  bare("set_follow_up_mode"),
  // Compaction
  withData("compact", CompactionResultSchema),
  bare("set_auto_compaction"),
  // Retry
  bare("set_auto_retry"),
  bare("abort_retry"),
  // Bash
  withData("bash", BashResultSchema),
  bare("abort_bash"),
  // Session
  withData("get_session_stats", SessionStatsSchema),
  withData("export_html", z.looseObject({ path: z.string() })),
  withData("switch_session", Cancelled),
  withData("fork", z.looseObject({ text: z.string(), cancelled: z.boolean() })),
  withData("clone", Cancelled),
  withData(
    "get_fork_messages",
    z.looseObject({ messages: z.array(z.looseObject({ entryId: z.string(), text: z.string() })) }),
  ),
  withData(
    "get_entries",
    z.looseObject({ entries: z.array(SessionEntrySchema), leafId: z.string().nullable() }),
  ),
  withData("get_tree", z.looseObject({ tree: z.array(SessionTreeNodeSchema), leafId: z.string().nullable() })),
  withData("get_last_assistant_text", z.looseObject({ text: z.string().nullable() })),
  bare("set_session_name"),
  // Messages
  withData("get_messages", z.looseObject({ messages: z.array(AgentMessageSchema) })),
  // Commands
  withData("get_commands", z.looseObject({ commands: z.array(SlashCommandSchema) })),
]);
export type SuccessResponse = z.output<typeof SuccessResponseSchema>;
export type ResponseCommand = SuccessResponse["command"];

/** A refusal. Any command can have one, and a line pi could not read has one with no `id` and the command `parse`. */
export const ErrorResponseSchema = z.looseObject({
  id,
  type: z.literal("response"),
  command: z.string(),
  success: z.literal(false),
  error: z.string(),
});

export const PiResponseSchema = z.union([ErrorResponseSchema, SuccessResponseSchema]);
export type PiResponse = z.output<typeof PiResponseSchema>;

/**
 * The part of an answer that is read before its body is: enough to settle the request it answers.
 * Whatever else an answer lacks, an answer with an `id` settles its request, so that a body pi
 * changed fails the call at once and does not leave it waiting for a timeout.
 */
export const ResponseEnvelopeSchema = z.looseObject({
  type: z.literal("response"),
  id,
  command: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
});
export type ResponseEnvelope = z.output<typeof ResponseEnvelopeSchema>;
