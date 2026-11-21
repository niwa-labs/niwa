/**
 * The reading side of a Codex installation.
 *
 * It works from the files: the sessions are listed and read whether or not Codex is running, and
 * nothing is copied into niwa's journal. The format is in `format.ts`, the layout in `paths.ts`.
 *
 * **What a rollout holds.** One file per session, JSONL, one record per line. Two layers live in
 * it. The conversation layer (`response_item`) is what the model was actually given and produced:
 * messages, reasoning, tool calls, tool results. The event layer (`event_msg`) is how Codex shows
 * it, and it repeats most of the conversation under its own ids. This side reads the conversation
 * layer as the record of what happened, and reads the event layer for what only it knows: that a
 * subagent was spawned, that the context was compacted. What the event layer repeats is not read
 * twice.
 *
 * **The locator.** `codex:v1:<prefixBytes>:<prefixHash>:<line>:<byte>:<after>`: the revision of
 * the file the position was taken from, the place in it, and how many of that line's records were
 * already delivered. The revision is a hash of the bytes that are final by the end of that line,
 * so a file that grows keeps the locators it already gave out, and a file that was rewritten does
 * not answer to them. The position is counted in the *decoded* JSONL, which is the same space for
 * a plain rollout and for a compressed one.
 *
 * **The half-written tail.** The last line of a rollout that is being written has no newline yet.
 * It is marked `incomplete`, and the reader does not move past it.
 *
 * **The compressed rollout.** Codex compresses cold rollouts itself. The same JSONL is decoded as a
 * stream, so a large archive never sits in memory.
 *
 * Ported from Strata's Codex source adapter, without its usage accounting and without its engine.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";

import { z } from "zod";

import { jsonOf, optionalJsonOf, timestamp } from "@niwa-labs/core";
import type { Timestamp } from "@niwa-labs/core";
import type {
  HarnessId,
  Coverage,
  Locator,
  NativeSessionId,
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
  TitleCache,
  failedCoverage,
  titleFromText,
  unavailableCoverage,
} from "@niwa-labs/harness";

import {
  argumentsOf,
  compactionSummary,
  instantOf,
  outputOf,
  outcomeOf,
  parseNativeRecord,
  payloadOf,
  textsOf,
} from "./format.ts";
import type { NativeRecord } from "./format.ts";
import { baseOfArtifact, isCompressedName, nativeIdOfFileName } from "./paths.ts";
import { codexChecklist, codexToolShape } from "./tools.ts";

export interface CodexReadingOptions {
  /** The id of the installation this side serves. */
  readonly harness: HarnessId;
  /** The home of the installation: the directory that holds `sessions`. */
  readonly home: string;
  /** The directory inside the home that holds the sessions. */
  readonly sessionsDir?: string;
}

/** A record before the reading side has put its locator in. */
type Unlocated = SessionRecord extends infer R ? (R extends unknown ? Omit<R, "locator"> : never) : never;

interface RecordBase {
  readonly at?: number;
  readonly incomplete: boolean;
}

/** A rollout file: where it is, which session it holds, and whether it is compressed. */
interface Rollout {
  readonly path: string;
  readonly native: NativeSessionId;
  readonly compressed: boolean;
}

/** One line of a rollout, with where it sits in the file. */
interface RawLine {
  /** The number of the line in the file, from one. */
  readonly line: number;
  /** The offset of the start of the line, in bytes from the start of the decoded JSONL. */
  readonly byte: number;
  /** The bytes of the line, without the newline. */
  readonly bytes: Uint8Array;
  /** `false` when the line has no newline after it: the tail of the file, maybe half written. */
  readonly complete: boolean;
  /**
   * The first bytes of the file, up to `PREFIX_BYTES`.
   *
   * They are final: a line that is whole will not change, so the hash of the bytes up to the end
   * of that line does not change either when the file grows.
   */
  readonly head: Buffer;
}

/** A locator read back. */
interface Position {
  readonly prefixBytes: number;
  readonly prefixHash: string;
  readonly line: number;
  readonly byte: number;
  readonly after: number;
}

/** How many bytes of the head of a rollout the revision hashes. */
const PREFIX_BYTES = 4096;

/**
 * The locator of one record: the revision it was taken from, and where it sits in it.
 *
 * The revision covers the bytes up to the end of the line the record is on, so it is the same for
 * every record of that line and does not change when the file grows after it.
 *
 * A line that is not whole has `after = 0`: it may still change, so a resume reads it again
 * instead of moving past it.
 */
function makeLocator(line: RawLine, after: number): Locator {
  // A line that is not whole may still change, so the revision covers only the bytes before it:
  // the hash then holds when the line is completed, and the tail is read again.
  const final = line.complete ? line.byte + line.bytes.length + 1 : line.byte;
  const prefix = line.head.subarray(0, Math.min(final, line.head.length));
  const hash = createHash("sha256").update(prefix).digest("hex");
  const delivered = line.complete ? after : 0;
  return LocatorSchema.parse(
    `codex:v1:${prefix.length}:${hash}:${line.line}:${line.byte}:${delivered}`,
  );
}

/** A locator that is not this side's own is refused by name. */
function decodeLocator(locator: Locator): Position {
  const parts = locator.split(":");
  const [tag, version, prefixBytes, prefixHash, line, byte, after] = parts;
  const prefixLength = Number(prefixBytes);
  const lineNumber = Number(line);
  const byteOffset = Number(byte);
  const delivered = Number(after);
  if (
    parts.length !== 7 ||
    tag !== "codex" ||
    version !== "v1" ||
    prefixHash === undefined ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 0 ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(delivered) ||
    delivered < 0
  ) {
    throw new Error(`codex: locator ${locator} is not of this side's form`);
  }
  return {
    prefixBytes: prefixLength,
    prefixHash: prefixHash!,
    line: lineNumber,
    byte: byteOffset,
    after: delivered,
  };
}

/**
 * The lines of a rollout, one at a time, from the start.
 *
 * A plain file is read as a stream, so a large session never sits in memory. A compressed one is
 * decoded as a stream, because zstd is sequential; the offsets are in the decoded space either
 * way. The scan always starts at the beginning, because the meaning of a line depends on the ones
 * before it (the model of the turn, the name of a tool, the replayed history of a parent); a
 * resume skips what it already delivered but still reads it.
 *
 * Lines are cut on raw bytes, so the offsets and the revision hash are the bytes of the file even
 * when a line is not valid UTF-8.
 */
async function* scanLines(rollout: Rollout): AsyncGenerator<RawLine> {
  const { source, close } = openRollout(rollout);
  try {
    yield* linesOf(source);
  } finally {
    // A reader that stops early (the listing reads the head only) must not leave the file open.
    close();
  }
}

/**
 * The decoded bytes of a rollout, and the way to close it. A piped stream does not close its
 * source when it is itself closed, so both are closed by hand.
 */
function openRollout(rollout: Rollout): { source: NodeJS.ReadableStream; close: () => void } {
  const file = createReadStream(rollout.path);
  if (!rollout.compressed) return { source: file, close: () => file.destroy() };
  const decompress = createZstdDecompress();
  file.on("error", (error) => decompress.destroy(error));
  const source = file.pipe(decompress);
  return {
    source,
    close: () => {
      decompress.destroy();
      file.destroy();
    },
  };
}

/** The lines of a decoded rollout, cut on raw bytes. */
async function* linesOf(source: NodeJS.ReadableStream): AsyncGenerator<RawLine> {
  let head: Buffer = Buffer.alloc(0);
  let carry: Buffer = Buffer.alloc(0);
  let lineStart = 0;
  let lineNo = 1;

  for await (const chunk of source) {
    const bytes = Buffer.from(chunk as Uint8Array);
    if (head.length < PREFIX_BYTES) {
      head = Buffer.concat([head, bytes]).subarray(0, PREFIX_BYTES);
    }
    const data = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
    let from = 0;
    for (;;) {
      const lf = data.indexOf(0x0a, from);
      if (lf < 0) break;
      const line = data.subarray(from, lf);
      yield { line: lineNo, byte: lineStart, bytes: line, complete: true, head };
      lineNo += 1;
      lineStart += line.length + 1;
      from = lf + 1;
    }
    carry = data.subarray(from);
  }
  if (carry.length > 0) {
    // The tail of a file that is being written: it has no newline yet, so it may be half written.
    yield { line: lineNo, byte: lineStart, bytes: carry, complete: false, head };
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

/**
 * The state of the parse of one rollout, shared by all its lines.
 *
 * These are the things the native format holds for the file as a whole: the session it belongs
 * to, the model of the current turn, the names of the tools by the id of their call, and where the
 * own history of a forked session begins.
 */
interface ParseState {
  /** The working directory of the session. */
  cwd: string | null;
  /** The moment the session started. */
  startedAt: Timestamp | undefined;
  /** The model of the current turn. */
  model: string | undefined;
  /** The moment the file was last written. */
  updatedAt: Timestamp | undefined;
  /** The names of the tools, by the id of their call: a result does not name its tool. */
  readonly toolNames: Map<string, string>;
  /**
   * The ordinal from which the history is this session's own.
   *
   * Codex writes a forked session's file with the history of the parent replayed into it, and it
   * writes the parent's metadata there too. That history happened in another session, so it is not
   * this session's own. The own history begins at the first `turn_context` of this session, which
   * is where the replay ends. Codex says the same thing in `subagent_history_start_ordinal`, and
   * when it says it, that ordinal is the boundary.
   */
  ownHistoryFrom: number | undefined;
  /** The ordinal of the first `turn_context` of this session, once it is seen. */
  ownTurnAt: number | undefined;
  /** `true` while the replayed history of a parent is being read. */
  awaitingOwnHistory: boolean;
  /** Whether the session metadata was seen. */
  metaSeen: boolean;
}

/** A fresh parse state. */
function newParseState(): ParseState {
  return {
    cwd: null,
    startedAt: undefined,
    model: undefined,
    updatedAt: undefined,
    toolNames: new Map(),
    ownHistoryFrom: undefined,
    ownTurnAt: undefined,
    awaitingOwnHistory: false,
    metaSeen: false,
  };
}

/**
 * The index of the threads Codex keeps beside its sessions: one JSON line per name it gave a
 * thread, `{ "id", "thread_name", "updated_at" }`. A later line for the same id renames it.
 */
const SESSION_INDEX = "session_index.jsonl";

const SessionIndexLineSchema = z.object({ id: z.string().min(1), thread_name: z.string() });

/**
 * The instructions Codex puts before the first message of a person: they are what the files of
 * the project say, not what the person said, so a title is never made of them.
 */
const INSTRUCTIONS_PREAMBLE = /^#\s*AGENTS\.md instructions\b/;

/** How many lines of the head of a rollout a title is looked for in. */
const TITLE_LINES = 30;

/** What a line holds when it is a message of a user, or tells where the history of the session begins. */
const TITLE_MARKS = [
  Buffer.from('"role":"user"'),
  Buffer.from('"type":"session_meta"'),
  Buffer.from('"type":"turn_context"'),
];

/**
 * Can the line change the title? Only a message of a user gives one, and the lines that say where
 * a forked session's own history begins decide whether that message is its own. The others are
 * not decoded: the head of a rollout holds large lines (instructions, tool lists) that say
 * nothing about it.
 */
function mattersForTitle(bytes: Uint8Array): boolean {
  const line = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return TITLE_MARKS.some((mark) => line.includes(mark));
}

/** The walk's signal that the position of a locator is not in the file. */
const STALE = Symbol("stale");

export class CodexReading implements SessionReading {
  readonly #harness: HarnessId;
  readonly #home: string;
  readonly #sessionsDir: string;
  /** The titles made from first messages: kept as long as this reading side lives. */
  readonly #titles = new TitleCache();

  constructor(options: CodexReadingOptions) {
    this.#harness = options.harness;
    this.#home = options.home;
    this.#sessionsDir = options.sessionsDir ?? "sessions";
  }

  /** The directory the rollouts live in. */
  get sessionsRoot(): string {
    return join(this.#home, this.#sessionsDir);
  }

  /** A line that does not parse is returned as text, an unfamiliar shape as it is. */
  readonly rawSchema: z.ZodType<unknown> = z.json();

  /** The sessions of the installation, oldest first. */
  async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
    const names = await this.#threadNames();
    const wanted = filter?.natives === undefined ? undefined : new Set(filter.natives);
    for (const rollout of await this.#discover()) {
      // A session that is not wanted is left out before anything of it is read.
      if (wanted !== undefined && !wanted.has(rollout.native)) continue;
      const info = await this.#infoOf(rollout, names);
      if (filter?.cwd !== undefined && info.cwd !== filter.cwd) continue;
      if (filter?.since !== undefined) {
        const seen = info.updatedAt ?? info.startedAt;
        if (seen === undefined || seen < filter.since) continue;
      }
      yield info;
    }
  }

  /**
   * The records of a session, after `from` when given.
   *
   * A locator of a revision the file no longer has does not name a record any more, so the read
   * then starts from the beginning and delivers everything.
   */
  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    const rollout = await this.#find(id);
    if (rollout === null) return;
    const resume = await this.#resumeOf(rollout, from);
    const aligned = yield* this.#deliver(rollout, resume);
    if (!aligned) yield* this.#deliver(rollout, undefined);
  }

  /**
   * Walks the rollout and yields the records after `resume`, each with its locator. It returns
   * `false` when the file holds no line where the locator says one starts: the position is stale,
   * and nothing was yielded.
   */
  async *#deliver(
    rollout: Rollout,
    resume: Position | undefined,
  ): AsyncGenerator<SessionRecord, boolean> {
    for await (const entry of this.#walk(rollout, resume)) {
      if (entry === STALE) return false;
      yield { ...entry.record, locator: makeLocator(entry.line, entry.index + 1) } as SessionRecord;
    }
    return true;
  }

  /**
   * Every line is parsed, because the state it leaves is needed by the lines after it, but only the
   * records after `resume` come out. The tail line that was marked incomplete comes out again.
   */
  async *#walk(
    rollout: Rollout,
    resume: Position | undefined,
  ): AsyncGenerator<{ line: RawLine; index: number; record: Unlocated } | typeof STALE> {
    const state = newParseState();
    let aligned = resume === undefined;
    for await (const line of scanLines(rollout)) {
      const records = line.bytes.length === 0 ? [] : this.#recordsOf(line, state);
      if (resume === undefined) {
        for (const [index, record] of records.entries()) yield { line, index, record };
        continue;
      }
      if (line.byte < resume.byte) continue;
      if (!aligned) {
        if (line.byte !== resume.byte || line.line !== resume.line) {
          yield STALE;
          return;
        }
        aligned = true;
      }
      for (const [index, record] of records.entries()) {
        if (line.line === resume.line && index + 1 <= resume.after) continue;
        yield { line, index, record };
      }
    }
    if (!aligned) yield STALE;
  }

  /** Whether any record follows `resume`; `STALE` when the position is not in the file. */
  async #firstAfter(rollout: Rollout, resume: Position | undefined): Promise<boolean | typeof STALE> {
    for await (const entry of this.#walk(rollout, resume)) return entry === STALE ? STALE : true;
    return false;
  }

  /** The position of a locator, when the file still holds it; `undefined` for no locator or a stale one. */
  async #resumeOf(rollout: Rollout, from: Locator | undefined): Promise<Position | undefined> {
    if (from === undefined) return undefined;
    const position = decodeLocator(from);
    return (await this.#positionHolds(rollout, position)) ? position : undefined;
  }

  /** The harness's own record, whole, at a locator. */
  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    const rollout = await this.#find(id);
    if (rollout === null) throw new Error(`codex: session ${id.native} is not on disk`);
    const position = decodeLocator(locator);
    if (!(await this.#positionHolds(rollout, position))) {
      throw new Error(`codex: locator ${locator} does not belong to the current file of ${id.native}`);
    }
    for await (const line of scanLines(rollout)) {
      if (line.byte > position.byte) break;
      if (line.byte === position.byte && line.line === position.line) return parseLine(line.bytes);
    }
    throw new Error(`codex: no record at ${locator} in session ${id.native}`);
  }

  /**
   * `unavailable` — not on disk; `failed` — the scan broke; `empty` — nothing in the range;
   * `not-scanned` — there are records niwa has not read: it copies nothing, so a range is only
   * read when a caller asks `read`.
   */
  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    const rollout = await this.#find(id);
    if (rollout === null) return unavailableCoverage(`codex: session ${id.native} is not on disk`);
    try {
      const resume = await this.#resumeOf(rollout, from);
      let outcome = await this.#firstAfter(rollout, resume);
      // A stale position names nothing, so the whole session counts.
      if (outcome === STALE) outcome = await this.#firstAfter(rollout, undefined);
      return outcome === false ? EMPTY : NOT_SCANNED;
    } catch (error) {
      return failedCoverage(`codex: session ${id.native} could not be scanned: ${reasonOf(error)}`);
    }
  }

  /**
   * The rollouts of the installation.
   *
   * Both copies of a session count as one session: when a plain rollout and a compressed one lie
   * side by side, they are the same session, and the plain one is the one that is read. Codex
   * leaves the compressed copy behind when it compresses a rollout.
   *
   * A path that is named like a rollout is a rollout even when it cannot be read: the session is
   * still there, and reading it says so instead of pretending the session is gone.
   */
  async #discover(): Promise<Rollout[]> {
    const found = new Map<string, Rollout>();
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        const name = nativeIdOfFileName(entry.name);
        if (name !== null) {
          const native = NativeSessionIdSchema.parse(name);
          const compressed = isCompressedName(entry.name);
          const key = baseOfArtifact(path);
          const existing = found.get(key);
          if (existing === undefined || (existing.compressed && !compressed)) {
            found.set(key, { path, native, compressed });
          }
          continue;
        }
        if (entry.isDirectory()) await walk(path);
      }
    };
    await walk(this.sessionsRoot);
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Does the position still mean what it meant?
   *
   * A rollout is only appended to, so the bytes that were final stay final and their hash holds.
   * A file that was rewritten fails the hash, and a position that is not at the start of a line
   * does not name a record at all.
   */
  async #positionHolds(rollout: Rollout, position: Position): Promise<boolean> {
    let head: Buffer;
    try {
      head = await this.#headOf(rollout, position.prefixBytes);
    } catch {
      return false;
    }
    if (head.length !== position.prefixBytes) return false;
    if (createHash("sha256").update(head).digest("hex") !== position.prefixHash) return false;
    return true;
  }

  /** The first `count` bytes of the decoded rollout. */
  async #headOf(rollout: Rollout, count: number): Promise<Buffer> {
    if (!rollout.compressed) {
      const handle = await open(rollout.path, "r");
      try {
        const buffer = Buffer.alloc(count);
        const { bytesRead } = await handle.read(buffer, 0, count, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    const { source, close } = openRollout(rollout);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk as Uint8Array);
        chunks.push(buffer);
        total += buffer.length;
        if (total >= count) break;
      }
    } finally {
      close();
    }
    return Buffer.concat(chunks).subarray(0, count);
  }

  /**
   * The id is the one in the file name, which is the thread id that control starts and resumes
   * sessions by. The times are the file's: a session was last updated when its file was. The
   * title is the name Codex gave the thread, else the first message of the person.
   */
  async #infoOf(rollout: Rollout, names: ReadonlyMap<string, string>): Promise<SessionInfo> {
    const name = names.get(rollout.native);
    const info = await stat(rollout.path).catch(() => undefined);
    // The name Codex gave the thread needs no look at the file. Without one, the title kept for
    // the file as it is now is used, and only a file that is new or has grown is looked into.
    const key = info === undefined ? undefined : { size: info.size, mtimeMs: info.mtimeMs };
    const kept = name !== undefined || key === undefined ? undefined : this.#titles.get(rollout.path, key);
    const { state: header, firstMessage, read } = await this.#headerOf(
      rollout,
      name === undefined && kept === undefined,
    );
    // A head that could not be read says nothing, and is not kept as "no title".
    if (name === undefined && kept === undefined && key !== undefined && read) {
      this.#titles.set(rollout.path, key, firstMessage);
    }
    const updatedAt = info === undefined ? header.updatedAt : timestamp(Math.floor(info.mtimeMs));
    const title = name ?? kept?.title ?? firstMessage;
    return {
      id: { harness: this.#harness, native: rollout.native },
      ...(title === undefined ? {} : { title }),
      ...(header.cwd === null ? {} : { cwd: header.cwd }),
      ...(header.startedAt === undefined ? {} : { startedAt: header.startedAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
  }

  /**
   * The names Codex gave its threads, by thread id. A missing or unreadable index names none; a
   * line that is not a name is passed over.
   */
  async #threadNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let text: string;
    try {
      text = await readFile(join(this.#home, SESSION_INDEX), "utf8");
    } catch {
      return names;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = SessionIndexLineSchema.safeParse(value);
      if (!parsed.success) continue;
      const name = parsed.data.thread_name.trim();
      if (name.length > 0) names.set(parsed.data.id, name);
      else names.delete(parsed.data.id);
    }
    return names;
  }

  /**
   * The head of a rollout: what it says about the session as a whole.
   *
   * The metadata is in the first lines, so only they are read. With `wantTitle`, the same pass
   * goes on to the first message of the person, within the first lines only: a forked session
   * replays the history of its parent first, and the listing does not walk a history for a title.
   */
  async #headerOf(
    rollout: Rollout,
    wantTitle = false,
  ): Promise<{ state: ParseState; firstMessage: string | undefined; read: boolean }> {
    const state = newParseState();
    // The records of the head are made with a state of their own, so the metadata stays as the
    // first lines left it.
    const recordState = newParseState();
    let firstMessage: string | undefined;
    let lines = 0;
    try {
      for await (const line of scanLines(rollout)) {
        lines += 1;
        if (line.complete === false) break;
        if (!state.metaSeen) {
          const record = parseNativeRecord(parseLine(line.bytes));
          if (record !== null) this.#applyMeta(record, state);
        }
        if (wantTitle && lines <= TITLE_LINES && mattersForTitle(line.bytes)) {
          for (const record of this.#recordsOf(line, recordState)) {
            if (record.kind !== "user" || INSTRUCTIONS_PREAMBLE.test(record.text)) continue;
            firstMessage = titleFromText(record.text);
            if (firstMessage !== undefined) break;
          }
        }
        const titleDone = !wantTitle || firstMessage !== undefined || lines >= TITLE_LINES;
        if (state.metaSeen && titleDone) break;
      }
    } catch {
      // A head that cannot be read is a head that says nothing; the session is still listed.
      return { state, firstMessage, read: false };
    }
    return { state, firstMessage, read: true };
  }

  /** Take what a record says about the session as a whole. */
  #applyMeta(record: NativeRecord, state: ParseState): void {
    const payload = payloadOf(record);
    const at = instantOf(record.timestamp);
    if (at !== undefined) state.updatedAt = at;

    if (record.type === "session_meta") {
      if (state.metaSeen) {
        // A second session metadata is the parent's, replayed into this file. The own history of
        // the session begins at its first turn.
        state.awaitingOwnHistory = true;
        state.ownTurnAt = undefined;
        return;
      }
      state.metaSeen = true;
      const cwd = payload["cwd"];
      if (typeof cwd === "string") state.cwd = cwd;
      const stamp = instantOf(payload["timestamp"]) ?? at;
      if (stamp !== undefined) state.startedAt = stamp;
      const start = payload["subagent_history_start_ordinal"];
      if (typeof start === "number") state.ownHistoryFrom = start;
      return;
    }

    if (record.type === "turn_context") {
      const model = payload["model"];
      if (typeof model === "string") state.model = model;
      const cwd = payload["cwd"];
      if (state.cwd === null && typeof cwd === "string") state.cwd = cwd;
      if (state.ownTurnAt === undefined) state.ownTurnAt = record.ordinal;
      if (state.awaitingOwnHistory && state.ownHistoryFrom === undefined) {
        // The own history of a forked session begins at its first turn.
        state.ownHistoryFrom = state.ownTurnAt;
      }
      state.awaitingOwnHistory = false;
    }
  }

  /** The rollout of a session, or `null` when the installation does not hold it. */
  async #find(id: SessionId): Promise<Rollout | null> {
    for (const rollout of await this.#discover()) {
      if (rollout.native === id.native) return rollout;
    }
    return null;
  }

  /**
   * The records of one native line. One line may give several: a message with a call in it gives
   * an assistant record and a tool-call record.
   */
  #recordsOf(line: RawLine, state: ParseState): Unlocated[] {
    const parsed = parseLine(line.bytes);
    const record = parseNativeRecord(parsed);
    const incomplete = !line.complete;
    const base: RecordBase = { incomplete };
    if (record === null) return [unknownRecord(parsed, base)];
    const payload = payloadOf(record);
    const at = instantOf(record.timestamp);
    const stamped: RecordBase = { ...(at === undefined ? {} : { at }), incomplete };

    this.#applyMeta(record, state);

    // The replayed history of a parent is not this session's own history. It is what lies between
    // the parent's metadata and the first turn of this session.
    if (state.awaitingOwnHistory && record.type !== "turn_context") return [];
    if (
      state.ownHistoryFrom !== undefined &&
      record.ordinal !== undefined &&
      record.ordinal < state.ownHistoryFrom
    ) {
      return [];
    }

    switch (record.type) {
      case "session_meta":
      case "turn_context":
        // They say what the session is, not what happened in it; the reading side holds that in
        // the session itself.
        return [];
      case "response_item":
        return this.#conversationRecords(payload, state, stamped, parsed);
      case "event_msg":
        return this.#eventRecords(payload, stamped);
      case "compacted":
        return [{ kind: "compaction", summary: compactionSummary(payload), ...stamped }];
      case "realtime_item":
        return this.#realtimeRecords(payload, state, stamped, parsed);
      default:
        // Anything else the format grows is kept whole, and never fails the read.
        return [unknownRecord(parsed, stamped)];
    }
  }

  /** The records of the conversation layer: what the model was given and produced. */
  #conversationRecords(
    payload: Record<string, unknown>,
    state: ParseState,
    base: RecordBase,
    raw: unknown,
  ): Unlocated[] {
    const kind = payload["type"];
    if (kind === "message") {
      const role = payload["role"];
      const text = textsOf(payload["content"]);
      if (role === "user") return [{ kind: "user", text, ...base }];
      if (role === "assistant") {
        return [
          {
            kind: "assistant",
            text,
            ...(state.model === undefined ? {} : { model: state.model }),
            ...base,
          },
        ];
      }
      // A message the owner did not send and the model did not say: the harness talking to
      // itself. It is neither the owner's word nor the model's answer, so it is kept whole.
      return [unknownRecord(raw, base)];
    }
    if (kind === "function_call" || kind === "custom_tool_call") {
      const callId = payload["call_id"];
      const name = payload["name"];
      if (typeof callId !== "string" || callId.length === 0) return [unknownRecord(raw, base)];
      if (typeof name === "string" && name.length > 0) state.toolNames.set(callId, name);
      const input = kind === "custom_tool_call" ? payload["input"] : argumentsOf(payload["arguments"]);
      const tool = typeof name === "string" && name.length > 0 ? name : "unknown";
      const checklist = codexChecklist(tool, input);
      return [
        {
          kind: "tool-call",
          callId,
          name: tool,
          ...codexToolShape(tool, input),
          ...(input === undefined ? {} : { input: jsonOf(input) }),
          ...base,
        },
        ...(checklist === undefined ? [] : [{ kind: "checklist" as const, callId, items: checklist.items, ...base }]),
      ];
    }
    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callId = payload["call_id"];
      if (typeof callId !== "string" || callId.length === 0) return [unknownRecord(raw, base)];
      const output = outputOf(payload["output"]);
      const outcome = outcomeOf(output, payload["status"]);
      const name = state.toolNames.get(callId);
      return [
        {
          kind: "tool-result",
          callId,
          ...(name === undefined ? {} : { name }),
          output: optionalJsonOf(output),
          ...(outcome === undefined ? {} : { ok: outcome.ok }),
          ...base,
        },
      ];
    }
    // A reasoning item is the model thinking: it is not a message and not a call. It is kept
    // whole, so that nothing of the session is lost.
    return [unknownRecord(raw, base)];
  }

  /**
   * The records of the event layer: what only it knows.
   *
   * The event layer repeats the conversation under its own ids. What it alone knows is that a
   * subagent was spawned.
   */
  #eventRecords(payload: Record<string, unknown>, base: RecordBase): Unlocated[] {
    switch (payload["type"]) {
      case "item_completed": {
        // A paginated rollout carries the item whole under `item`.
        const item = payload["item"];
        return typeof item === "object" && item !== null && !Array.isArray(item)
          ? this.#subAgentRecords(item as Record<string, unknown>, base)
          : [];
      }
      case "sub_agent_activity":
        // A legacy rollout writes the event itself, with the same fields.
        return this.#subAgentRecords(payload, base);
      default:
        // The rest of the event layer repeats the conversation layer, which was read already. The
        // compaction events are among them: `compacted` is written next to each one.
        return [];
    }
  }

  /** A spawned subagent is a nested record; its other activity is not. */
  #subAgentRecords(activity: Record<string, unknown>, base: RecordBase): Unlocated[] {
    const type = activity["type"];
    if (type !== "SubAgentActivity" && type !== "sub_agent_activity") return [];
    if (activity["kind"] !== "started") return [];
    const child = activity["agent_thread_id"];
    if (typeof child !== "string" || child.length === 0) return [];
    return [
      { kind: "nested", child: { harness: this.#harness, native: NativeSessionIdSchema.parse(child) }, ...base },
    ];
  }

  /**
   * The records of the voice mode: the transcript of the conversation.
   *
   * These segments carry the conversation itself, and the conversation layer does not repeat them,
   * so they are read as what they are.
   */
  #realtimeRecords(
    payload: Record<string, unknown>,
    state: ParseState,
    base: RecordBase,
    raw: unknown,
  ): Unlocated[] {
    if (payload["type"] !== "transcript_segment") return [];
    const role = payload["role"];
    const text = payload["text"];
    if (typeof text !== "string" || text.length === 0) return [];
    if (role === "user") return [{ kind: "user", text, ...base }];
    if (role === "assistant") {
      return [
        {
          kind: "assistant",
          text,
          ...(state.model === undefined ? {} : { model: state.model }),
          ...base,
        },
      ];
    }
    return [unknownRecord(raw, base)];
  }
}

function unknownRecord(raw: unknown, base: RecordBase): Unlocated {
  return { kind: "unknown", raw, ...base };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
