/**
 * The pi reading side: how niwa reads what pi already holds.
 *
 * pi keeps one file per session under its agent directory:
 *
 * ```
 * <home>/sessions/--<slug(cwd)>--/<fileTimestamp>_<sessionId>.jsonl
 * ```
 *
 * The file is JSON Lines: one object per line. The first object is the header, and it carries
 * the session id, the working directory and the start time. The rest are the entries of the
 * conversation, each with its own id and a link to its parent.
 *
 * What this side promises, and how pi's storage is mapped onto it:
 *
 * - `list` walks the session directories and reads the header of each file. It copies nothing:
 *   a session pi started without niwa is in the list like any other.
 * - `read` maps pi's entries onto the common record kinds. An entry niwa has no kind for becomes
 *   "unknown" with its raw data kept: pi's format changes without notice, and an unfamiliar
 *   record is never an error.
 * - The last line of a file that is still being written may be half written. It is marked
 *   `incomplete`, and the reader does not move past it.
 * - `coverage` states what is known about a range. "I do not know" is never shown as "nothing".
 *
 * The identity of a session is the harness id together with pi's own id, the same id the pi
 * insert reports (`piSession`). pi's id alone can repeat across projects (a tool may pin the id of
 * a new session); when it does, the session whose file was written last is the one that id names,
 * in `list` and in `read` alike.
 *
 * A pi file holds a tree: every entry names its parent, and going back to an earlier entry and
 * continuing from there starts a new branch in the same file. The records are those of the file in
 * the order pi wrote it, every branch of it. A branch that was left is still something the agent
 * did, and a locator is a place in the file, which a later branch cannot move. The tree itself is
 * in `raw`: each entry keeps its `id` and `parentId`.
 */

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { z } from "zod";

import { assertNever, jsonOf, timestamp } from "@niwa-labs/core";
import {
  EMPTY,
  LocatorSchema,
  NOT_SCANNED,
  TitleCache,
  failedCoverage,
  sessionId,
  titleFromText,
  unavailableCoverage,
} from "@niwa-labs/harness";
import { FileEntrySchema, SessionHeaderSchema } from "./protocol/index.ts";
import type { AssistantBlock, InputBlock, KnownMessage, SessionHeader } from "./protocol/index.ts";
import { piToolShape } from "./tools.ts";
import type {
  Coverage,
  HarnessId,
  Locator,
  SessionFilter,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
  TitleKey,
} from "@niwa-labs/harness";

/* ------------------------------------------------------------------ layout */

/**
 * The directory of one project: `--<slug(cwd)>--`.
 *
 * The slug is pi's own encoding of the working directory, and it is only a shape to recognise.
 * pi reuses a directory whose slug no longer matches its contents, so the working directory is
 * read from the header and never from the directory name.
 */
const SESSION_DIRECTORY = /^--.+--$/;

/**
 * The file of one session: the start time of the session with its colons and dots turned into
 * dashes, an underscore, and pi's own id.
 */
const SESSION_FILE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

/**
 * The files pi writes next to its sessions that are not sessions.
 *
 * The `*.jsonl.pass1.jsonl` copies hold blocks of a prompt cache, and `run-history.jsonl` holds
 * the runs of the agent. Neither is a session, and the shape of the name of a session does not
 * keep them out on its own: the suffix of a prompt-cache copy looks like an id.
 */
const NOT_A_SESSION = [".pass1.jsonl", "run-history.jsonl"];

/** The start time in a session's file name, as pi wrote it. */
const FILE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(\d{3})Z_/;

/** The name of the file of a session of a run of subagents. */
const RUN_SESSION_FILE = "session.jsonl";

/** The name of the directory of one run of subagents. */
const RUN_DIRECTORY = /^run-\d+$/;

/* ------------------------------------------------------------- pi records */

// The lines of a session file are the entries of `./protocol/entries.ts`: a header, then the entries
// of the tree. They are read there, and mapped onto the common kinds below.

/**
 * The schema of `raw`: what a caller gets when it asks for pi's own record whole.
 *
 * It is a JSON value, because that is what one line of a pi session file is.
 */
export const PI_RAW_SCHEMA = z.json();

/* ---------------------------------------------------------------- records */

/**
 * A record on its way out, before it is given its place in the file.
 *
 * The place is added at the end, because the place of a record is not known until the whole line
 * is read: one line of pi's file can carry several records.
 */
type Draft =
  | { readonly kind: "user"; readonly text: string; readonly at?: number }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly model?: string;
      readonly at?: number;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input?: unknown;
      readonly at?: number;
    }
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly name?: string;
      readonly output?: unknown;
      readonly ok?: boolean;
      readonly at?: number;
    }
  | { readonly kind: "compaction"; readonly summary: string; readonly at?: number }
  | { readonly kind: "nested"; readonly child: SessionId; readonly at?: number }
  | { readonly kind: "unknown"; readonly raw: unknown; readonly at?: number };

/* ---------------------------------------------------------------- helpers */

/** The moment of an ISO time, in milliseconds; `undefined` when there is no time to read. */
function atOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, ms);
}

/** The text of a content: a string as it is, blocks by their text. */
function textOf(content: string | readonly InputBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

/** The time of an entry, however the entry carries it. */
function timeOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as { readonly timestamp?: unknown }).timestamp;
  if (typeof raw === "string") return atOf(raw);
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return undefined;
}

/** A JSON value, or `null` when the text is not JSON. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** A line as JSON; text that does not parse is kept as text, never an error. */
function parseLine(bytes: Uint8Array): unknown {
  const value = parseJson(new TextDecoder().decode(bytes));
  return value === null ? new TextDecoder().decode(bytes) : value;
}

/** pi's own id, taken from the name of the file that holds the session. */
function nativeIdOfFileName(name: string): string | null {
  if (!SESSION_FILE.test(name)) return null;
  if (NOT_A_SESSION.some((suffix) => name.endsWith(suffix))) return null;
  const separator = name.indexOf("_");
  if (separator < 0) return null;
  return name.slice(separator + 1, name.length - ".jsonl".length);
}

/**
 * The start time in the name of a session's file.
 *
 * pi writes the time with dashes where the ISO time has colons, so it is put back into the shape
 * the parser understands before it is read.
 */
function startedAtOfFileName(name: string): number | undefined {
  const match = FILE_TIMESTAMP.exec(name);
  if (match === null) return undefined;
  const iso = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  return atOf(`${iso}.${match[2]}Z`);
}

/* --------------------------------------------------------------- locators */

/**
 * A locator is `pi:v1:<prefixBytes>:<prefixHash>:<offset>:<after>`.
 *
 * The head of the file it was taken from is hashed, so a file that was rewritten or truncated is
 * detected instead of being read as something it is not. The offset is the start of the line, and
 * `after` is how many of that line's records were already delivered: reading from a locator gives
 * what FOLLOWS the record it was taken from.
 *
 * The hash covers only the bytes that are final by the end of that line. A session that is still
 * running grows, and the locators it already gave out must keep naming the same records.
 */
const LOCATOR_TAG = "pi";
const LOCATOR_VERSION = "v2";

/** Bytes of the head of the file the revision hashes. */
const PREFIX_BYTES = 4096;

/**
 * A locator read back.
 *
 * The path is the identity of the file the record was in: two sessions of the same project can
 * begin with the very same bytes, and a locator that does not say which file it belongs to would
 * be accepted by the other one.
 */
type Position = {
  readonly path: string;
  readonly prefixBytes: number;
  readonly prefixHash: string;
  readonly offset: number;
  readonly after: number;
};

/** The bytes of the head of a file, and how many were read. */
async function prefixOf(path: string, count: number): Promise<Buffer> {
  const buffer = Buffer.alloc(count);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Does the position still mean what it meant? A session file is only appended to, so its head
 * stays; a rewritten or truncated file fails the hash, the size, or the line boundary.
 */
async function positionHolds(path: string, position: Position): Promise<boolean> {
  const info = await stat(path);
  if (position.offset >= info.size) return false;
  const head = await prefixOf(path, position.prefixBytes);
  if (head.length !== position.prefixBytes) return false;
  if (hashOf(head) !== position.prefixHash) return false;
  if (position.offset === 0) return true;
  const handle = await open(path, "r");
  try {
    const before = Buffer.alloc(1);
    const { bytesRead } = await handle.read(before, 0, 1, position.offset - 1);
    return bytesRead === 1 && before[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * The locator of a record of `line`.
 *
 * The revision hashes the head of the file, but only the bytes that are final by the end of that
 * line, so a session that grows keeps the locators it already gave out. `after` is how many
 * records of that line were already delivered, the half-written tail included: reading from a
 * locator gives what FOLLOWS the record it was taken from.
 */
function makeLocator(path: string, head: Buffer, line: RawLine, after: number): Locator {
  const final = line.complete ? line.byte + line.bytes.length + 1 : line.byte;
  const prefix = head.subarray(0, Math.min(final, head.length));
  return LocatorSchema.parse(
    `${LOCATOR_TAG}:${LOCATOR_VERSION}:${encodeURIComponent(path)}:${prefix.length}:${hashOf(
      prefix,
    )}:${line.byte}:${after}`,
  );
}
/** A locator that is not this side's own is refused by name. */
function decodeLocator(locator: Locator): Position {
  const parts = locator.split(":");
  const [tag, version, path, bytes, hash, offset, after] = parts;
  const numbers = [bytes, offset, after].map(Number);
  if (
    parts.length !== 7 ||
    tag !== LOCATOR_TAG ||
    version !== LOCATOR_VERSION ||
    path === undefined ||
    hash === undefined ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    throw new Error(`pi: the locator "${locator}" is not of this side's form`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`pi: the locator "${locator}" is not of this side's form`);
  }
  return {
    path: decoded,
    prefixBytes: numbers[0]!,
    prefixHash: hash,
    offset: numbers[1]!,
    after: numbers[2]!,
  };
}

/* --------------------------------------------------------------- the files */

/** One line of a session file, with where it is. */
type RawLine = {
  /** The offset of the start of the line. */
  readonly byte: number;
  /** The bytes of the line, without its line feed. */
  readonly bytes: Buffer;
  /** `false` — no line feed yet: the half-written tail of the file. */
  readonly complete: boolean;
};

/** How much of the file is read at a time. */
const CHUNK_SIZE = 65_536;

/**
 * The lines of a session file, with their offsets.
 *
 * Reading starts at `fromByte`, and the lines before it are not looked at. The last line of a
 * file that is still being written has no line feed; it is the tail, and it may be half written.
 */
async function* scanLines(path: string, fromByte: number): AsyncGenerator<RawLine> {
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    let filePos = fromByte;
    let lineStart = fromByte;
    let carry: Buffer[] = [];
    let carryLen = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_SIZE, filePos);
      if (bytesRead === 0) break;
      filePos += bytesRead;
      let from = 0;
      for (;;) {
        const lf = chunk.indexOf(0x0a, from);
        if (lf < 0 || lf >= bytesRead) break;
        const part = chunk.subarray(from, lf);
        const bytes = carry.length === 0 ? part : Buffer.concat([...carry, part]);
        yield { byte: lineStart, bytes, complete: true };
        lineStart += carryLen + (lf - from) + 1;
        carry = [];
        carryLen = 0;
        from = lf + 1;
      }
      if (from < bytesRead) {
        carry.push(Buffer.from(chunk.subarray(from, bytesRead)));
        carryLen += bytesRead - from;
      }
    }
    if (carryLen > 0) {
      yield { byte: lineStart, bytes: Buffer.concat(carry), complete: false };
    }
  } finally {
    await handle.close();
  }
}

/**
 * The header of a session file: its first line.
 *
 * The header is read on its own, without the rest of the file: it is what is needed to name a
 * session, and it is the first line.
 */
async function readHeader(path: string): Promise<SessionHeader | null> {
  for await (const line of scanLines(path, 0)) {
    const parsed = SessionHeaderSchema.safeParse(parseLine(line.bytes));
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * What a session file says about its session, in one pass over its beginning.
 *
 * The header is the first line, and the name of the session sits in a `session_info` entry near
 * the beginning. Both are looked for in the same bytes: a session file holds megabytes of text
 * that are none of this side's business, so only its beginning is read.
 */
type SessionMeta = {
  /** The header, when the file starts with one. */
  readonly header: SessionHeader | null;
  /** The name the owner gave the session, when there is one. */
  readonly title: string | undefined;
};

/** The marker of the entry that carries the name of a session. */
const NAME_MARKER = Buffer.from('"session_info"');

/**
 * How much of a session file is read to learn what it says about its session.
 *
 * pi writes the name into a `session_info` entry that, on the machine this was written on, sat
 * within the first 7 kB of the file. The search stops here, and the session is then listed
 * without a name: a name is a nicety, and a whole session file is not worth reading for one.
 */
const META_BYTES = 256 * 1024;

/**
 * The header and the name of a session, in one pass.
 *
 * The last `session_info` entry wins: it may also clear the name. Only the lines that carry the
 * marker of that entry are decoded.
 */
async function readMeta(path: string): Promise<SessionMeta> {
  let header: SessionHeader | null = null;
  let title: string | undefined;
  let first = true;
  for await (const line of scanLines(path, 0)) {
    if (line.byte >= META_BYTES) break;
    if (first) {
      // The header is the first line of the file.
      const parsed = SessionHeaderSchema.safeParse(parseLine(line.bytes));
      header = parsed.success ? parsed.data : null;
      first = false;
    }
    if (!line.bytes.includes(NAME_MARKER)) continue;
    const value = parseLine(line.bytes);
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { readonly type?: unknown; readonly name?: unknown };
    if (entry.type !== "session_info") continue;
    title = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined;
  }
  return { header, title };
}

/* ---------------------------------------------------------------- mapping */

/** The records of one entry of pi's file. */
function draftsOfValue(value: unknown, at: number | undefined): Draft[] {
  const parsed = FileEntrySchema.safeParse(value);
  // A line that is none of the entries of this snapshot of pi's format, or one that is shaped
  // otherwise than the snapshot says, is kept whole under "unknown": pi's format changes without notice.
  if (!parsed.success) return [{ kind: "unknown", raw: value, at }];
  const entry = parsed.data;
  switch (entry.type) {
    // The header is what is known about the session, not a record of the conversation.
    case "session":
      return [];
    case "message":
      return draftsOfMessage(entry.message, value, at);
    case "compaction":
      return [{ kind: "compaction", summary: entry.summary, at }];
    // These have no common kind: a model or thinking-level change, the accounting of a call outside
    // the conversation, a summary of a left branch, state an extension keeps, a message an extension
    // injected, an edit of what an earlier entry contributes to the context, a bookmark, the name
    // of the session. Each is kept whole rather than dropped.
    case "model_change":
    case "thinking_level_change":
    case "usage":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "context_edit":
    case "label":
    case "session_info":
      return [{ kind: "unknown", raw: value, at }];
    default:
      return assertNever(entry, "pi session entry");
  }
}

/** The records of one message of pi's file; `entry` is the line it came in, kept whole where it is not mapped. */
function draftsOfMessage(message: KnownMessage, entry: unknown, at: number | undefined): Draft[] {
  const when = at ?? message.timestamp;

  switch (message.role) {
    case "user": {
      const text = textOf(message.content);
      // A message without words, an image alone, holds nothing to say as text: it is kept whole.
      if (text.length === 0) return [{ kind: "unknown", raw: entry, at: when }];
      return [{ kind: "user", text, at: when }];
    }
    case "assistant": {
      const drafts: Draft[] = [];
      const blocks: readonly AssistantBlock[] =
        typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      for (const block of blocks) drafts.push(draftOfBlock(block, message.model, when));
      // A message with nothing in it is still an entry of the session.
      return drafts.length === 0 ? [{ kind: "unknown", raw: entry, at: when }] : drafts;
    }
    case "toolResult": {
      if (message.toolCallId.length === 0) {
        // Without the id of the call there is nothing to pair the answer with.
        return [{ kind: "unknown", raw: entry, at: when }];
      }
      return [
        {
          kind: "tool-result",
          callId: message.toolCallId,
          name: message.toolName,
          // The answer as pi stored it, whole: a text may be one block among others.
          output: message.content,
          ok: message.isError !== true,
          at: when,
        },
      ];
    }
    // A system message is the harness talking, not the owner and not the model; a bash execution,
    // an extension's message and the summaries of a branch or a compaction are not what a person or
    // the model said. None has a common kind: each is kept whole.
    case "system":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return [{ kind: "unknown", raw: entry, at: when }];
    default:
      return assertNever(message, "pi message role");
  }
}

/** The record of one block of what the model said. */
function draftOfBlock(block: AssistantBlock, model: string | undefined, at: number | undefined): Draft {
  switch (block.type) {
    case "text":
      // An empty text says nothing; it is kept whole.
      return block.text.length > 0 ? { kind: "assistant", text: block.text, model, at } : { kind: "unknown", raw: block, at };
    case "toolCall":
      return block.id.length > 0 && block.name.length > 0
        ? { kind: "tool-call", callId: block.id, name: block.name, input: block.arguments, at }
        : // A call that cannot be paired is kept whole.
          { kind: "unknown", raw: block, at };
    // The model's reasoning has no common kind: it is kept whole. So is a block that is not in the
    // snapshot, which carries what it came as.
    case "thinking":
      return { kind: "unknown", raw: block, at };
    case "unrecognized":
      return { kind: "unknown", raw: block.raw, at };
    default:
      return assertNever(block, "pi assistant block");
  }
}

/**
 * A record before the reading side has put its locator in.
 *
 * The locator is added when the record is yielded, because the locator of a record says where the
 * file was when it was read, and that is known only then.
 */
type Unlocated = SessionRecord extends infer R
  ? R extends unknown
    ? Omit<R, "locator">
    : never
  : never;

/** The fields every record carries. */
interface RecordBase {
  readonly at?: number;
  readonly incomplete: boolean;
}

/** The records of one line, without their places. */
function recordsOfLine(drafts: Draft[], incomplete: boolean): Unlocated[] {
  const base: RecordBase = { incomplete };
  return drafts.map((draft) => {
    switch (draft.kind) {
      case "user":
        return { kind: "user", text: draft.text, ...atField(draft.at), ...base };
      case "assistant":
        return {
          kind: "assistant",
          text: draft.text,
          ...(draft.model === undefined ? {} : { model: draft.model }),
          ...atField(draft.at),
          ...base,
        };
      case "tool-call":
        return {
          kind: "tool-call",
          callId: draft.callId,
          name: draft.name,
          ...piToolShape(draft.name, draft.input),
          ...(draft.input === undefined ? {} : { input: jsonOf(draft.input) }),
          ...atField(draft.at),
          ...base,
        };
      case "tool-result":
        return {
          kind: "tool-result",
          callId: draft.callId,
          ...(draft.name === undefined ? {} : { name: draft.name }),
          ...(draft.output === undefined ? {} : { output: jsonOf(draft.output) }),
          ...(draft.ok === undefined ? {} : { ok: draft.ok }),
          ...atField(draft.at),
          ...base,
        };
      case "compaction":
        return {
          kind: "compaction",
          summary: draft.summary,
          ...atField(draft.at),
          ...base,
        };
      case "nested":
        return { kind: "nested", child: draft.child, ...atField(draft.at), ...base };
      case "unknown":
        return { kind: "unknown", raw: draft.raw, ...atField(draft.at), ...base };
    }
  });
}

/** The time of a record, when it is known. */
function atField(at: number | undefined): { readonly at?: number } {
  return at === undefined ? {} : { at };
}

/* ----------------------------------------------------------------- state */

/** A session file that was found. */
type Resolved = {
  /** The path of the file. */
  readonly path: string;
  /** The directory of the project the session belongs to. */
  readonly project: string;
  /** When the file was last written, in milliseconds. */
  readonly updatedAt: number;
};

/** The options of the pi reading side. */
export interface PiReadingOptions {
  /** The id of the harness instance this side reads for. */
  readonly harness: HarnessId;
  /** The root of pi's session storage: `<home>/sessions`. */
  readonly sessionsRoot: string;
}

/**
 * The pi reading side.
 *
 * It works from pi's files, so pi itself need not be running: a session pi started on its own,
 * weeks ago, is read the same way.
 */
export function piReading(options: PiReadingOptions): SessionReading {
  const harness = options.harness;
  const root = resolvePath(options.sessionsRoot);

  /** The id of a session: this installation and pi's own id. */
  const idOf = (native: string): SessionId => sessionId(harness, native);

  /** The names of the project directories. */
  const projectsOf = async (): Promise<string[]> => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SESSION_DIRECTORY.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  };

  /** The names of the files of one project. */
  const filesOfProject = async (project: string): Promise<string[]> => {
    try {
      return await readdir(join(root, project));
    } catch {
      return [];
    }
  };

  /** The names of the directories inside one directory. */
  const directoriesOf = async (path: string): Promise<string[]> => {
    try {
      return await readdir(path, { withFileTypes: true }).then((entries) =>
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      );
    } catch {
      return [];
    }
  };

  /**
   * The file of a session of a run of subagents, found by pi's own id.
   *
   * pi keeps the sessions of a run in a directory named after the session that spawned them:
   * `<session file without .jsonl>/<run>/run-N/session.jsonl`.
   */
  const findInRuns = async (id: string): Promise<Resolved | null> => {
    let found: Resolved | null = null;
    for (const project of await projectsOf()) {
      for (const path of await runSessionsOf(project)) {
        const header = await readHeader(path).catch(() => null);
        if (header?.id !== id) continue;
        const info = await stat(path).catch(() => null);
        if (info === null) continue;
        if (found === null || info.mtimeMs > found.updatedAt) {
          found = { path, project, updatedAt: info.mtimeMs };
        }
      }
    }
    return found;
  };

  /**
   * The files of the sessions of the runs of subagents of one project.
   *
   * A run keeps its sessions under the file of the session that spawned it: the name of the
   * file without its extension is the name of the directory.
   */
  const runSessionsOf = async (project: string): Promise<string[]> => {
    const files: string[] = [];
    for (const session of await directoriesOf(join(root, project))) {
      for (const run of await directoriesOf(join(root, project, session))) {
        for (const child of await directoriesOf(join(root, project, session, run))) {
          if (!RUN_DIRECTORY.test(child)) continue;
          files.push(join(root, project, session, run, child, RUN_SESSION_FILE));
        }
      }
    }
    return files;
  };

  /**
   * The file of a session, found by pi's own id.
   *
   * An id that several files carry names the file written last.
   */
  const findSession = async (id: SessionId): Promise<Resolved | null> => {
    let found: Resolved | null = null;
    for (const project of await projectsOf()) {
      for (const name of await filesOfProject(project)) {
        if (nativeIdOfFileName(name) !== id.native) continue;
        const path = join(root, project, name);
        const info = await stat(path).catch(() => null);
        if (info === null) continue;
        if (found === null || info.mtimeMs > found.updatedAt) {
          found = { path, project, updatedAt: info.mtimeMs };
        }
      }
    }
    return found ?? (await findInRuns(id.native));
  };

  /**
   * The sessions that were spawned inside a session.
   *
   * Two things are told apart by pi's own files: a run of subagents keeps its sessions in a
   * directory named after the session that spawned them, and a fork names the file of its
   * parent in its header.
   */
  const childrenOf = async (session: Resolved): Promise<Draft[]> => {
    const drafts: Draft[] = [];
    const stem = basename(session.path, ".jsonl");
    const runs = join(dirname(session.path), stem);
    for (const run of await directoriesOf(runs)) {
      for (const child of await directoriesOf(join(runs, run))) {
        if (!RUN_DIRECTORY.test(child)) continue;
        const header = await readHeader(join(runs, run, child, RUN_SESSION_FILE)).catch(() => null);
        if (header === null) continue;
        drafts.push({
          kind: "nested",
          child: idOf(header.id),
          at: atOf(header.timestamp),
        });
      }
    }

    // A fork names the file of its parent, and the parent is the one that spawned it.
    for (const name of await filesOfProject(session.project)) {
      if (name === basename(session.path)) continue;
      const file = join(root, session.project, name);
      const header = await readHeader(file).catch(() => null);
      const parentSession = header?.parentSession;
      if (parentSession === undefined || parentSession.length === 0) continue;
      if (resolvePath(parentSession) !== resolvePath(session.path)) continue;
      if (header === null) continue;
      drafts.push({
        kind: "nested",
        child: idOf(header.id),
        at: atOf(header.timestamp),
      });
    }
    return drafts;
  };

  /** The records of a line, with the time the line carries. */
  const draftsOfLine = (line: RawLine): Draft[] => {
    const text = line.bytes.toString("utf8");
    if (text.trim().length === 0) return [];
    const value = parseJson(text);
    if (value === null) {
      // A line that is not JSON: pi's own words are kept as they are, so nothing is lost.
      return [{ kind: "unknown", raw: text }];
    }
    return draftsOfValue(value, timeOf(value));
  };

  /**
   * The title made from the first message of the person, among the first records of a file: the
   * title of a session the owner gave no name.
   */
  const titles = new TitleCache();

  const firstMessageOf = async (path: string, key: TitleKey): Promise<string | undefined> => {
    // The title kept for the file as it is now; a file that is new or has grown is looked into.
    const kept = titles.get(path, key);
    if (kept !== undefined) return kept.title;
    const title = await firstMessageIn(path);
    titles.set(path, key, title);
    return title;
  };

  const firstMessageIn = async (path: string): Promise<string | undefined> => {
    let seen = 0;
    for await (const line of scanLines(path, 0)) {
      for (const draft of draftsOfLine(line)) {
        seen += 1;
        if (seen > 50) return undefined;
        if (draft.kind !== "user") continue;
        const title = titleFromText(draft.text);
        if (title !== undefined) return title;
      }
    }
    return undefined;
  };

  return {
    rawSchema: PI_RAW_SCHEMA,

    async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
      const wanted = filter?.natives === undefined ? undefined : new Set(filter.natives);
      // One id names one session: of several files with the same id, the one written last.
      const found = new Map<string, SessionInfo>();
      for (const project of await projectsOf()) {
        // The sessions of the project itself, and the sessions of the runs of subagents that
        // were spawned inside them.
        const files: { path: string; native: string | null }[] = [];
        for (const name of (await filesOfProject(project)).sort()) {
          files.push({ path: join(root, project, name), native: nativeIdOfFileName(name) });
        }
        for (const path of await runSessionsOf(project)) {
          files.push({ path, native: null });
        }

        for (const file of files) {
          // A session that is not wanted is left out before its file is opened.
          if (wanted !== undefined && file.native !== null && !wanted.has(file.native)) continue;
          const info = await stat(file.path).catch(() => null);
          if (info === null) continue;
          const updatedAt = Math.max(0, Math.floor(info.mtimeMs));
          if (filter?.since !== undefined && updatedAt < filter.since) continue;
          const meta = await readMeta(file.path).catch(() => null);
          const header = meta?.header ?? null;
          // A session of a run takes pi's own id from its header; the file of a session of a
          // project takes it from the name of the file.
          const native = file.native ?? header?.id ?? null;
          if (native === null) continue;
          if (wanted !== undefined && !wanted.has(native)) continue;
          const cwd = header?.cwd;
          if (filter?.cwd !== undefined && cwd !== filter.cwd) continue;
          const startedAt =
            atOf(header?.timestamp) ??
            (file.native === null ? undefined : startedAtOfFileName(basename(file.path)));
          // The name the owner gave the session, else the first thing he said in it.
          const title =
            meta?.title ??
            (await firstMessageOf(file.path, { size: info.size, mtimeMs: info.mtimeMs }).catch(() => undefined));
          const listed: SessionInfo = {
            id: idOf(native),
            ...(title === undefined ? {} : { title }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(startedAt === undefined ? {} : { startedAt: timestamp(startedAt) }),
            updatedAt: timestamp(updatedAt),
          };
          const earlier = found.get(native);
          if (earlier === undefined || (earlier.updatedAt ?? 0) < updatedAt) found.set(native, listed);
        }
      }
      yield* found.values();
    },

    async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
      const session = await findSession(id);
      if (session === null) return;
      const position = from === undefined ? undefined : decodeLocator(from);
      let head: Buffer;
      try {
        head = await prefixOf(session.path, PREFIX_BYTES);
      } catch {
        return;
      }
      // A locator names the file it was taken from. One that names another session is refused, and
      // one whose file was rewritten no longer names a record: both are said out loud, because
      // answering with the whole session again would look like the session had been read.
      if (position !== undefined && position.path !== session.path) {
        throw new Error(
          `pi: the locator was taken from another session, not from "${id.native}"`,
        );
      }
      if (position !== undefined && !(await positionHolds(session.path, position))) {
        throw new Error(
          `pi: the locator no longer names a record of "${id.native}": its file was rewritten`,
        );
      }
      const resume = position;
      // The sessions spawned inside this one are told once, at the place the session begins. They
      // are found on every read, because the locator of a nested record counts them.
      const nested = await childrenOf(session);
      for await (const line of scanLines(session.path, resume?.offset ?? 0)) {
        const drafts = [...(line.byte === 0 ? nested : []), ...draftsOfLine(line)];
        const records = recordsOfLine(drafts, !line.complete);
        const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
        for (const [index, record] of records.entries()) {
          if (index < skip) continue;
          yield { ...record, locator: makeLocator(session.path, head, line, index + 1) } as SessionRecord;
        }
      }
    },
    async raw(id: SessionId, locator: Locator): Promise<unknown> {
      const position = decodeLocator(locator);
      const session = await findSession(id);
      if (session === null) throw new Error(`pi: the session "${id.native}" is not on disk`);
      if (position.path !== session.path) {
        throw new Error(`pi: the locator was taken from another session, not from "${id.native}"`);
      }
      if (!(await positionHolds(session.path, position))) {
        throw new Error(
          `pi: the locator does not belong to the current file of "${id.native}"`,
        );
      }
      for await (const line of scanLines(session.path, position.offset)) {
        return parseLine(line.bytes);
      }
      throw new Error(`pi: no record at the locator of the session "${id.native}"`);
    },

    async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
      const session = await findSession(id);
      if (session === null) {
        return unavailableCoverage(
          `pi: the session "${id.native}" is not in the sessions of this installation`,
        );
      }
      try {
        const position = from === undefined ? undefined : decodeLocator(from);
        // The range is looked at until it is known to hold something. A range that holds records
        // has not been read into niwa, so it is "not scanned": saying "empty" about it would be a
        // lie, and only "empty" may say that there is nothing there.
        //
        // The sessions spawned inside this one are counted too: they are records of this session,
        // and a range that holds them is not empty.
        const nested = await childrenOf(session);
        const resume =
          position !== undefined && (await positionHolds(session.path, position))
            ? position
            : undefined;
        for await (const line of scanLines(session.path, resume?.offset ?? 0)) {
          const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
          const drafts = [...(line.byte === 0 ? nested : []), ...draftsOfLine(line)];
          if (recordsOfLine(drafts, !line.complete).length > skip) return NOT_SCANNED;
        }
        return EMPTY;
      } catch (error) {
        return failedCoverage(
          `pi: the session "${id.native}" could not be scanned: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
