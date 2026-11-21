/**
 * The messages of the Claude Agent SDK, as signs of life.
 *
 * The types are the SDK's own (`SDKMessage`, the Messages API blocks it carries). Every message type,
 * every `system` subtype, every streaming event and every content block has its mapping here, and
 * the tables of known names are checked against the SDK's types: a variant the SDK adds fails to
 * compile until it is mapped. A message that arrives at runtime with a name the snapshot does not
 * have (the installed Claude Code is newer) becomes an `unknown-variant` sign, never a crash.
 */

import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import { assertNever } from "@niwa-labs/core";
import { ProtocolNameSchema, VariantNameSchema, unknownVariantSigns } from "@niwa-labs/harness";
import type { LifeEvent } from "@niwa-labs/harness";

import { readBlocks, typeOf } from "../code/format.ts";
import type { AdvisorContent, Block } from "../code/format.ts";

/** The protocol an unknown variant is said to come from. */
const PROTOCOL = ProtocolNameSchema.parse("claude-agent-sdk");

/** The name of Claude Code's advisor among the server tools. */
const ADVISOR = "advisor";

type SystemMessage = Extract<SDKMessage, { type: "system" }>;
type StreamEventType = SDKPartialAssistantMessage["event"]["type"];

const MESSAGE_TYPES = {
  assistant: true,
  user: true,
  result: true,
  system: true,
  stream_event: true,
  tool_progress: true,
  tool_use_summary: true,
  auth_status: true,
  rate_limit_event: true,
  prompt_suggestion: true,
  conversation_reset: true,
} satisfies Record<SDKMessage["type"], true>;

const SYSTEM_SUBTYPES = {
  init: true,
  compact_boundary: true,
  status: true,
  api_retry: true,
  control_request_progress: true,
  model_refusal_fallback: true,
  model_refusal_no_fallback: true,
  local_command_output: true,
  hook_started: true,
  hook_progress: true,
  hook_response: true,
  plugin_install: true,
  task_notification: true,
  task_started: true,
  task_updated: true,
  task_progress: true,
  background_tasks_changed: true,
  thinking_tokens: true,
  session_state_changed: true,
  worker_shutting_down: true,
  commands_changed: true,
  notification: true,
  files_persisted: true,
  memory_recall: true,
  elicitation_complete: true,
  permission_denied: true,
  mirror_error: true,
  informational: true,
  session_writes_lost: true,
} satisfies Record<SystemMessage["subtype"], true>;

const STREAM_EVENT_TYPES = {
  message_start: true,
  message_delta: true,
  message_stop: true,
  content_block_start: true,
  content_block_delta: true,
  content_block_stop: true,
} satisfies Record<StreamEventType, true>;

/**
 * The name of a message the snapshot does not have, or `undefined` when it has it.
 *
 * The SDK's type says every message is known; the process that sends them may be newer.
 */
function unknownVariantOf(message: SDKMessage): string | undefined {
  if (!Object.hasOwn(MESSAGE_TYPES, message.type)) return String(message.type);
  if (message.type === "system" && !Object.hasOwn(SYSTEM_SUBTYPES, message.subtype)) {
    return `system:${String(message.subtype)}`;
  }
  if (message.type === "stream_event" && !Object.hasOwn(STREAM_EVENT_TYPES, message.event.type)) {
    return `stream_event:${String(message.event.type)}`;
  }
  return undefined;
}

/** The signs of a message or block the snapshot does not have. */
function unknownVariant(at: number, variant: string, raw: unknown): LifeEvent[] {
  return unknownVariantSigns(at, PROTOCOL, VariantNameSchema.parse(variant), raw);
}

function activity(at: number, detail: string, tool?: string): LifeEvent {
  return { kind: "activity", at, detail, ...(tool === undefined ? {} : { tool }) };
}

/**
 * The signs of life of one message.
 *
 * The end of a turn (`result`) and the session's name (`system/init`) are read by the control side
 * itself; here they are a sign of life like any other.
 */
export function signsOf(message: SDKMessage, at: number): LifeEvent[] {
  const unknown = unknownVariantOf(message);
  if (unknown !== undefined) return unknownVariant(at, unknown, message);
  switch (message.type) {
    case "assistant": {
      const signs = readBlocks(message.message.content).flatMap((block) => blockSigns(block, at, advisorModelOf(message)));
      return signs.length === 0 ? [activity(at, "assistant")] : signs;
    }
    case "user": {
      // The owner's own words and the answers of tools: one sign, the transcript has the rest.
      const content = message.message.content;
      return typeof content === "string" ? [activity(at, "user")] : readBlocks(content).flatMap((block) => blockSigns(block, at));
    }
    case "result":
      return [activity(at, `result:${message.subtype}`)];
    case "system":
      return [systemSign(message, at)];
    case "stream_event":
      return [streamSign(message.event, at)];
    // Progress of a running tool, a summary of tool calls, the login state, the rate limit, a
    // suggested next prompt, a conversation that started over: each is a sign the session is alive.
    case "tool_progress":
    case "tool_use_summary":
    case "auth_status":
    case "rate_limit_event":
    case "prompt_suggestion":
    case "conversation_reset":
      return [activity(at, message.type)];
    default:
      return assertNever(message, "Claude Agent SDK message");
  }
}

/** A `system` message: a decision on a tool the harness made by itself is marked; the rest are signs of life. */
function systemSign(message: SystemMessage, at: number): LifeEvent {
  switch (message.subtype) {
    case "permission_denied":
      return {
        kind: "activity",
        at,
        detail: "system:permission_denied",
        permission: { decision: "deny", decidedBy: "claude", ruleKind: message.decision_reason_type ?? null },
      };
    case "init":
    case "compact_boundary":
    case "status":
    case "api_retry":
    case "control_request_progress":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "local_command_output":
    case "hook_started":
    case "hook_progress":
    case "hook_response":
    case "plugin_install":
    case "task_notification":
    case "task_started":
    case "task_updated":
    case "task_progress":
    case "background_tasks_changed":
    case "thinking_tokens":
    case "session_state_changed":
    case "worker_shutting_down":
    case "commands_changed":
    case "notification":
    case "files_persisted":
    case "memory_recall":
    case "elicitation_complete":
    case "mirror_error":
    case "informational":
    case "session_writes_lost":
      return activity(at, `system:${message.subtype}`);
    default:
      return assertNever(message, "Claude Agent SDK system message");
  }
}

/**
 * A streaming event (only with partial messages on): a sign of life. The blocks it streams arrive
 * again whole in an `assistant` message, so the advisor is read there, once.
 */
function streamSign(event: SDKPartialAssistantMessage["event"], at: number): LifeEvent {
  switch (event.type) {
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_start":
    case "content_block_delta":
    case "content_block_stop":
      return activity(at, `stream_event:${event.type}`);
    default:
      return assertNever(event, "Claude Agent SDK stream event");
  }
}

/** The model the advisor ran on, as the usage of the answer names it. */
function advisorModelOf(message: SDKAssistantMessage): string | undefined {
  for (const iteration of message.message.usage?.iterations ?? []) {
    if (iteration.type === "advisor_message") return iteration.model;
  }
  return undefined;
}

/** What kind of answer the advisor gave. */
function advisorResult(content: AdvisorContent): { result: "text" | "redacted" | "error"; errorCode?: string } {
  switch (content.type) {
    case "advisor_result":
      return { result: "text" };
    case "advisor_redacted_result":
      return { result: "redacted" };
    case "advisor_tool_result_error":
      return { result: "error", errorCode: content.error_code };
    default:
      return assertNever(content, "advisor result");
  }
}

/** One content block: the advisor has its own sign, a block the snapshot lacks is an unknown variant. */
function blockSigns(block: Block, at: number, advisorModel?: string): LifeEvent[] {
  if (block.type === "unparsed") return unknownVariant(at, `content_block:${typeOf(block.raw)}`, block.raw);
  return [blockSign(block, at, advisorModel)];
}

/** The sign of one content block the snapshot has. */
function blockSign(block: Exclude<Block, { type: "unparsed" }>, at: number, advisorModel?: string): LifeEvent {
  switch (block.type) {
    case "server_tool_use":
      return block.name === ADVISOR
        ? { kind: "advisor", at, phase: "started", callId: block.id }
        : activity(at, `server_tool_use:${block.name}`, block.name);
    case "advisor_tool_result":
      return {
        kind: "advisor",
        at,
        phase: "finished",
        callId: block.tool_use_id,
        ...(advisorModel === undefined ? {} : { model: advisorModel }),
        ...advisorResult(block.content),
      };
    case "tool_use":
    case "mcp_tool_use":
      return activity(at, `${block.type}:${block.name}`, block.name);
    case "text":
    case "thinking":
    case "redacted_thinking":
    case "tool_result":
    case "mcp_tool_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "image":
    case "document":
    case "search_result":
    case "container_upload":
    case "compaction":
    case "fallback":
    case "mcp_tool_listing":
      return activity(at, block.type);
    default:
      return assertNever(block, "Claude content block");
  }
}
