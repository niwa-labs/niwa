/**
 * The ACP dialect of Claude Code's adapter (`@zed-industries/claude-code-acp` 0.16.2), over the
 * official ACP snapshot that adapter pins (`@agentclientprotocol/sdk` 0.14.1, generated).
 *
 * Hand-written, since neither has a schema for them, from the adapter's sources
 * (`dist/acp-agent.js`) and niwa's own adapter entry (`./adapter.ts`):
 *
 * - `_meta.claudeCode` on `tool_call` and `tool_call_update`: Claude Code's own name of the tool,
 *   and, on the update its PostToolUse hook sends, the tool's response;
 * - `_niwa/ask_user_question`, the request niwa's entry sends for AskUserQuestion, and
 *   `_niwa/cancel_request`, its notification that it no longer waits for the answer;
 * - `_niwa/session_model`, its notification of the model the session really runs.
 *
 * The adapter sends no `_meta.informational`: that is a MiniMax Code fork extension.
 */

import { z } from "zod";

import { ModelNameSchema, ProtocolNameSchema } from "@niwa-labs/harness";
import { Acp014 as Acp } from "@niwa-labs/acp";

export { Acp };

/** The name niwa gives this protocol in the unknowns it records. */
export const CLAUDE_ACP_PROTOCOL = ProtocolNameSchema.parse(`acp-${Acp.ACP_SDK_VERSION}/claude-code`);

/** The `_meta` the adapter puts on a tool call. */
export const ClaudeToolMeta = z.object({
  claudeCode: z.object({
    /** Claude Code's own name of the tool (`Bash`, `advisor`, `mcp__server__tool`, ...). */
    toolName: z.string(),
    /** The tool's response, on the update the PostToolUse hook sends. */
    toolResponse: z.unknown().optional(),
  }),
});
export type ClaudeToolMeta = z.output<typeof ClaudeToolMeta>;

/** Claude Code's name of the tool of a tool call, when the adapter gave one. */
export function claudeToolName(meta: Acp.ToolCall["_meta"]): string | undefined {
  const parsed = ClaudeToolMeta.safeParse(meta);
  return parsed.success ? parsed.data.claudeCode.toolName : undefined;
}

/** The questions of one AskUserQuestion call, as niwa's adapter entry sends them. */
export const AskUserQuestionParams = z.object({
  sessionId: Acp.SessionId.optional(),
  toolCallId: z.string().optional(),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(1),
      }),
    )
    .min(1),
});
export type AskUserQuestionParams = z.output<typeof AskUserQuestionParams>;

/** The call a `_niwa/cancel_request` notification is about. */
export const CancelAskParams = z.object({ sessionId: Acp.SessionId.optional(), toolCallId: z.string().optional() });

/** What a `_niwa/session_model` notification says: the model the program runs. */
export const SessionModelParams = z.object({ sessionId: Acp.SessionId.optional(), model: ModelNameSchema });

/** A request the adapter sends the client: the snapshot's own, and niwa's entry's. */
export const ClaudeAgentRequest = z.discriminatedUnion("method", [
  ...Acp.AgentToClientRequest.options,
  z.object({
    jsonrpc: z.literal("2.0").optional(),
    id: Acp.RequestId,
    method: z.literal("_niwa/ask_user_question"),
    params: z.unknown(),
  }),
]);
export type ClaudeAgentRequest = z.output<typeof ClaudeAgentRequest>;

/** A notification the adapter sends the client: the snapshot's own, and niwa's entry's. */
export const ClaudeAgentNotification = z.discriminatedUnion("method", [
  ...Acp.AgentToClientNotification.options,
  z.object({ jsonrpc: z.literal("2.0").optional(), method: z.literal("_niwa/cancel_request"), params: CancelAskParams }),
  z.object({ jsonrpc: z.literal("2.0").optional(), method: z.literal("_niwa/session_model"), params: SessionModelParams }),
]);
export type ClaudeAgentNotification = z.output<typeof ClaudeAgentNotification>;
