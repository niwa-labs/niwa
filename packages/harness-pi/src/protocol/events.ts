/**
 * What pi writes on stdout in its RPC mode besides answers: the events of a session.
 *
 * HAND-WRITTEN, from pi 1.5.2 (commit 22fc026b8, `packages/coding-agent`): `AgentSessionEvent` in
 * `src/core/agent-session.ts` and `AgentEvent` in `packages/agent/src/types.ts`, as the RPC mode
 * writes them, which is `JsonAgentSessionEvent` of `src/modes/json-event.ts`: a `message_update`
 * carries the `usage` of the message and no `message`, and its `assistantMessageEvent` has the
 * cumulative `partial` stripped (a `toolcall_start` gains `id` and `toolName` instead).
 */

import { z } from "zod";

import { SessionEntrySchema } from "./entries.ts";
import {
  AgentMessageSchema,
  AssistantMessageSchema,
  PiJsonSchema,
  ThinkingLevelSchema,
  ToolCallSchema,
  ToolResultMessageSchema,
  UsageSchema,
} from "./messages.ts";

/* -------------------------------------------------- assistantMessageEvent */

const contentIndex = z.number().int().nonnegative();

/** The stream of one assistant message, by `type`; `message_update` carries one of these. */
export const AssistantMessageEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("start") }),
  z.looseObject({ type: z.literal("text_start"), contentIndex }),
  z.looseObject({ type: z.literal("text_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("text_end"), contentIndex, content: z.string() }),
  z.looseObject({ type: z.literal("thinking_start"), contentIndex }),
  z.looseObject({ type: z.literal("thinking_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("thinking_end"), contentIndex, content: z.string() }),
  z.looseObject({ type: z.literal("toolcall_start"), contentIndex, id: z.string().optional(), toolName: z.string().optional() }),
  z.looseObject({ type: z.literal("toolcall_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("toolcall_end"), contentIndex, toolCall: ToolCallSchema }),
  z.looseObject({
    type: z.literal("done"),
    reason: z.enum(["stop", "length", "toolUse", "deferred"]),
    message: AssistantMessageSchema,
  }),
  z.looseObject({
    type: z.literal("error"),
    reason: z.enum(["aborted", "error"]),
    error: AssistantMessageSchema,
  }),
]);

/* ------------------------------------------------------------ the events */

/** Why a compaction ran. */
const CompactionReasonSchema = z.enum(["manual", "threshold", "overflow"]);

/** What a compaction made. */
export const CompactionResultSchema = z.looseObject({
  summary: z.string(),
  firstKeptEntryId: z.string(),
  tokensBefore: z.number(),
  estimatedTokensAfter: z.number().optional(),
  usage: UsageSchema.optional(),
  details: PiJsonSchema.optional(),
});

/**
 * The two ways a summarization is retried share one `type`, told apart by `source`, so they are one
 * option of the union with a union of their own.
 */
const SummarizationRetryAttemptStartSchema = z.discriminatedUnion("source", [
  z.looseObject({ type: z.literal("summarization_retry_attempt_start"), source: z.literal("branchSummary") }),
  z.looseObject({
    type: z.literal("summarization_retry_attempt_start"),
    source: z.literal("compaction"),
    reason: CompactionReasonSchema,
  }),
]);

/** The events of a session, by `type`. */
export const PiEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("agent_start") }),
  // `willRetry` is optional: whether a run ended for good is the one thing niwa takes from this event,
  // and an `agent_end` without it is still the end of the run.
  z.looseObject({ type: z.literal("agent_end"), messages: z.array(AgentMessageSchema), willRetry: z.boolean().optional() }),
  z.looseObject({ type: z.literal("turn_start") }),
  z.looseObject({
    type: z.literal("turn_end"),
    message: AgentMessageSchema,
    toolResults: z.array(ToolResultMessageSchema),
  }),
  z.looseObject({ type: z.literal("message_start"), message: AgentMessageSchema }),
  z.looseObject({
    type: z.literal("message_update"),
    // `usage` and the `id` and `toolName` of `toolcall_start` are what the RPC projection adds to the
    // stream; a pi that predates it does not send them, and niwa reads none of them.
    usage: UsageSchema.optional(),
    assistantMessageEvent: AssistantMessageEventSchema,
  }),
  z.looseObject({ type: z.literal("message_end"), message: AgentMessageSchema }),
  z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: PiJsonSchema,
    parentToolCallId: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: PiJsonSchema,
    partialResult: PiJsonSchema,
    parentToolCallId: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: PiJsonSchema,
    isError: z.boolean(),
    durationMs: z.number().optional(),
    parentToolCallId: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("agent_settled"), aborted: z.boolean() }),
  z.looseObject({
    type: z.literal("queue_update"),
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  }),
  z.looseObject({ type: z.literal("compaction_start"), reason: CompactionReasonSchema }),
  z.looseObject({ type: z.literal("entry_appended"), entry: SessionEntrySchema }),
  z.looseObject({ type: z.literal("session_info_changed"), name: z.string().optional() }),
  z.looseObject({ type: z.literal("thinking_level_changed"), level: ThinkingLevelSchema }),
  z.looseObject({
    type: z.literal("compaction_end"),
    reason: CompactionReasonSchema,
    result: CompactionResultSchema.optional(),
    aborted: z.boolean(),
    willRetry: z.boolean(),
    errorMessage: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorMessage: z.string(),
  }),
  z.looseObject({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number(),
    finalError: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("summarization_retry_scheduled"),
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorMessage: z.string(),
  }),
  z.looseObject({ type: z.literal("summarization_retry_finished") }),
  z.looseObject({ type: z.literal("bash_execution_update"), id: z.string().optional(), delta: z.string() }),
  SummarizationRetryAttemptStartSchema,
]);
export type PiEvent = z.output<typeof PiEventSchema>;
