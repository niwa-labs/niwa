/**
 * The reading side of a Claude Code installation. It works
 * from the files and copies nothing: the format is in `format.ts`, the layout in `paths.ts`.
 *
 * A locator is `claude-code:v1:<prefixBytes>:<prefixHash>:<offset>:<after>`: the head of the log it
 * was taken from (a rewritten or truncated file is detected), the start of the line, and how many
 * of that line's records were already delivered. A half-written tail line has `after = 0`, so a
 * resume reads it again once it is whole.
 */

import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { optionalJsonOf, timestamp, assertNever } from "@niwa-labs/core";
import type { Timestamp } from "@niwa-labs/core";
import type {
  HarnessId,
  Coverage,
  Locator,
  SessionFilter,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
} from "@niwa-labs/harness";
import {
  EMPTY,
  LocatorSchema,
  NOT_SCANNED,
  NativeSessionIdSchema,
  failedCoverage,
  titleFromText,
  unavailableCoverage,
} from "@niwa-labs/harness";

import {
  RawRecordSchema,
  isServerError,
  millisOf,
  newParseState,
  parseNativeRecord,
  readBlocks,
} from "./format.ts";
import type { Block, ParseState } from "./format.ts";
import {
  agentIdOfFile,
  agentIdOfMetaFile,
  dirNamesOf,
  entryNamesOf,
  fileNamesOf,
  nativeIdOfSubagent,
  projectsRootOf,
  sessionIdOfFile,
  sessionLogOf,
  subagentLogOf,
  subagentsDirOf,
} from "./paths.ts";

export interface ClaudeCodeReadingOptions {
  /** The id of the installation this side serves. */
  readonly harness: HarnessId;
  /** The directory that holds `projects`. */
  readonly home: string;
}

const CHUNK_SIZE = 65_536;
/** Bytes of the head of the log the revision hashes. */
const PREFIX_BYTES = 4096;
/** The head of a log is searched for the working directory and the title. */
const HEAD_BYTES = 262_144;

/** A record before the reading side has put its locator in. */
type Unlocated = SessionRecord extends infer R ? (R extends unknown ? Omit<R, "locator"> : never) : never;

interface RecordBase {
  readonly at?: number;
  readonly incomplete: boolean;
}

interface RawLine {
  /** Offset of the start of the line. */
  readonly byte: number;
  /** The bytes without the LF. */
  readonly bytes: Uint8Array;
  /** `false` — no LF yet: the half-written tail of the log. */
  readonly complete: boolean;
}

/** A log that was found on disk. */
interface FoundLog {
  /** The path of the log. */
  readonly path: string;
  /** The directory of the project the log belongs to. */
  readonly projectDir: string;
  /** The id the harness gave this session. */
  readonly native: string;
  /** The session this one was spawned in, when it was spawned. */
  readonly parent: string | undefined;
}

/** A locator read back. */
interface Position {
  readonly prefixBytes: number;
  readonly prefixHash: string;
  readonly offset: number;
  readonly after: number;
}

/** Lines of a file from `fromByte` (a line start), streamed; memory holds one chunk and one line. */
async function* scanLines(handle: FileHandle, fromByte: number): AsyncGenerator<RawLine> {
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
}

/** A line as JSON; text that does not parse is kept as text, never an error. */
function parseLine(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isBlank(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0x20 || b === 0x09 || b === 0x0d);
}

async function prefixOf(handle: FileHandle, count: number): Promise<Buffer> {
  const buffer = Buffer.alloc(count);
  const { bytesRead } = await handle.read(buffer, 0, count, 0);
  return buffer.subarray(0, bytesRead);
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Does the position still mean what it meant? The log is only appended to, so its head stays;
 * a rewritten or truncated file fails the head hash, the size, or the line boundary.
 */
async function positionHolds(handle: FileHandle, position: Position): Promise<boolean> {
  const { size } = await handle.stat();
  if (position.offset >= size) return false;
  const head = await prefixOf(handle, position.prefixBytes);
  if (head.length !== position.prefixBytes || hashOf(head) !== position.prefixHash) return false;
  if (position.offset === 0) return true;
  const before = Buffer.alloc(1);
  const { bytesRead } = await handle.read(before, 0, 1, position.offset - 1);
  return bytesRead === 1 && before[0] === 0x0a;
}

/**
 * The locator of a record.
 *
 * The revision is the head of the log up to the end of the line the record is in: a log grows as
 * it is written, and the records before the new bytes must keep the locators they had.
 */
function makeLocator(head: Buffer, line: RawLine, after: number): Locator {
  const final = line.complete ? line.byte + line.bytes.length + 1 : line.byte;
  const prefix = head.subarray(0, Math.min(final, head.length));
  return LocatorSchema.parse(
    `claude-code:v1:${prefix.length}:${hashOf(prefix)}:${line.byte}:${line.complete ? after : 0}`,
  );
}

/** A locator that is not this side's own is refused by name. */
function decodeLocator(locator: Locator): Position {
  const parts = locator.split(":");
  const [tag, version, bytes, hash, offset, after] = parts;
  const numbers = [bytes, offset, after].map(Number);
  if (
    parts.length !== 6 ||
    tag !== "claude-code" ||
    version !== "v1" ||
    hash === undefined ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    throw new Error(`claude-code: locator ${locator} is not of this side's form`);
  }
  return { prefixBytes: numbers[0]!, prefixHash: hash, offset: numbers[1]!, after: numbers[2]! };
}

export class ClaudeCodeReading implements SessionReading {
  readonly #harness: HarnessId;
  readonly #projectsRoot: string;

  constructor(options: ClaudeCodeReadingOptions) {
    this.#harness = options.harness;
    this.#projectsRoot = projectsRootOf(options.home);
  }

  /** A line that does not parse is returned as text, an unfamiliar shape as it is. */
  readonly rawSchema = z.union([RawRecordSchema, z.json()]);

  /** The sessions on disk. */
  async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
    const wanted = filter?.natives === undefined ? undefined : new Set(filter.natives);
    for await (const found of this.#discover()) {
      // A session that is not wanted is left out before its log is opened.
      if (wanted !== undefined && !wanted.has(found.native)) continue;
      const info = await this.#infoOf(found);
      if (info === null) continue;
      if (filter?.cwd !== undefined && info.cwd !== filter.cwd) continue;
      if (filter?.since !== undefined && (info.updatedAt === undefined || info.updatedAt < filter.since)) {
        continue;
      }
      yield info;
    }
  }

  /**
   * Records of a session, after `from` when given. A locator whose file was rewritten no longer
   * names a record, so the read then starts from the beginning and delivers everything.
   */
  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    const found = await this.#find(id);
    if (found === null) return;
    const position = from === undefined ? undefined : decodeLocator(from);
    const handle = await open(found.path, "r");
    try {
      // A fixed-size head, not the whole file: a revision that changed with every appended byte
      // would refuse to name its own records a moment later.
      const head = await prefixOf(handle, PREFIX_BYTES);
      const resume = position !== undefined && (await positionHolds(handle, position)) ? position : undefined;
      const state = newParseState();
      const children = await this.#childrenOf(found);
      for await (const line of scanLines(handle, resume?.offset ?? 0)) {
        if (isBlank(line.bytes)) continue;
        const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
        const produced = await this.#recordsOf(line, state, children);
        for (const [index, record] of produced.entries()) {
          if (index < skip) continue;
          yield { ...record, locator: makeLocator(head, line, index + 1) } as SessionRecord;
        }
      }
    } finally {
      await handle.close();
    }
  }

  /** The harness's own record, whole, at a locator of the current file. */
  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    const found = await this.#find(id);
    if (found === null) throw new Error(`claude-code: session ${id.native} is not on disk`);
    const position = decodeLocator(locator);
    const handle = await open(found.path, "r");
    try {
      if (!(await positionHolds(handle, position))) {
        throw new Error(
          `claude-code: locator ${locator} does not belong to the current file of ${id.native}`,
        );
      }
      for await (const line of scanLines(handle, position.offset)) return parseLine(line.bytes);
    } finally {
      await handle.close();
    }
    throw new Error(`claude-code: no record at ${locator} in session ${id.native}`);
  }

  /**
   * `unavailable` — not on disk; `failed` — the scan broke; `empty` — nothing in the range;
   * `not-scanned` — there are records niwa has not read: it copies nothing, so a range is only
   * read when a caller asks `read`.
   */
  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    const found = await this.#find(id);
    if (found === null) return unavailableCoverage(`claude-code: session ${id.native} is not on disk`);
    const position = from === undefined ? undefined : decodeLocator(from);
    try {
      const handle = await open(found.path, "r");
      try {
        const resume = position !== undefined && (await positionHolds(handle, position)) ? position : undefined;
        const state = newParseState();
        const children = await this.#childrenOf(found);
        for await (const line of scanLines(handle, resume?.offset ?? 0)) {
          if (isBlank(line.bytes)) continue;
          const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
          if ((await this.#recordsOf(line, state, children)).length > skip) return NOT_SCANNED;
        }
        return EMPTY;
      } finally {
        await handle.close();
      }
    } catch (error) {
      return failedCoverage(
        `claude-code: session ${id.native} could not be scanned: ${reasonOf(error)}`,
      );
    }
  }

  /** Every log under the root: the sessions of the projects, and the logs of their subagents. */
  async *#discover(): AsyncGenerator<FoundLog> {
    for (const projectDir of await dirNamesOf(this.#projectsRoot)) {
      const dir = join(this.#projectsRoot, projectDir);
      // The entries are read by name, not by what they are: a log that cannot be opened is
      // still a session that is there, and a session that is gone is a different fact.
      for (const name of await entryNamesOf(dir)) {
        const sessionId = sessionIdOfFile(name);
        if (sessionId === null) continue;
        yield {
          path: sessionLogOf(dir, sessionId),
          projectDir: dir,
          native: sessionId,
          parent: undefined,
        };
      }
      for (const name of await dirNamesOf(dir)) {
        const sessionId = sessionIdOfFile(`${name}.jsonl`);
        if (sessionId === null) continue;
        const subagentsDir = subagentsDirOf(dir, sessionId);
        for (const file of await fileNamesOf(subagentsDir)) {
          const agentId = agentIdOfFile(file);
          if (agentId === null) continue;
          yield {
            path: subagentLogOf(dir, sessionId, agentId),
            projectDir: dir,
            native: nativeIdOfSubagent(agentId),
            parent: sessionId,
          };
        }
      }
    }
  }

  /** What is known about a session: its id, its working directory, its title and its times. */
  async #infoOf(found: FoundLog): Promise<SessionInfo | null> {
    const native = found.native;
    if (native.length === 0) return null;
    const head = await this.#headOf(found.path);
    const startedAt = toTimestamp(head.startedAt);
    // When the session was last written is when the file was last written: the harness appends
    // to it, so the moment of the last record inside it is not known without reading it all.
    const updatedAt = toTimestamp(await writtenAtOf(found.path)) ?? startedAt;
    return {
      id: { harness: this.#harness, native: NativeSessionIdSchema.parse(native) },
      ...(head.cwd !== undefined ? { cwd: head.cwd } : {}),
      // The harness's own title, else the first thing the person said.
      ...((head.title ?? head.firstMessage) !== undefined ? { title: head.title ?? head.firstMessage } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  /**
   * What the head of a log says about the session.
   *
   * The working directory and the times are in the first records; the title may be written at any
   * moment, so the head is searched for it. What is not there is not invented. The first message
   * of the person is kept for a session that has no title of its own.
   */
  async #headOf(path: string): Promise<{
    cwd?: string;
    title?: string;
    firstMessage?: string;
    startedAt?: number;
  }> {
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch {
      return {};
    }
    const out: { cwd?: string; title?: string; firstMessage?: string; startedAt?: number } = {};
    try {
      for await (const line of scanLines(handle, 0)) {
        if (line.byte >= HEAD_BYTES) break;
        if (!line.complete) break;
        const record = parseNativeRecord(parseLine(line.bytes));
        if (record === null) continue;
        if (out.cwd === undefined && record.cwd !== undefined && record.cwd.length > 0) {
          out.cwd = record.cwd;
        }
        if (out.startedAt === undefined) {
          const at = millisOf(record.timestamp);
          if (at !== undefined) out.startedAt = at;
        }
        if (out.title === undefined) {
          const title = titleOf(record);
          if (title !== undefined) out.title = title;
        }
        if (out.firstMessage === undefined && record.type === "user" && record.isCompactSummary !== true) {
          for (const block of readBlocks(record.message?.content)) {
            if (block.type !== "text") continue;
            const title = titleFromText(block.text);
            if (title === undefined) continue;
            out.firstMessage = title;
            break;
          }
        }
      }
    } catch {
      // A log that cannot be read gives what was found so far, and nothing more.
    } finally {
      await handle.close();
    }
    return out;
  }

  /** The log of a session, by its id. */
  async #find(id: SessionId): Promise<FoundLog | null> {
    for await (const found of this.#discover()) {
      if (found.native === id.native) return found;
    }
    return null;
  }

  /**
   * The sessions spawned inside this one, by the id of the call that spawned them.
   *
   * The harness writes the id of the call that started a subagent into the description beside
   * the log of the subagent, so the two are matched by it.
   */
  async #childrenOf(found: FoundLog): Promise<Map<string, string>> {
    const children = new Map<string, string>();
    if (found.parent !== undefined) return children;
    const dir = subagentsDirOf(found.projectDir, found.native);
    for (const name of await entryNamesOf(dir)) {
      const agentId = agentIdOfMetaFile(name);
      if (agentId === null) continue;
      const toolUseId = await toolUseIdOf(join(dir, name));
      if (toolUseId === undefined) continue;
      children.set(toolUseId, nativeIdOfSubagent(agentId));
    }
    return children;
  }

  /**
   * The records of one native line. One line may give several: an answer with a call in it gives
   * an assistant record and a tool-call record.
   */
  async #recordsOf(
    line: RawLine,
    state: ParseState,
    children: Map<string, string>,
  ): Promise<Unlocated[]> {
    const parsed = parseLine(line.bytes);
    const record = parseNativeRecord(parsed);
    const incomplete = !line.complete;
    if (record === null) return [unknownRecord(parsed, { incomplete })];
    const at = millisOf(record.timestamp);
    const base: RecordBase = { ...(at !== undefined ? { at } : {}), incomplete };

    if (record.type === "user") {
      return userRecords(record, parsed, base, state, children, this.#harness);
    }
    if (record.type === "assistant") {
      return assistantRecords(record, parsed, base, state, children, this.#harness);
    }
    // A record of a kind niwa does not speak about: it is kept whole.
    return [unknownRecord(parsed, { incomplete })];
  }
}

/** The id of the call that started a subagent, as the description of the subagent writes it. */
async function toolUseIdOf(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>)["toolUseId"];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The title the harness shows for a session, when it has written one. */
function titleOf(record: { aiTitle?: string; customTitle?: string; agentName?: string }): string | undefined {
  const title = record.customTitle ?? record.aiTitle ?? record.agentName;
  return title !== undefined && title.length > 0 ? title : undefined;
}

/** Who wrote a message: the owner or the model. */
type Role = "user" | "assistant";

/** What the owner said, with the machine preamble cut out. */
function userRecords(
  record: { isCompactSummary?: boolean; message?: { content?: string | unknown[] } },
  raw: unknown,
  base: RecordBase,
  state: ParseState,
  children: Map<string, string>,
  harness: HarnessId,
): Unlocated[] {
  const blocks = readBlocks(record.message?.content);
  if (record.isCompactSummary === true) {
    const summary = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    return [{ kind: "compaction", summary, ...base }];
  }
  const records = blocks.flatMap((block) => blockRecords(block, "user", base, state, children, harness));
  return records.length === 0 ? [unknownRecord(raw, base)] : records;
}

/** What the model said, and the calls it made. */
function assistantRecords(
  record: { message?: { content?: string | unknown[]; model?: string } },
  raw: unknown,
  base: RecordBase,
  state: ParseState,
  children: Map<string, string>,
  harness: HarnessId,
): Unlocated[] {
  const model = record.message?.model;
  const records = readBlocks(record.message?.content).flatMap((block) =>
    blockRecords(block, "assistant", base, state, children, harness, model),
  );
  return records.length === 0 ? [unknownRecord(raw, base)] : records;
}

/** The records of one block of a message: every block type has its deliberate mapping. */
function blockRecords(
  block: Block,
  role: Role,
  base: RecordBase,
  state: ParseState,
  children: Map<string, string>,
  harness: HarnessId,
  model?: string,
): Unlocated[] {
  switch (block.type) {
    case "text":
      return role === "user"
        ? [{ kind: "user", text: block.text, ...base }]
        : [{ kind: "assistant", text: block.text, ...(model !== undefined ? { model } : {}), ...base }];
    case "thinking":
      return [{ kind: "thinking", text: block.thinking, redacted: false, ...base }];
    case "redacted_thinking":
      return [{ kind: "thinking", text: "", redacted: true, ...base }];
    case "tool_use": {
      const child = children.get(block.id);
      return [
        callRecord(block.id, block.name, block.input, base, state),
        ...(child === undefined
          ? []
          : [{ kind: "nested" as const, child: { harness, native: NativeSessionIdSchema.parse(child) }, ...base }]),
      ];
    }
    // A server tool (the advisor, a web search, …) runs on the API's side; its call is a call all the same.
    case "server_tool_use":
    case "mcp_tool_use":
      return [callRecord(block.id, block.name, block.input, base, state)];
    case "tool_result":
    case "mcp_tool_result":
      return [resultRecord(block.tool_use_id, block.content, block.is_error !== true, base, state)];
    case "advisor_tool_result":
      return [
        resultRecord(block.tool_use_id, block.content, block.content.type !== "advisor_tool_result_error", base, state),
      ];
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      return [resultRecord(block.tool_use_id, block.content, !isServerError(block.content), base, state)];
    case "compaction":
      // The API's own compaction: its summary, when the block is not sealed.
      return block.content === null ? [unknownRecord(block, base)] : [{ kind: "compaction", summary: block.content, ...base }];
    // A picture, a document, a search result given to the model, an uploaded file, the switch to a
    // fallback model, a server's tool list: none is a text niwa speaks about, each is kept whole.
    case "image":
    case "document":
    case "search_result":
    case "container_upload":
    case "fallback":
    case "mcp_tool_listing":
      return [unknownRecord(block, base)];
    case "unparsed":
      return [unknownRecord(block.raw, base)];
    default:
      return assertNever(block, "Claude Code content block");
  }
}

/** A call of a tool; its name is remembered for its answer, which does not carry it. */
function callRecord(callId: string, name: string, input: unknown, base: RecordBase, state: ParseState): Unlocated {
  state.toolNames.set(callId, name);
  return { kind: "tool-call", callId, name, input: optionalJsonOf(input), ...base };
}

/** The answer of a tool, named by the call it answers. */
function resultRecord(callId: string, output: unknown, ok: boolean, base: RecordBase, state: ParseState): Unlocated {
  const name = state.toolNames.get(callId);
  return { kind: "tool-result", callId, ...(name !== undefined ? { name } : {}), output: optionalJsonOf(output), ok, ...base };
}

function unknownRecord(raw: unknown, base: RecordBase): Unlocated {
  return { kind: "unknown", raw, ...base };
}

/** When the file was last written, in milliseconds; `undefined` when it cannot be told. */
async function writtenAtOf(path: string): Promise<number | undefined> {
  try {
    const { mtimeMs } = await stat(path);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
    return Math.floor(mtimeMs);
  } catch {
    return undefined;
  }
}

function toTimestamp(value: number | undefined): Timestamp | undefined {
  return value === undefined ? undefined : timestamp(value);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
