/**
 * The ledger of a session: the history of a session that kept no journal of its own.
 *
 * A session directory holds a journal (`messages.jsonl`). When it holds none, the history of the
 * session is in its ledger (`ledger.jsonl`): one entry per line, every entry an event of the
 * session. Most entries are bookkeeping (`session.created`, `session.metadata_updated`,
 * `session.snapshot_created`); two kinds carry turns:
 *
 * - `message.pi_history_appended` and `message.pi_history_replaced` carry the history the agent was
 *   given, in the shape the journal itself uses: a message with blocks of text, of thought and of
 *   calls of tools. A `replaced` entry states the whole history as it is now; an `appended` one
 *   adds to it.
 * - `message.display_upserted` carries what the user saw, in fields of its own: the text of the
 *   message, the calls of tools it made, the time. It is put in the shape of a message of the
 *   journal here, so that a turn is read the same way whichever entry carried it.
 *
 * The same turn comes in both, so only one of them is read: the history when the ledger has it, the
 * display when it does not. Nothing here touches the disk.
 */

import { LedgerEntrySchema } from "./format.ts";
import type { LedgerDisplayMessage, McodeMessage } from "./format.ts";

/** One line of the ledger, with where it is and whether it is whole. */
export interface LedgerLine {
  /** The offset of the start of the line. */
  readonly byte: number;
  /** The bytes of the line, without its line feed. */
  readonly bytes: Buffer;
  /** The line has no line feed yet: it is the half-written tail of the file. */
  readonly complete: boolean;
}

/** A turn of the conversation, as the ledger carries it. */
export interface LedgerTurn {
  /** The message of the turn, in the shape a message of the journal has; `null` when the line is not JSON. */
  readonly message: McodeMessage | null;
  /** The entry of the ledger as the harness wrote it: what `raw` gives back. */
  readonly raw: unknown;
  /** The line of the ledger that carried the turn. */
  readonly line: LedgerLine;
  /** The place of the turn in that line. */
  readonly index: number;
}

/** What a ledger holds. */
export interface LedgerContent {
  /** The turns of the conversation, in the order they happened. */
  readonly turns: readonly LedgerTurn[];
  /** The head of the ledger: the bytes the revision of a locator hashes. */
  readonly head: Buffer;
  /** How many bytes the ledger has. */
  readonly size: number;
  /** The working directory the session states, when it states one. */
  readonly workspaceDir: string | undefined;
}

/** Bytes of the head of the ledger the revision of a locator hashes. */
const HEAD_BYTES = 4096;

/** The ledger of a session, as the bytes of its file. */
export function parseLedger(bytes: Buffer): LedgerContent {
  const history: LedgerTurn[] = [];
  const broken: LedgerTurn[] = [];
  const display = new Map<string, LedgerTurn>();
  const displayOrder: string[] = [];
  let workspaceDir: string | undefined;
  let sawHistory = false;

  for (const line of splitLines(bytes)) {
    if (line.bytes.length === 0) continue;
    const text = line.bytes.toString("utf8");
    if (text.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A line that is not JSON is kept whole: it is not an error, and it is not a turn either.
      broken.push({ message: null, raw: text, line, index: 0 });
      continue;
    }
    const entry = LedgerEntrySchema.safeParse(parsed);
    if (!entry.success) continue;
    const event = entry.data;

    // The session states what it is: the working directory it runs in.
    const stated = event.record?.workspaceDir;
    if (stated !== undefined && stated.length > 0) workspaceDir = stated;

    if (event.kind === "message.pi_history_replaced") {
      // The history as it is now: what came before it is no longer part of it.
      history.length = 0;
      sawHistory = true;
      pushMessages(history, event.messages ?? [], line, parsed);
      continue;
    }
    if (event.kind === "message.pi_history_appended") {
      sawHistory = true;
      pushMessages(history, event.messages ?? [], line, parsed);
      continue;
    }
    if (event.kind === "message.display_upserted" && event.message !== undefined) {
      const turn = displayTurn(event.message, line, parsed);
      const key = event.message.msg_id;
      if (key !== undefined) {
        display.set(key, turn);
        if (!displayOrder.includes(key)) displayOrder.push(key);
      } else {
        const anon = displayOrder.length.toString();
        displayOrder.push(anon);
        display.set(anon, turn);
      }
    }
  }

  const shown = sawHistory ? history : displayOrder.flatMap((key) => display.get(key) ?? []);
  // A line that is not JSON stays where it was: it is read in the order of the file.
  const turns = [...shown, ...broken].sort((a, b) => a.line.byte - b.line.byte);
  return { turns, head: bytes.subarray(0, HEAD_BYTES), size: bytes.length, workspaceDir };
}

/** The turns of one entry: the messages it carries, in the order it carries them. */
function pushMessages(
  turns: LedgerTurn[],
  messages: readonly McodeMessage[],
  line: LedgerLine,
  raw: unknown,
): void {
  for (const [index, message] of messages.entries()) {
    turns.push({ message, raw, line, index });
  }
}

/** A display entry, put in the shape a message of the journal has. */
function displayTurn(message: LedgerDisplayMessage, line: LedgerLine, raw: unknown): LedgerTurn {
  return { message: displayToMessage(message), raw, line, index: 0 };
}

/** The message of a display entry, as a message of the journal reads it. */
function displayToMessage(message: LedgerDisplayMessage): McodeMessage {
  const at = message.timestamp === undefined ? {} : { timestamp: message.timestamp };
  if (message.role === "user") {
    return { role: "user", content: message.msg_content ?? "", ...at };
  }
  if (message.role !== "assistant") {
    return { role: message.role, ...at };
  }
  const blocks: {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
  }[] = [];
  if (message.thinking_content !== undefined && message.thinking_content.length > 0) {
    blocks.push({ type: "thinking", thinking: message.thinking_content });
  }
  if (message.msg_content !== undefined && message.msg_content.length > 0) {
    blocks.push({ type: "text", text: message.msg_content });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.tool_call_id === undefined || call.tool_name === undefined) continue;
    const args = call.tool_call_args === undefined ? undefined : parseArgs(call.tool_call_args);
    blocks.push({
      type: "toolCall",
      id: call.tool_call_id,
      name: call.tool_name,
      ...(args === undefined ? {} : { arguments: args }),
    });
  }
  return { role: "assistant", content: blocks, ...at };
}

/** The arguments of a call: JSON as a string, or the string itself when it is not JSON. */
function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The lines of the ledger, with the tail marked when it is not whole. */
function splitLines(bytes: Buffer): LedgerLine[] {
  const lines: LedgerLine[] = [];
  let start = 0;
  for (;;) {
    const lf = bytes.indexOf(0x0a, start);
    if (lf < 0) break;
    lines.push({ byte: start, bytes: bytes.subarray(start, lf), complete: true });
    start = lf + 1;
  }
  if (start < bytes.length) {
    lines.push({ byte: start, bytes: bytes.subarray(start), complete: false });
  }
  return lines;
}
