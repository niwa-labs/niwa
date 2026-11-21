/**
 * The native format of a MiniMax Code journal: one JSON envelope per line,
 * `{message_id, turn_id, message}`, and the parts of it the reading side maps. The working
 * directory is not a field: it sits in the `<agent-context>` block prepended to the first human
 * message, and that block is machine text, not the human's words. Nothing here touches the disk.
 */

import { z } from "zod";

/** A block of content: text, a thought, or a call of a tool. */
const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  /** A thought the harness keeps sealed: it carries no text. */
  redacted: z.boolean().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
});

/** One native message. */
export const MessageSchema = z.object({
  role: z.string(),
  timestamp: z.number().optional(),
  content: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
  model: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  summary: z.string().optional(),
});

/** The envelope of a journal record. */
const EnvelopeSchema = z.object({
  message_id: z.string().optional(),
  turn_id: z.string().optional(),
  message: MessageSchema,
});

export type McodeRecord = z.output<typeof EnvelopeSchema>;
export type McodeMessage = z.output<typeof MessageSchema>;

/** The harness's own record whole, as `raw` gives it. */
export const RawRecordSchema = z.looseObject({
  message_id: z.string().optional(),
  turn_id: z.string().optional(),
  message: MessageSchema,
});

/** The blocks of machine preamble: the harness's text, not the human's words. */
const NOISE_BLOCKS: readonly RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<agent-context>[\s\S]*?<\/agent-context>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-contents>[\s\S]*?<\/command-contents>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

/** The real text of a human message: the machine preamble is cut out. */
export function stripHarnessNoise(text: string): string {
  let out = text;
  for (const block of NOISE_BLOCKS) out = out.replace(block, "");
  out = out.replace(/^\s*Caveat: The messages below[\s\S]*?\n(?=\S)/, "");
  return out.trim();
}

/** The text is wrapped in an XML wrapper — a harness's injection, not the human's words. */
export function isWrappedNoise(text: string): boolean {
  const trimmed = text.trim();
  return /^<[a-zA-Z][\w-]*(\s[^>]*)?>/.test(trimmed) && /<\/[a-zA-Z][\w-]*>\s*$/.test(trimmed);
}

/** What the preamble of a session says about the session itself. */
export type AgentContext = {
  /** The role of the session in the run: "root", "branch", "worker". */
  readonly sessionRole: string | null;
  /** The id of this session, as the harness states it. */
  readonly sessionId: string | null;
  /** The id of the session this one was spawned in, when it was. */
  readonly parentSessionId: string | null;
  /** The working directory the session ran in. */
  readonly workspaceDir: string | null;
};

/** Read the `agent-context` block out of the text of a message. */
export function readAgentContext(text: string): AgentContext {
  const block = /<agent-context>([\s\S]*?)<\/agent-context>/.exec(text);
  const body = block?.[1] ?? "";
  const line = (key: string): string | null => {
    const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(body);
    return match?.[1]?.trim() ?? null;
  };
  return {
    sessionRole: line("SESSION ROLE"),
    sessionId: line("YOUR SESSION ID"),
    parentSessionId: line("PARENT SESSION"),
    workspaceDir: line("YOUR WORKSPACE DIRECTORY") ?? line("workspaceDir"),
  };
}

/** The text of a content: a string as it is, blocks by their text parts. */
export function textOf(content: McodeMessage["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => block.text ?? block.thinking ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Parse a line of the journal. `null` — the line is not a record of the journal. */
export function parseNativeRecord(value: unknown): McodeRecord | null {
  const parsed = EnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whole milliseconds, or `undefined` when the value is not a usable time. */
export function millisOf(timestamp: number | undefined): number | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const whole = Math.max(0, Math.floor(timestamp));
  return Number.isSafeInteger(whole) ? whole : undefined;
}

/* ------------------------------------------------------------------ the ledger */

/** A call of a tool, as the display entries of the ledger carry it. */
const LedgerToolCallSchema = z.object({
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_call_args: z.string().optional(),
});

/** The message of a display entry: what the user saw, in the fields of its own. */
export const LedgerDisplayMessageSchema = z.object({
  msg_id: z.string().optional(),
  role: z.string(),
  msg_type: z.number().optional(),
  msg_content: z.string().optional(),
  timestamp: z.number().optional(),
  thinking_content: z.string().optional(),
  tool_calls: z.array(LedgerToolCallSchema).optional(),
});

export type LedgerDisplayMessage = z.output<typeof LedgerDisplayMessageSchema>;

/**
 * One entry of the ledger: an event of the session, and the turns it carries.
 *
 * `message` is a display entry (what the user saw), `messages` is a piece of the history the agent
 * was given, and `record` is what an event states about the session itself.
 */
export const LedgerEntrySchema = z.looseObject({
  kind: z.string(),
  sessionId: z.string().optional(),
  seq: z.number().optional(),
  message: LedgerDisplayMessageSchema.optional(),
  messages: z.array(MessageSchema).optional(),
  record: z.looseObject({ workspaceDir: z.string().optional() }).optional(),
});

export type LedgerEntry = z.output<typeof LedgerEntrySchema>;

/** The manifest of a session: the source of truth for its id and its times. */
export const ManifestSchema = z.object({
  schemaVersion: z.number().optional(),
  sessionId: z.string().optional(),
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
  source: z.string().optional(),
  layout: z.string().optional(),
});

export type Manifest = z.output<typeof ManifestSchema>;
