/**
 * The reading side of a MiniMax Code installation. It works
 * from the files and copies nothing. The format is in `format.ts`, the layout in `paths.ts`.
 *
 * A locator is `mcode:v1:<prefixBytes>:<prefixHash>:<offset>:<after>`: the head of the journal it
 * was taken from (a rewritten or truncated file is detected), the start of the line, and how many
 * of that line's records were already delivered. A half-written tail line has `after = 0`, so a
 * resume reads it again once it is whole.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { jsonOf, timestamp } from "@niwa-labs/core";
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
  firstMessageTitle,
  titleFromText,
  unavailableCoverage,
} from "@niwa-labs/harness";

import {
  ManifestSchema,
  RawRecordSchema,
  isWrappedNoise,
  millisOf,
  parseNativeRecord,
  readAgentContext,
  stripHarnessNoise,
  textOf,
} from "./format.ts";
import type { AgentContext, Manifest, McodeMessage, McodeRecord } from "./format.ts";
import {
  durableFirst,
  durableHasSession,
  durablePathOf,
  durableSessions,
  messageIdOf,
  readDurableSession,
  STOP,
} from "./durable.ts";
import type { DurableTurn } from "./durable.ts";
import { parseLedger } from "./ledger.ts";
import type { LedgerContent, LedgerLine, LedgerTurn } from "./ledger.ts";
import {
  dirNameHoldsId,
  encodeNativeId,
  isSessionDir,
  ledgerPathOf,
  logPathOf,
  manifestPathOf,
  nativeIdFromDirName,
  subdirsOf,
} from "./paths.ts";
import { runtimeStatePathOf, sessionTitles } from "./titles.ts";
import { mcodeChecklist, mcodeToolShape } from "./tools.ts";

export interface McodeReadingOptions {
  /** The id of the installation this side serves. */
  readonly harness: HarnessId;
  /** The directory that holds `v2/sessions`. */
  readonly home: string;
}

const CHUNK_SIZE = 65_536;
/** Bytes of the head of the journal the revision hashes. */
const PREFIX_BYTES = 4096;
/** Listing looks for the preamble only in lines that start inside this much of the head. */
const HEAD_BYTES = 65_536;

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
  /** `false` — no LF yet: the half-written tail of the journal. */
  readonly complete: boolean;
}

interface FoundSession {
  readonly dirName: string;
  readonly logPath: string;
  readonly manifestPath: string;
  readonly ledgerPath: string;
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
 * Does the position still mean what it meant? The journal is only appended to, so its head stays;
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

/** The tag of a locator of the journal. */
const JOURNAL_TAG = "mcode";

/**
 * The locator of a record of `line`. The revision hashes the head of the journal, but only the
 * bytes that are final by the end of this line: a journal that grows must not invalidate the
 * locators it already gave out, so the half-written tail never takes part in the hash.
 */
function makeLocator(head: Buffer, line: RawLine, after: number): Locator {
  const final = line.complete ? line.byte + line.bytes.length + 1 : line.byte;
  const prefix = head.subarray(0, Math.min(final, head.length));
  return LocatorSchema.parse(
    `${JOURNAL_TAG}:v1:${prefix.length}:${hashOf(prefix)}:${line.byte}:${line.complete ? after : 0}`,
  );
}

/** A locator that is not this side's own is refused by name. */
function decodeLocator(locator: Locator): Position {
  const parts = locator.split(":");
  const [tag, version, bytes, hash, offset, after] = parts;
  const numbers = [bytes, offset, after].map(Number);
  if (
    parts.length !== 6 ||
    tag !== JOURNAL_TAG ||
    version !== "v1" ||
    hash === undefined ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    throw new Error(`mcode: locator ${locator} is not of this side's form`);
  }
  return { prefixBytes: numbers[0]!, prefixHash: hash, offset: numbers[1]!, after: numbers[2]! };
}

/**
 * A locator of a record that came from the ledger of a session.
 *
 * The ledger is a file of its own, so its records are named by their own tag: a locator of the
 * journal of a session says nothing about the ledger of that session, and the other way about.
 */
const LEDGER_TAG = "mcode-ledger";

/** The locator of a record of the ledger of a session. */
function makeLedgerLocator(head: Buffer, line: LedgerLine, after: number): Locator {
  const final = line.complete ? line.byte + line.bytes.length + 1 : line.byte;
  const prefix = head.subarray(0, Math.min(final, head.length));
  return LocatorSchema.parse(
    `${LEDGER_TAG}:v1:${prefix.length}:${hashOf(prefix)}:${line.byte}:${line.complete ? after : 0}`,
  );
}

/** A locator of the ledger read back. */
function decodeLedgerLocator(locator: Locator): Position {
  const parts = locator.split(":");
  const [tag, version, bytes, hash, offset, after] = parts;
  const numbers = [bytes, offset, after].map(Number);
  if (
    parts.length !== 6 ||
    tag !== LEDGER_TAG ||
    version !== "v1" ||
    hash === undefined ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    throw new Error(`mcode: locator ${locator} is not of this side's form`);
  }
  return { prefixBytes: numbers[0]!, prefixHash: hash, offset: numbers[1]!, after: numbers[2]! };
}

/**
 * A locator of a record that came from the durable history. The database is only appended to, so
 * a record is named by what it is: `mcode-db:v1:<seq>:<ordinal>:<index>:<after>:<message id>` — the
 * entry that carried it (seq, ordinal), the place of the envelope in that entry, how many of the
 * envelope's records were delivered, and the `message_id` (percent-encoded, `-` for none). A read
 * resumes after the envelope with that message id; when the active view no longer holds it (a
 * history that was replaced), the read starts from the beginning.
 */
const DURABLE_TAG = "mcode-db";

function isDurableLocator(locator: Locator): boolean {
  return locator.startsWith(`${DURABLE_TAG}:`);
}

/** The place a locator was taken from. */
type LocatorForm = "journal" | "ledger" | "durable";

/** The place a locator was taken from; `undefined` when the locator is none of this side's. */
function formOf(locator: Locator): LocatorForm | undefined {
  switch (locator.slice(0, locator.indexOf(":"))) {
    case JOURNAL_TAG:
      return "journal";
    case LEDGER_TAG:
      return "ledger";
    case DURABLE_TAG:
      return "durable";
    default:
      return undefined;
  }
}

/**
 * The locator of a read, refused when it is none of this side's. One taken from another place than
 * the one the session is read from now (the history moved between the database, the journal and
 * the ledger) names no record here: such a read starts over, as it does for a rewritten file.
 */
function checkedLocator(from: Locator | undefined): void {
  if (from === undefined) return;
  switch (formOf(from)) {
    case "journal":
      decodeLocator(from);
      return;
    case "ledger":
      decodeLedgerLocator(from);
      return;
    case "durable":
      decodeDurableLocator(from);
      return;
    default:
      throw new Error(`mcode: locator ${from} is not of this side's form`);
  }
}

/** The position of a locator of the database, when that is what it is. */
function durableFrom(from: Locator | undefined): DurablePosition | undefined {
  return from !== undefined && formOf(from) === "durable" ? decodeDurableLocator(from) : undefined;
}

/** The position of a locator of the ledger, when that is what it is. */
function ledgerFrom(from: Locator | undefined): Position | undefined {
  return from !== undefined && formOf(from) === "ledger" ? decodeLedgerLocator(from) : undefined;
}

/** The position of a locator of the journal, when that is what it is. */
function journalFrom(from: Locator | undefined): Position | undefined {
  return from !== undefined && formOf(from) === "journal" ? decodeLocator(from) : undefined;
}

function makeDurableLocator(turn: DurableTurn, after: number): Locator {
  const id = turn.messageId === undefined ? "-" : encodeURIComponent(turn.messageId);
  return LocatorSchema.parse(`${DURABLE_TAG}:v1:${turn.seq}:${turn.ordinal}:${turn.index}:${after}:${id}`);
}

interface DurablePosition {
  readonly seq: number;
  readonly ordinal: number;
  readonly index: number;
  readonly after: number;
  readonly messageId: string | undefined;
}

function decodeDurableLocator(locator: Locator): DurablePosition {
  const parts = locator.split(":");
  const [tag, version, seq, ordinal, index, after, id] = parts;
  const numbers = [seq, ordinal, index, after].map(Number);
  if (
    parts.length !== 7 ||
    tag !== DURABLE_TAG ||
    version !== "v1" ||
    id === undefined ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 0)
  ) {
    throw new Error(`mcode: locator ${locator} is not of this side's form`);
  }
  return {
    seq: numbers[0]!,
    ordinal: numbers[1]!,
    index: numbers[2]!,
    after: numbers[3]!,
    messageId: id === "-" ? undefined : decodeURIComponent(id),
  };
}

/**
 * Where a read resumes: the turn of the position (the first one whose records are not all
 * delivered) and how many of its records were. A position the view no longer holds starts over.
 * With `exact`, the index is that of the turn the position names, or past the end when none is.
 */
function durableStart(
  turns: readonly DurableTurn[],
  position: DurablePosition | undefined,
  exact = false,
): { turn: number; after: number; stale: boolean } {
  if (position === undefined) return { turn: 0, after: 0, stale: false };
  const at = turns.findIndex((turn) =>
    position.messageId === undefined
      ? turn.messageId === undefined &&
        turn.seq === position.seq &&
        turn.ordinal === position.ordinal &&
        turn.index === position.index
      : turn.messageId === position.messageId,
  );
  if (at < 0) return exact ? { turn: turns.length, after: 0, stale: true } : { turn: 0, after: 0, stale: true };
  return { turn: at, after: position.after, stale: false };
}

/**
 * A session that was in the durable history only has its journal now (it was adopted): the locator
 * it was given names a message, and the journal holds the same envelope on a line of its own. The
 * read resumes after that line, so what was delivered is not delivered twice. A journal that does
 * not (yet) hold the message starts over, as a rewritten file does.
 */
async function resumeAfterMessage(
  handle: FileHandle,
  position: DurablePosition,
): Promise<{ readonly offset: number; readonly after: number } | undefined> {
  if (position.messageId === undefined) return undefined;
  for await (const line of scanLines(handle, 0)) {
    if (!line.complete) break;
    if (isBlank(line.bytes)) continue;
    if (messageIdOf(parseLine(line.bytes)) === position.messageId) {
      return { offset: line.byte, after: position.after };
    }
  }
  return undefined;
}

export class McodeReading implements SessionReading {
  readonly #harness: HarnessId;
  readonly #sessionsRoot: string;
  readonly #durablePath: string;
  readonly #runtimeStatePath: string;

  constructor(options: McodeReadingOptions) {
    this.#harness = options.harness;
    this.#sessionsRoot = join(options.home, "v2", "sessions");
    this.#durablePath = durablePathOf(options.home);
    this.#runtimeStatePath = runtimeStatePathOf(options.home);
  }

  /** A line that does not parse is returned as text, an unfamiliar shape as it is. */
  readonly rawSchema = z.union([RawRecordSchema, z.json()]);

  /** The sessions on disk, newest first. */
  async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
    const listed = new Set<string>();
    const titles = sessionTitles(this.#runtimeStatePath, filter?.natives);
    const wanted = filter?.natives === undefined ? undefined : new Set(filter.natives);
    for await (const found of this.#discover()) {
      const info = await this.#infoOf(found, titles, wanted);
      if (info === null) continue;
      listed.add(info.id.native);
      if (filter?.cwd !== undefined && info.cwd !== filter.cwd) continue;
      if (filter?.since !== undefined && (info.updatedAt === undefined || info.updatedAt < filter.since)) {
        continue;
      }
      yield info;
    }
    // Sessions the durable history holds and no session directory names: all that is known of
    // them is the id and what they say, so a filter on the directory or the time leaves them out.
    if (filter?.cwd !== undefined || filter?.since !== undefined) return;
    for (const native of durableSessions(this.#durablePath)) {
      if (listed.has(native) || !NativeSessionIdSchema.safeParse(native).success) continue;
      if (wanted !== undefined && !wanted.has(native)) continue;
      const id: SessionId = { harness: this.#harness, native: NativeSessionIdSchema.parse(native) };
      const title = titles.get(native) ?? this.#durableTitle(native) ?? undefined;
      yield { id, ...(title !== undefined ? { title } : {}) };
    }
  }

  /**
   * Records of a session, after `from` when given. A locator whose file was rewritten no longer
   * names a record, so the read then starts from the beginning and delivers everything.
   *
   * A session that kept no journal of its own is read from its ledger instead: one source per
   * session, never both.
   */
  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    checkedLocator(from);
    yield* this.#readOf(id, await this.#find(id), from);
  }

  /** The records of a session whose directory is already found, or that has none. */
  async *#readOf(id: SessionId, found: FoundSession | null, from?: Locator): AsyncIterable<SessionRecord> {
    if (found === null) {
      const turns = this.#inDurable(id.native) ? this.#durableTurns(id.native) : null;
      if (turns !== null) yield* this.#readDurable(turns, from);
      return;
    }
    let source = await this.#sourceOf(found);
    if (source === "durable") {
      const turns = this.#durableTurns(id.native);
      if (turns !== null) {
        yield* this.#readDurable(turns, from);
        return;
      }
      // The database could not be read: the session is read as it was before the database.
      source = "ledger";
    }
    if (source === "ledger") {
      yield* this.#readLedger(found, from);
      return;
    }
    const position = journalFrom(from);
    const durable = durableFrom(from);
    const handle = await open(found.logPath, "r");
    try {
      const head = await prefixOf(handle, PREFIX_BYTES);
      const resume =
        durable !== undefined
          ? await resumeAfterMessage(handle, durable)
          : position !== undefined && (await positionHolds(handle, position))
            ? position
            : undefined;
      // A locator of another source, or one the file no longer holds, starts the read over.
      let restarted = from !== undefined && resume === undefined;
      for await (const line of scanLines(handle, resume?.offset ?? 0)) {
        if (isBlank(line.bytes)) continue;
        const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
        for (const [index, record] of this.#recordsOf(line).entries()) {
          if (index < skip) continue;
          yield { ...record, ...(restarted ? { reanchored: true } : {}), locator: makeLocator(head, line, index + 1) } as SessionRecord;
          restarted = false;
        }
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Where the records of a session come from: its journal, or its ledger.
   *
   * A session keeps its history in its journal. Some sessions kept none: they have no journal at
   * all, or the one they have holds nothing. Their history is in the ledger of the session
   * directory. One source per session: a journal with records in it is never read together with
   * the ledger.
   *
   * A journal that cannot be read at all is not a journal that is missing: it stays the source,
   * and the scan fails rather than the ledger taking its place.
   */
  async #sourceOf(found: FoundSession): Promise<"journal" | "durable" | "ledger"> {
    let info;
    try {
      info = await stat(found.logPath);
    } catch (error) {
      if (isMissing(error)) return await this.#emptyJournalSource(found);
      throw error;
    }
    if (!info.isFile()) return "journal";
    return info.size > 0 ? "journal" : await this.#emptyJournalSource(found);
  }

  /**
   * A session with no journal content: its history is in the durable history when the database
   * holds entries of it (a session not yet adopted keeps its journal empty), else in its ledger.
   */
  async #emptyJournalSource(found: FoundSession): Promise<"durable" | "ledger"> {
    // The regular harness has no database: nothing but the ledger is asked, not even the manifest.
    if (!existsSync(this.#durablePath)) return "ledger";
    const native = await this.#nativeOf(found);
    return native !== null && this.#inDurable(native) ? "durable" : "ledger";
  }

  /** The id a session directory stands for: the manifest's, else the directory name's. */
  async #nativeOf(found: FoundSession): Promise<string | null> {
    const manifest = await this.#manifestOf(found);
    const native = manifest?.sessionId ?? nativeIdFromDirName(found.dirName);
    return native === undefined || native === null || native.length === 0 ? null : native;
  }

  #inDurable(native: string): boolean {
    return durableHasSession(this.#durablePath, native) === true;
  }

  /** The active view of a session in the durable history. */
  #durableTurns(native: string): DurableTurn[] | null {
    return readDurableSession(this.#durablePath, native);
  }

  /** The records of a session that kept its history in the durable database. */
  async *#readDurable(turns: readonly DurableTurn[], from?: Locator): AsyncIterable<SessionRecord> {
    const position = durableFrom(from);
    const start = durableStart(turns, position);
    // A locator of another source, or one the view no longer holds, starts the read over.
    let restarted = from !== undefined && (position === undefined || start.stale);
    for (const [at, turn] of turns.entries()) {
      if (at < start.turn) continue;
      for (const [index, record] of this.#durableRecordsOf(turn).entries()) {
        if (at === start.turn && index < start.after) continue;
        yield { ...record, ...(restarted ? { reanchored: true } : {}), locator: makeDurableLocator(turn, index + 1) } as SessionRecord;
        restarted = false;
      }
    }
  }

  #durableRecordsOf(turn: DurableTurn): Unlocated[] {
    return recordsOfEnvelope(turn.record, turn.raw, { incomplete: false }, this.#harness);
  }

  /** The envelope at a locator of the durable history. */
  #rawDurable(turns: readonly DurableTurn[], native: string, locator: Locator): unknown {
    const position = decodeDurableLocator(locator);
    const at = durableStart(turns, position, true).turn;
    const turn = turns[at];
    if (turn === undefined || at >= turns.length) {
      throw new Error(`mcode: no record at ${locator} in session ${native}`);
    }
    return turn.raw;
  }

  /** The coverage of a session that kept its history in the durable database. */
  #durableCoverage(turns: readonly DurableTurn[], from?: Locator): Coverage {
    const start = durableStart(turns, durableFrom(from));
    for (const [at, turn] of turns.entries()) {
      if (at < start.turn) continue;
      const count = this.#durableRecordsOf(turn).length;
      if (count > (at === start.turn ? start.after : 0)) return NOT_SCANNED;
    }
    return EMPTY;
  }

  /** The records of a session that kept its history in its ledger. */
  async *#readLedger(found: FoundSession, from?: Locator): AsyncIterable<SessionRecord> {
    const content = await this.#ledgerOf(found);
    if (content === null) return;
    const position = ledgerFrom(from);
    // A locator of another source, or one the ledger no longer holds, starts the read over.
    let restarted = from !== undefined && (position === undefined || !ledgerPositionHolds(content, position));
    for (const { record, line, at } of ledgerPending(content, this.#harness, position)) {
      yield { ...record, ...(restarted ? { reanchored: true } : {}), locator: makeLedgerLocator(content.head, line, at + 1) } as SessionRecord;
      restarted = false;
    }
  }

  /** The ledger of a session: `null` when there is no ledger to read. */
  async #ledgerOf(found: FoundSession): Promise<LedgerContent | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(found.ledgerPath);
    } catch (error) {
      // Only a ledger that is not there is "no ledger"; one that exists and cannot be read fails.
      if (isMissing(error)) return null;
      throw error;
    }
    return parseLedger(bytes);
  }

  /** The harness's own record, whole, at a locator of the current file. */
  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    const found = await this.#find(id);
    if (found === null) {
      const turns = this.#inDurable(id.native) ? this.#durableTurns(id.native) : null;
      if (turns !== null) return this.#rawDurable(turns, id.native, locator);
      throw new Error(`mcode: session ${id.native} is not on disk`);
    }
    let source = await this.#sourceOf(found);
    if (source === "durable") {
      const turns = this.#durableTurns(id.native);
      if (turns !== null) return this.#rawDurable(turns, id.native, locator);
      source = "ledger";
    }
    if (source === "ledger") {
      return this.#rawLedger(found, locator);
    }
    if (isDurableLocator(locator)) return this.#rawByMessage(found, id, locator);
    const position = decodeLocator(locator);
    const handle = await open(found.logPath, "r");
    try {
      if (!(await positionHolds(handle, position))) {
        throw new Error(`mcode: locator ${locator} does not belong to the current file of ${id.native}`);
      }
      for await (const line of scanLines(handle, position.offset)) return parseLine(line.bytes);
    } finally {
      await handle.close();
    }
    throw new Error(`mcode: no record at ${locator} in session ${id.native}`);
  }

  /** The envelope a locator of the durable history names, in the journal the session has now. */
  async #rawByMessage(found: FoundSession, id: SessionId, locator: Locator): Promise<unknown> {
    const messageId = decodeDurableLocator(locator).messageId;
    const handle = await open(found.logPath, "r");
    try {
      for await (const line of scanLines(handle, 0)) {
        if (!line.complete) break;
        const parsed = isBlank(line.bytes) ? undefined : parseLine(line.bytes);
        if (messageId !== undefined && messageIdOf(parsed) === messageId) return parsed;
      }
    } finally {
      await handle.close();
    }
    throw new Error(`mcode: no record at ${locator} in session ${id.native}`);
  }

  /** The record of the ledger of a session, whole, at a locator of the ledger. */
  async #rawLedger(found: FoundSession, locator: Locator): Promise<unknown> {
    const position = decodeLedgerLocator(locator);
    const content = await this.#ledgerOf(found);
    if (content === null) throw new Error(`mcode: session ${found.dirName} has no ledger`);
    if (position.offset >= content.size) {
      throw new Error(`mcode: locator ${locator} does not belong to the current ledger of ${found.dirName}`);
    }
    const prefix = content.head.subarray(0, Math.min(position.prefixBytes, content.head.length));
    if (prefix.length !== position.prefixBytes || hashOf(prefix) !== position.prefixHash) {
      throw new Error(`mcode: locator ${locator} does not belong to the current ledger of ${found.dirName}`);
    }
    for (const turn of content.turns) {
      if (turn.line.byte !== position.offset) continue;
      return turn.raw;
    }
    throw new Error(`mcode: no record at ${locator} in the ledger of ${found.dirName}`);
  }

  /**
   * `unavailable` — not on disk; `failed` — the scan broke; `empty` — nothing in the range;
   * `not-scanned` — there are records niwa has not read: it copies nothing, so a range is only
   * read when a caller asks `read`.
   */
  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    checkedLocator(from);
    try {
      return await this.#coverageOf(id, from);
    } catch (error) {
      return failedCoverage(`mcode: session ${id.native} could not be scanned: ${reasonOf(error)}`);
    }
  }

  async #coverageOf(id: SessionId, from?: Locator): Promise<Coverage> {
    const found = await this.#find(id);
    if (found === null) {
      const held = this.#durableHolds(id.native);
      if (held === null) return failedCoverage(`mcode: the durable history of session ${id.native} could not be read`);
      const turns = held ? this.#durableTurns(id.native) : null;
      if (turns !== null) return this.#durableCoverage(turns, from);
      if (held) return failedCoverage(`mcode: the durable history of session ${id.native} could not be read`);
      return unavailableCoverage(`mcode: session ${id.native} is not on disk`);
    }
    let source = await this.#sourceOf(found);
    let durableFailed = false;
    if (source === "durable") {
      const turns = this.#durableTurns(id.native);
      if (turns !== null) return this.#durableCoverage(turns, from);
      durableFailed = true;
      source = "ledger";
    }
    if (source === "ledger") return this.#ledgerCoverage(found, from, durableFailed);
    const position = journalFrom(from);
    const durable = durableFrom(from);
    const handle = await open(found.logPath, "r");
    try {
      const resume =
        durable !== undefined
          ? await resumeAfterMessage(handle, durable)
          : position !== undefined && (await positionHolds(handle, position))
            ? position
            : undefined;
      for await (const line of scanLines(handle, resume?.offset ?? 0)) {
        if (isBlank(line.bytes)) continue;
        const skip = resume !== undefined && line.byte === resume.offset ? resume.after : 0;
        if (this.#recordsOf(line).length > skip) return NOT_SCANNED;
      }
      return EMPTY;
    } finally {
      await handle.close();
    }
  }

  /**
   * The coverage of a session that kept its history in its ledger. A session with no ledger holds
   * nothing, unless its history was in a database that could not be read: that is not empty, it is
   * unknown.
   */
  async #ledgerCoverage(found: FoundSession, from: Locator | undefined, durableFailed: boolean): Promise<Coverage> {
    const content = await this.#ledgerOf(found);
    if (content === null) {
      if (durableFailed || (await this.#durableUnreadable(found))) {
        return failedCoverage(`mcode: the durable history of ${found.dirName} could not be read and it has no ledger`);
      }
      return EMPTY;
    }
    for (const _ of ledgerPending(content, this.#harness, ledgerFrom(from))) return NOT_SCANNED;
    return EMPTY;
  }

  /** Whether the database exists and cannot be asked about the session of a directory. */
  async #durableUnreadable(found: FoundSession): Promise<boolean> {
    if (!existsSync(this.#durablePath)) return false;
    const native = await this.#nativeOf(found);
    return native !== null && durableHasSession(this.#durablePath, native) === null;
  }

  /** Whether the database holds the session; `null` when it cannot be asked. */
  #durableHolds(native: string): boolean | null {
    return durableHasSession(this.#durablePath, native);
  }

  async *#discover(): AsyncGenerator<FoundSession> {
    const root = this.#sessionsRoot;
    for (const year of await subdirsOf(root, /^\d{4}$/)) {
      for (const month of await subdirsOf(join(root, year), /^\d{2}$/)) {
        for (const day of await subdirsOf(join(root, year, month), /^\d{2}$/)) {
          const dayPath = join(root, year, month, day);
          for (const dirName of await subdirsOf(dayPath)) {
            if (!isSessionDir(dirName)) continue;
            const dir = join(dayPath, dirName);
            yield {
              dirName,
              logPath: logPathOf(dir),
              manifestPath: manifestPathOf(dir),
              ledgerPath: ledgerPathOf(dir),
            };
          }
        }
      }
    }
  }

  /** The id is the manifest's, the directory name is the fallback; `null` when neither names one. */
  async #infoOf(
    found: FoundSession,
    titles: ReadonlyMap<string, string>,
    wanted?: ReadonlySet<string>,
  ): Promise<SessionInfo | null> {
    const manifest = await this.#manifestOf(found);
    const native = manifest?.sessionId ?? nativeIdFromDirName(found.dirName);
    if (native === null || native === undefined || native.length === 0) return null;
    // A session that is not wanted is left out before its context or its title is read.
    if (wanted !== undefined && !wanted.has(native)) return null;
    const startedAt = toTimestamp(manifest?.createdAtMs);
    const updatedAt = toTimestamp(manifest?.updatedAtMs) ?? startedAt;
    const cwd = (await this.#contextOf(found))?.workspaceDir ?? undefined;
    const id: SessionId = { harness: this.#harness, native: NativeSessionIdSchema.parse(native) };
    const title = titles.get(native) ?? (await this.#titleOf(id, found));
    return {
      id,
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  /**
   * The title of a session the harness gave no title in its runtime state: the first message of
   * the person, with the agent-context preamble cut out. From the durable history only its head
   * is looked at, as for the working directory: the listing does not decode a history.
   */
  async #titleOf(id: SessionId, found: FoundSession): Promise<string | undefined> {
    try {
      if ((await this.#sourceOf(found)) === "durable") {
        const native = await this.#nativeOf(found);
        const title = native === null ? null : this.#durableTitle(native);
        // `null` is a database that cannot be read: the read falls back to the ledger then.
        if (title !== null) return title;
      }
      return await firstMessageTitle(this.#readOf(id, found));
    } catch {
      return undefined;
    }
  }

  /** The title from the head of the durable history; `null` when the database cannot be read. */
  #durableTitle(native: string): string | undefined | null {
    let seen = 0;
    return durableFirst(this.#durablePath, native, (turn) => {
      seen += 1;
      if (seen > 50) return STOP;
      if (turn.record?.message.role !== "user") return undefined;
      return titleFromText(textOf(turn.record.message.content));
    });
  }

  async #manifestOf(found: FoundSession): Promise<Manifest | null> {
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(found.manifestPath, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** The preamble of the first human message, looked for in the head of the journal only. */
  async #contextOf(found: FoundSession): Promise<AgentContext | null> {
    const source = await this.#sourceOf(found);
    let ledger = source === "ledger";
    if (source === "durable") {
      const native = await this.#nativeOf(found);
      // The head of the history, as for a journal: not the whole of it, for the listing asks this
      // of every session. `null` is a database that cannot be read: the ledger answers then.
      const context =
        native === null
          ? undefined
          : durableFirst(this.#durablePath, native, (turn) => {
              if (turn.record?.message.role !== "user") return undefined;
              // The preamble is on the first human message: the look ends there.
              const stated = readAgentContext(textOf(turn.record.message.content));
              return stated.workspaceDir !== null || stated.parentSessionId !== null ? stated : STOP;
            });
      if (context !== null) return context ?? null;
      ledger = true;
    }
    if (ledger) {
      const content = await this.#ledgerOf(found);
      if (content === null) return null;
      const stated = content.workspaceDir;
      if (stated === undefined) return null;
      return {
        sessionRole: null,
        sessionId: null,
        parentSessionId: null,
        workspaceDir: stated,
      };
    }
    let handle: FileHandle;
    try {
      handle = await open(found.logPath, "r");
    } catch {
      return null;
    }
    try {
      for await (const line of scanLines(handle, 0)) {
        if (line.byte >= HEAD_BYTES) break;
        if (!line.complete) break;
        const record = parseNativeRecord(parseLine(line.bytes));
        if (record?.message.role !== "user") continue;
        const context = readAgentContext(textOf(record.message.content));
        if (context.workspaceDir !== null || context.parentSessionId !== null) return context;
      }
    } catch {
      return null;
    } finally {
      await handle.close();
    }
    return null;
  }

  /** The directory name carries the encoded id; when it was cut, the manifests are asked. */
  async #find(id: SessionId): Promise<FoundSession | null> {
    const encoded = encodeNativeId(id.native);
    for await (const found of this.#discover()) {
      if (dirNameHoldsId(found.dirName, encoded)) return found;
    }
    for await (const found of this.#discover()) {
      if ((await this.#manifestOf(found))?.sessionId === id.native) return found;
    }
    return null;
  }

  /**
   * The records of one native line. One line may give several: an answer with a call in it gives
   * an assistant record and a tool-call record.
   */
  #recordsOf(line: RawLine): Unlocated[] {
    const parsed = parseLine(line.bytes);
    return recordsOfEnvelope(parseNativeRecord(parsed), parsed, { incomplete: !line.complete }, this.#harness);
  }
}

/** The records of one envelope of the journal, or of the durable history: the same mapping. */
function recordsOfEnvelope(
  record: McodeRecord | null,
  parsed: unknown,
  state: { readonly incomplete: boolean },
  harness: HarnessId,
): Unlocated[] {
  const incomplete = state.incomplete;
  if (record === null) return [unknownRecord(parsed, { incomplete })];
  const message = record.message;
  const at = millisOf(message.timestamp);
  const base: RecordBase = { ...(at !== undefined ? { at } : {}), incomplete };
  switch (message.role) {
    case "user":
      return userRecords(record, parsed, base);
    case "assistant":
      return assistantRecords(message, base, parsed);
    case "toolResult":
      return toolResultRecords(message, base, parsed, harness);
    case "compactionSummary":
      return [{ kind: "compaction", summary: message.summary ?? "", ...base }];
    default:
      return [unknownRecord(parsed, base)];
  }
}

/** Whether a position taken from a ledger still names a place in it: the head it hashed is the head it has. */
function ledgerPositionHolds(content: LedgerContent, position: Position): boolean {
  if (position.offset >= content.size) return false;
  const prefix = content.head.subarray(0, Math.min(position.prefixBytes, content.head.length));
  return prefix.length === position.prefixBytes && hashOf(prefix) === position.prefixHash;
}

/**
 * The records of a ledger that come after a position: everything on lines before the line of the
 * position, and the records of that line it did not deliver, are left out. A position of a ledger
 * that was rewritten names nothing, and the read starts over.
 */
function* ledgerPending(
  content: LedgerContent,
  harness: HarnessId,
  position: Position | undefined,
): Generator<{ readonly record: Unlocated; readonly line: LedgerLine; readonly at: number }> {
  const held = position !== undefined && ledgerPositionHolds(content, position) ? position : undefined;
  let currentByte = -1;
  let delivered = 0;
  for (const turn of content.turns) {
    if (turn.line.byte !== currentByte) {
      currentByte = turn.line.byte;
      delivered = 0;
    }
    const records = ledgerRecordsOf(turn, harness);
    const skip =
      held === undefined || turn.line.byte > held.offset
        ? 0
        : turn.line.byte < held.offset
          ? Number.POSITIVE_INFINITY
          : held.after;
    for (const [index, record] of records.entries()) {
      const at = delivered + index;
      if (at >= skip) yield { record, line: turn.line, at };
    }
    delivered += records.length;
  }
}

/**
 * The records of one turn of the ledger. A turn is mapped the way a line of the journal is
 * mapped: the same kinds, the same meanings.
 */
function ledgerRecordsOf(turn: LedgerTurn, harness: HarnessId): Unlocated[] {
  const incomplete = !turn.line.complete;
  const base: RecordBase = { incomplete };
  const message = turn.message;
  if (message === null) return [unknownRecord(turn.raw, base)];
  const at = millisOf(message.timestamp);
  const withTime: RecordBase = { ...(at !== undefined ? { at } : {}), incomplete };
  switch (message.role) {
    case "user":
      return userRecords({ message }, turn.raw, withTime);
    case "assistant":
      return assistantRecords(message, withTime, turn.raw);
    case "toolResult":
      return toolResultRecords(message, withTime, turn.raw, harness);
    case "compactionSummary":
      return [{ kind: "compaction", summary: message.summary ?? "", ...withTime }];
    default:
      return [unknownRecord(turn.raw, withTime)];
  }
}

/** What the human said, with the machine preamble cut out; nothing left means the line is kept whole. */
function userRecords(record: McodeRecord, raw: unknown, base: RecordBase): Unlocated[] {
  const text = stripHarnessNoise(textOf(record.message.content));
  if (text.length === 0 || isWrappedNoise(text)) return [unknownRecord(raw, base)];
  // The reader cut what the harness inserted out of the text itself, so what is left was typed.
  return [{ kind: "user", text, inserted: [], ...base }];
}

function assistantRecords(message: McodeMessage, base: RecordBase, raw: unknown): Unlocated[] {
  const records: Unlocated[] = [];
  const model = message.model === undefined ? {} : { model: message.model };
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content ?? []);
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text !== undefined && block.text.length > 0) {
        records.push({ kind: "assistant", text: block.text, ...model, ...base });
      }
    } else if (block.type === "toolCall" && block.id !== undefined && block.name !== undefined) {
      records.push({
        kind: "tool-call",
        callId: block.id,
        name: block.name,
        ...mcodeToolShape(block.name, block.arguments),
        ...(block.arguments === undefined ? {} : { input: jsonOf(block.arguments) }),
        ...base,
      });
      const checklist = mcodeChecklist(block.name, block.arguments);
      if (checklist !== undefined) records.push({ kind: "checklist", callId: block.id, items: checklist.items, ...base });
    } else if (block.type === "thinking") {
      records.push({ kind: "thinking", text: block.thinking ?? "", redacted: block.redacted === true, ...base });
    } else {
      // A call without an id that cannot be paired, or a block of no known kind: kept whole.
      records.push(unknownRecord(block, base));
    }
  }
  return records.length === 0 ? [unknownRecord(raw, base)] : records;
}

/** The answer of a tool; the answer of `task` also names the session it spawned. */
function toolResultRecords(
  message: McodeMessage,
  base: RecordBase,
  raw: unknown,
  harness: HarnessId,
): Unlocated[] {
  const callId = message.toolCallId;
  if (callId === undefined || callId.length === 0) return [unknownRecord(raw, base)];
  const text = textOf(message.content);
  const records: Unlocated[] = [
    {
      kind: "tool-result",
      callId,
      ...(message.toolName === undefined ? {} : { name: message.toolName }),
      output: text,
      ok: message.isError !== true,
      ...base,
    },
  ];
  const child = message.toolName === "task" ? /session_id="(mvs_[A-Za-z0-9_-]+)"/.exec(text)?.[1] : undefined;
  if (child !== undefined) {
    records.push({
      kind: "nested",
      child: { harness, native: NativeSessionIdSchema.parse(child) },
      ...base,
    });
  }
  return records;
}

function unknownRecord(raw: unknown, base: RecordBase): Unlocated {
  return { kind: "unknown", raw, ...base };
}

function toTimestamp(value: number | undefined): Timestamp | undefined {
  const ms = millisOf(value);
  return ms === undefined ? undefined : timestamp(ms);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Is this the error of a file that is not there? */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
