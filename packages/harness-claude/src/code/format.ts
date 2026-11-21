/**
 * The native format of a Claude Code log: one JSON record per line.
 *
 * A record names its own kind (`type`), and the kinds are many and change without notice: beside
 * `user` and `assistant` there are `attachment`, `queue-operation`, `mode`, `ai-title` and many
 * more. Only the kinds niwa can speak about are mapped; every other one becomes `unknown` with
 * its raw data kept, never an error.
 *
 * The parts of a message that are mapped:
 *
 * - `user` and `assistant` — a string, or blocks of the Messages API, every type of which has a
 *   schema here (the types are checked against the Claude Agent SDK's); with `isCompactSummary` a
 *   `user` record is the summary the harness wrote when it replaced the context.
 *
 * The advisor (Claude Code's tool that asks a stronger model) is a server tool: a `server_tool_use`
 * block named `advisor` and then an `advisor_tool_result` block, both in the answer of the model.
 *
 * The `system` record with `subtype: "compact_boundary"` only marks the place of a compaction
 * (its `content` is the fixed text "Conversation compacted"); the summary is the `user` record
 * that follows it. The boundary is kept as `unknown`.
 *
 * The name of a tool is not written in the answer of a tool, so the names are remembered by the
 * id of the call while the log is read.
 */

import type { SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** The body of a message. */
const MessageSchema = z.object({
  id: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});

/**
 * One native record.
 *
 * Only the fields that are mapped are declared; the rest are kept in `raw`.
 */
const RecordSchema = z.object({
  type: z.string(),
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
  aiTitle: z.string().optional(),
  customTitle: z.string().optional(),
  agentName: z.string().optional(),
});

export type ClaudeRecord = z.output<typeof RecordSchema>;

/** The harness's own record whole, as `raw` gives it. */
export const RawRecordSchema = z.looseObject({
  type: z.string(),
  message: MessageSchema.optional(),
});

/** Parse a native record; `null` when the value is not one. */
export function parseNativeRecord(value: unknown): ClaudeRecord | null {
  const parsed = RecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The type of every content block the Messages API names, in a model's answer or a user's message. */
export type BlockType =
  | SDKAssistantMessage["message"]["content"][number]["type"]
  | Exclude<SDKUserMessage["message"]["content"], string>[number]["type"];

const NonEmpty = z.string().min(1);

/** A block of one type: the fields niwa reads are declared, the rest are kept. */
function block<T extends BlockType, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.looseObject({ type: z.literal(type), ...shape });
}

/** A block that answers a server tool: the id of the call and the tool's own content. */
function serverResult<T extends BlockType>(type: T) {
  return block(type, { tool_use_id: NonEmpty, content: z.unknown() });
}

/**
 * What the advisor answered: its text, its text sealed (`advisor_redacted_result`), or an error. The
 * error codes are a string: the harness writes codes the API's own list does not have yet.
 */
export const AdvisorContentSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("advisor_result"), text: z.string() }),
  z.looseObject({ type: z.literal("advisor_redacted_result"), encrypted_content: z.string() }),
  z.looseObject({ type: z.literal("advisor_tool_result_error"), error_code: z.string() }),
]);
export type AdvisorContent = z.output<typeof AdvisorContentSchema>;

/**
 * The schema of every block type, one per type: a type the Messages API adds fails to compile here
 * until it is given one.
 */
const BLOCK_SCHEMAS = {
  text: block("text", { text: z.string() }),
  image: block("image", {}),
  document: block("document", {}),
  search_result: block("search_result", {}),
  thinking: block("thinking", { thinking: z.string() }),
  redacted_thinking: block("redacted_thinking", { data: z.string() }),
  tool_use: block("tool_use", { id: NonEmpty, name: NonEmpty, input: z.unknown() }),
  server_tool_use: block("server_tool_use", { id: NonEmpty, name: NonEmpty, input: z.unknown() }),
  mcp_tool_use: block("mcp_tool_use", { id: NonEmpty, name: NonEmpty, server_name: z.string(), input: z.unknown() }),
  tool_result: block("tool_result", { tool_use_id: NonEmpty, is_error: z.boolean().optional(), content: z.unknown() }),
  mcp_tool_result: block("mcp_tool_result", { tool_use_id: NonEmpty, is_error: z.boolean().optional(), content: z.unknown() }),
  advisor_tool_result: block("advisor_tool_result", { tool_use_id: NonEmpty, content: AdvisorContentSchema }),
  web_search_tool_result: serverResult("web_search_tool_result"),
  web_fetch_tool_result: serverResult("web_fetch_tool_result"),
  code_execution_tool_result: serverResult("code_execution_tool_result"),
  bash_code_execution_tool_result: serverResult("bash_code_execution_tool_result"),
  text_editor_code_execution_tool_result: serverResult("text_editor_code_execution_tool_result"),
  tool_search_tool_result: serverResult("tool_search_tool_result"),
  container_upload: block("container_upload", { file_id: z.string() }),
  compaction: block("compaction", { content: z.string().nullable() }),
  fallback: block("fallback", {}),
  mcp_tool_listing: block("mcp_tool_listing", {}),
} satisfies { readonly [K in BlockType]: z.ZodType<{ type: K }> };

/** A block of a message that passed the schema of its type. */
export type NativeBlock = { [K in BlockType]: z.output<(typeof BLOCK_SCHEMAS)[K]> }[BlockType];

/** A block of a message: one of a known type, or the value it came from when it is not one. */
export type Block = NativeBlock | { readonly type: "unparsed"; readonly raw: unknown };

const TypedSchema = z.looseObject({ type: z.string() });

function isBlockType(type: string): type is BlockType {
  return Object.hasOwn(BLOCK_SCHEMAS, type);
}

/** Read one block of a message; an unfamiliar or malformed block does not break the record. */
function readBlock(raw: unknown): Block {
  const typed = TypedSchema.safeParse(raw);
  if (!typed.success || !isBlockType(typed.data.type)) return { type: "unparsed", raw };
  const parsed = BLOCK_SCHEMAS[typed.data.type].safeParse(raw);
  return parsed.success ? parsed.data : { type: "unparsed", raw };
}

/** The blocks of a message: a string, or a list of blocks. */
export function readBlocks(content: string | readonly unknown[] | undefined): Block[] {
  if (content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(readBlock);
}

/** The type a block names for itself, whether or not it is a known one; empty when it names none. */
export function typeOf(raw: unknown): string {
  const typed = TypedSchema.safeParse(raw);
  return typed.success ? typed.data.type : "";
}

/** Whether the content a server tool answered with is its error: every such type ends in `_error`. */
export function isServerError(content: unknown): boolean {
  const typed = TypedSchema.safeParse(content);
  return typed.success && typed.data.type.endsWith("_error");
}

/**
 * Whole milliseconds of a moment, or `undefined` when the value is not a usable time.
 *
 * The harness writes moments as ISO strings.
 */
export function millisOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const whole = Math.floor(ms);
  return Number.isSafeInteger(whole) ? whole : undefined;
}

/**
 * The state of a read, shared by the records of one log.
 *
 * The name of a tool is not written in the answer of a tool, so the names are remembered here by
 * the id of the call.
 */
export type ParseState = {
  /** The id of a call → the name of the tool that was called. */
  readonly toolNames: Map<string, string>;
};

export function newParseState(): ParseState {
  return { toolNames: new Map() };
}
