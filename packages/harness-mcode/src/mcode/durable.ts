/**
 * The durable history of a MiniMax Code installation: `<home>/durable-history/sessions.g1.db`, a
 * sqlite database (WAL) the harness writes to as a session goes, message by message. A new
 * session's `messages.jsonl` stays empty until the session is adopted; its history is only here.
 *
 * Layout: `entries(entry_id, seq, ordinal, batch_id)` points at `batches(batch_id, payload)`. A
 * payload is `"MZS2"`, a codec byte (1 zstd, 2 gzip), two 8-byte lengths, and from byte 21 the
 * frame, which holds a JSON array of `{id, parentId, kind, payload}`; `ordinal` is the place of the
 * entry in that array. The entries of a session have ids that start with `<native id>|`.
 *
 * Two kinds carry the conversation: `history.v1.full` (`reason` seed or adopt, `envelopes[]`) states
 * it whole, `history.v1.append` (`envelopes[]`) adds to it. An envelope is `{message_id, turn_id,
 * message}`: the line of a journal. The active view is the last `full` and the appends after it,
 * a message once. Ncode offload events can change an envelope in that view without adding a
 * message.
 *
 * The database is only ever opened read-only; this module writes nothing.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import * as zlib from "node:zlib";
import { basename, dirname, join } from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod";

import { parseNativeRecord } from "./format.ts";
import type { McodeRecord } from "./format.ts";

const MAGIC = "MZS2";
const HEADER_BYTES = 21;
const CODEC_ZSTD = 1;
const CODEC_GZIP = 2;

const FULL = "history.v1.full";
const APPEND = "history.v1.append";
const OFFLOAD = "history.v2.offload";

export const DURABLE_DIR = "durable-history";
export const DURABLE_NAME = "sessions.g1.db";

/** The database of an installation. */
export function durablePathOf(home: string): string {
  return join(home, DURABLE_DIR, DURABLE_NAME);
}

// Match the producer's safeHistoryPathSegment. This encoding is not injective.
function sessionSegment(native: string): string {
  return native.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "-").replace(/^\.+/u, "").slice(0, 180) || "snapshot";
}

function checkedDirectory(root: string, components: string[]): string | undefined {
  let directory = root;
  for (const component of components) {
    directory = join(directory, component);
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info === undefined) return undefined;
    if (!info.isDirectory()) throw new Error(`ncode: expected a session history directory at ${directory}`);
  }
  return directory;
}

/** The newest generation of Ncode's session log. Only the configured home may be a symlink. */
export function sessionDurablePath(home: string, native: string): string | undefined {
  const directory = checkedDirectory(home, [DURABLE_DIR, "sessions", sessionSegment(native)]);
  if (directory === undefined) return undefined;
  let generation = 0;
  for (const name of readdirSync(directory)) {
    const match = /^sessions\.g([1-9]\d*)\.db$/.exec(name);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > generation) generation = value;
  }
  if (generation === 0) return undefined;
  const path = join(directory, `sessions.g${generation}.db`);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const entry = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isFile()) throw new Error(`ncode: invalid session history file at ${path + suffix}`);
  }
  return path;
}

/** One message of the active view, with where it was found. */
export interface DurableTurn {
  /** The seq of the entry that carried the message. */
  readonly seq: number;
  /** The place of that entry in its batch. */
  readonly ordinal: number;
  /** The place of the envelope in that entry. */
  readonly index: number;
  /** The `message_id` of the envelope, when it has one. */
  readonly messageId: string | undefined;
  /** The envelope as the harness wrote it: what `raw` gives back. */
  readonly raw: unknown;
  /** The envelope read as a record of a journal; `null` when it is not one. */
  readonly record: McodeRecord | null;
}

/**
 * What one batch may inflate to. The database is the harness's own, but a batch that claims (or
 * turns out to be) hundreds of megabytes is not conversation: it is refused, and the session reads
 * as it did without the database, instead of the reader running out of memory.
 */
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;

/**
 * The frame of a batch, inflated by the decoder of `node:zlib` with the cap given to it: the output
 * is bounded while it is produced. Bun's own `zstdDecompressSync` has no bound, so it is never used;
 * a runtime that has no bounded zstd decoder cannot read the batch.
 */
function inflate(codec: number, frame: Uint8Array): Buffer {
  const bounded = { maxOutputLength: MAX_BATCH_BYTES };
  try {
    if (codec === CODEC_GZIP) return zlib.gunzipSync(frame, bounded);
    const zstd = (zlib as { zstdDecompressSync?: (input: Uint8Array, options: typeof bounded) => Buffer }).zstdDecompressSync;
    if (typeof zstd !== "function") {
      throw new Error("mcode: this runtime has no zstd decoder with a bound, a batch of the durable history cannot be read");
    }
    return zstd(frame, bounded);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("mcode: a batch of the durable history is larger than it may be");
    }
    throw error;
  }
}

/** The frame of a batch payload, decoded. */
export function decodeBatch(payload: Uint8Array): unknown[] {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < HEADER_BYTES || bytes.subarray(0, 4).toString("latin1") !== MAGIC) {
    throw new Error("mcode: a batch of the durable history has no MZS2 header");
  }
  if (bytes.readBigUInt64BE(5) > BigInt(MAX_BATCH_BYTES)) {
    throw new Error("mcode: a batch of the durable history is larger than it may be");
  }
  const codec = bytes[4];
  if (codec !== CODEC_ZSTD && codec !== CODEC_GZIP) {
    throw new Error(`mcode: a batch of the durable history has an unknown codec ${String(codec)}`);
  }
  const text = inflate(codec, bytes.subarray(HEADER_BYTES));
  const parsed: unknown = JSON.parse(text.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("mcode: a batch of the durable history is not an array");
  return parsed;
}

/** The entries of a session lie between these two ids: `|` is followed by `}` in ASCII. */
function rangeOf(native: string): [string, string] {
  return [`${native}|`, `${native}}`];
}

/**
 * The database, read-only: no write lock is ever taken. A short busy timeout lets a read ride out
 * the moment the harness's writer checkpoints, instead of failing at once.
 */
function open(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.run("pragma busy_timeout = 250");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * The durable history is an addition of a fork of the harness: with the regular harness there is
 * no such file, and a file that is there but cannot be read must not break the reading side. A
 * problem is told once per database, and the caller goes on as if the database had nothing.
 */
const told = new Set<string>();

function tellOnce(path: string, error: unknown): void {
  if (told.has(path)) return;
  told.add(path);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`mcode: the durable history ${path} cannot be read, it is ignored: ${reason}`);
}

/**
 * Does the database hold any entry of this session? A database that is not there holds none;
 * `null` when it is there and cannot be asked.
 */
export function durableHasSession(path: string, native: string): boolean | null {
  if (!existsSync(path)) return false;
  try {
    const db = open(path);
    try {
      const [low, high] = rangeOf(native);
      return db.query("select 1 from entries where entry_id >= ? and entry_id < ? limit 1").get(low, high) !== null;
    } finally {
      db.close();
    }
  } catch (error) {
    tellOnce(path, error);
    return null;
  }
}

/** The ids of the sessions the database holds. */
export function durableSessions(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const db = open(path);
    try {
      const rows = db
        .query(
          "select distinct substr(entry_id, 1, instr(entry_id, '|') - 1) as id from entries where entry_id >= 'mvs_' and entry_id < 'mvs`' and instr(entry_id, '|') > 0",
        )
        .all() as Array<{ id: string }>;
      return rows.map((row) => row.id);
    } finally {
      db.close();
    }
  } catch (error) {
    tellOnce(path, error);
    return [];
  }
}

/** Discover native identities only inside the fork's canonical per-session stores. */
export function* sessionStoreIds(home: string, wanted: Set<string> | undefined, listed: Set<string>): Generator<string> {
  const root = checkedDirectory(home, [DURABLE_DIR, "sessions"]);
  if (root === undefined) return;
  const segments = wanted === undefined
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : new Set(Array.from(wanted, sessionSegment));
  for (const segment of segments) {
    if (segment !== sessionSegment(segment)) continue;
    try {
      const path = sessionDurablePath(home, segment);
      if (path === undefined) continue;
      const db = open(path);
      try {
        db.run("begin");
        const rows = db.query<{ id: string }, []>(
          "select distinct substr(entry_id, 1, instr(entry_id, '|') - 1) as id from entries where instr(entry_id, '|') > 1",
        ).all();
        for (const { id } of rows) {
          if (sessionSegment(id) !== segment || listed.has(id) || (wanted && !wanted.has(id))) continue;
          if (checkpointOf(db, path, id) || !entriesOf(db, id, true).next().done) yield id;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      tellOnce(join(root, segment), error);
    }
  }
}

/**
 * The active view of a session: the last full history and the appends after it, a message once.
 * `null` when the database cannot be read (missing tables, an unknown codec, a decode error, a
 * locked file): the caller falls back to what it did before the database was there.
 */
export function readDurableSession(path: string, native: string): DurableTurn[] | null {
  try {
    return readView(path, native);
  } catch (error) {
    tellOnce(path, error);
    return null;
  }
}

/** One conversation entry of a session: where it lies and what it carries. */
interface Located {
  readonly seq: number;
  readonly ordinal: number;
  readonly kind: typeof FULL | typeof APPEND;
  readonly envelopes: unknown[];
}

const offloadSchema = z.object({
  seq: z.int().nonnegative(),
  blockIdx: z.int().nonnegative(),
  artifactRef: z.string().regex(/\S/u),
  contentBlockIdx: z.int().nonnegative().optional(),
  replacement: z.string().regex(/\S/u).optional(),
});

interface LocatedOffload {
  readonly kind: typeof OFFLOAD;
  readonly event: z.output<typeof offloadSchema>;
}

/**
 * The history entries of a session in the order they were written, one batch decoded at a time
 * and only as far as the caller goes. Runs in one read transaction: a snapshot.
 */
function* entriesOf(db: Database, native: string, sessionFile = false, afterSeq = -1): Generator<Located | LocatedOffload> {
  const [low, high] = rangeOf(native);
  const rows = db
    .query(
      "select entry_id, seq, ordinal, batch_id from entries where entry_id >= ? and entry_id < ? and seq > ? order by seq, ordinal",
    )
    .all(low, high, afterSeq) as Array<{ entry_id: string; seq: number; ordinal: number; batch_id: number }>;
  const payload = db.query("select payload from batches where batch_id = ?");
  // Entries of one batch lie together, so the last decoded batch is the one that is asked again.
  let cached: { id: number; batch: unknown[] } | undefined;
  for (const row of rows) {
    if (cached?.id !== row.batch_id) {
      const found = payload.get(row.batch_id) as { payload: Uint8Array } | null;
      if (found === null) {
        if (sessionFile) throw new Error("ncode: missing session history batch");
        continue;
      }
      cached = { id: row.batch_id, batch: decodeBatch(found.payload) };
    }
    const entry = cached.batch[row.ordinal];
    if (typeof entry !== "object" || entry === null) {
      if (sessionFile) throw new Error("ncode: missing session history entry");
      continue;
    }
    const { kind, payload: body } = entry as { kind?: unknown; payload?: unknown };
    if (typeof kind !== "string" || !kind.startsWith("history.")) {
      if (sessionFile && (body as { sessionId?: unknown } | null)?.sessionId === native) {
        throw new Error(`ncode: cannot materialize the active view for ${String(kind)}`);
      }
      continue;
    }
    if (sessionFile && ((entry as { id?: unknown }).id !== row.entry_id ||
      (body as { sessionId?: unknown } | null)?.sessionId !== native)) {
      throw new Error("ncode: session history entry identity mismatch");
    }
    const envelopes = (body as { envelopes?: unknown } | null | undefined)?.envelopes;
    if (sessionFile && kind === OFFLOAD) {
      const parsed = offloadSchema.safeParse(body);
      if (!parsed.success) throw new Error("ncode: invalid history.v2.offload payload");
      yield { kind, event: parsed.data };
    } else if (sessionFile && kind === "history.v2.tombstone") {
      yield { seq: row.seq, ordinal: row.ordinal, kind: FULL, envelopes: [] };
    } else if (sessionFile && kind === "history.v2.replace" && Array.isArray(envelopes)) {
      yield { seq: row.seq, ordinal: row.ordinal, kind: FULL, envelopes };
    } else if (kind === FULL || kind === APPEND) {
      if (sessionFile && !Array.isArray(envelopes)) throw new Error("ncode: missing session history envelopes");
      yield { seq: row.seq, ordinal: row.ordinal, kind, envelopes: Array.isArray(envelopes) ? envelopes : [] };
    } else if (sessionFile) {
      throw new Error(`ncode: cannot materialize the active view for ${kind}`);
    }
  }
}

const checkpointSchema = z.object({
  schema: z.literal(1),
  sessionId: z.string(),
  backendDirectory: z.string(),
  backendGeneration: z.int().positive(),
  backendSeq: z.int().nonnegative(),
  fold: z.object({
    headSeq: z.int().nonnegative(),
    lastEntryId: z.string(),
    segmentCounts: z.array(z.int().nonnegative()),
    segmentSeqs: z.array(z.int().nonnegative()),
    envelopes: z.array(z.object({ message_id: z.string().min(1), turn_id: z.string(), message: z.looseObject({}) }).passthrough()),
  }),
});

/** Ncode's disposable materialized fold. Validate its carrier and anchor in this read transaction. */
function checkpointOf(db: Database, path: string, native: string): z.output<typeof checkpointSchema> | undefined {
  const carrier = dirname(path);
  const cache = join(dirname(dirname(carrier)), "fold-cache");
  const file = join(cache, basename(carrier) + ".json");
  if (!lstatSync(cache, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > MAX_BATCH_BYTES) return undefined;
  try {
    const parsed = checkpointSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return undefined;
    const { sessionId, backendDirectory, backendGeneration, backendSeq, fold } = parsed.data;
    if (sessionId !== native || backendDirectory !== carrier || basename(path) !== `sessions.g${backendGeneration}.db`) return undefined;
    if (fold.segmentCounts.length !== fold.segmentSeqs.length ||
      fold.segmentCounts.reduce((sum, count) => sum + count, 0) !== fold.envelopes.length ||
      new Set(fold.segmentSeqs).size !== fold.segmentSeqs.length ||
      fold.segmentSeqs.some((seq) => seq > fold.headSeq) ||
      !fold.lastEntryId.startsWith(native + "|")) return undefined;
    if (db.query("select 1 from entries where seq >= ? limit 1").get(backendSeq) === null) return undefined;
    const [low, high] = rangeOf(native);
    const anchor = db.query(
      "select entry_id from entries where entry_id >= ? and entry_id < ? and seq <= ? order by seq desc, ordinal desc limit 1",
    ).get(low, high, backendSeq) as { entry_id: string } | null;
    if (anchor?.entry_id !== fold.lastEntryId) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

interface Segment {
  readonly seq: number;
  readonly ordinal: number;
  readonly indexOffset: number;
  readonly envelopes: unknown[];
}

/** Ncode keys deltas by logical entry number, independently of SQLite batch sequence numbers. */
function activeSegments(db: Database, path: string, native: string, sessionFile: boolean): Iterable<Segment> {
  const checkpoint = sessionFile ? checkpointOf(db, path, native) : undefined;
  const segments = new Map<number, Segment>();
  let logicalSeq = 0;
  if (checkpoint !== undefined) {
    const { backendSeq, fold } = checkpoint;
    logicalSeq = fold.headSeq;
    let offset = 0;
    for (const [index, seq] of fold.segmentSeqs.entries()) {
      const end = offset + fold.segmentCounts[index]!;
      // Preserve established checkpoint locators, whose envelope indices are into the flattened fold.
      segments.set(seq, { seq: backendSeq, ordinal: 0, indexOffset: offset, envelopes: fold.envelopes.slice(offset, end) });
      offset = end;
    }
  }
  for (const entry of entriesOf(db, native, sessionFile, checkpoint?.backendSeq)) {
    logicalSeq++;
    if (entry.kind === OFFLOAD) {
      applyOffload(segments, entry.event);
      continue;
    }
    if (entry.kind === FULL) segments.clear();
    segments.set(logicalSeq, { seq: entry.seq, ordinal: entry.ordinal, indexOffset: 0, envelopes: entry.envelopes });
  }
  return segments.values();
}

function applyOffload(segments: ReadonlyMap<number, Segment>, { seq, blockIdx, replacement }: LocatedOffload["event"]): void {
  // The append already contains the image artifact reference.
  if (replacement === undefined) return;
  const segment = segments.get(seq);
  const envelope = segment?.envelopes[blockIdx] as { message?: { content?: unknown } } | null | undefined;
  if (segment === undefined || typeof envelope?.message !== "object" || envelope.message === null ||
    Array.isArray(envelope.message)) {
    throw new Error("ncode: invalid history.v2.offload target");
  }
  const { content } = envelope.message;
  segment.envelopes[blockIdx] = {
    ...envelope,
    message: {
      ...envelope.message,
      content: Array.isArray(content)
        ? [{ type: "text", text: replacement }, ...content.filter(
          (block) => block && typeof block === "object" && block.type !== "text",
        )]
        : replacement,
    },
  };
}

export function readView(path: string, native: string, sessionFile = false): DurableTurn[] {
  if (!sessionFile && !existsSync(path)) return [];
  const db = open(path);
  try {
    db.run("begin");
    const view: DurableTurn[] = [];
    const seen = new Set<string>();
    for (const entry of activeSegments(db, path, native, sessionFile)) {
      for (const [index, raw] of entry.envelopes.entries()) {
        const messageId = messageIdOf(raw);
        if (messageId !== undefined) {
          if (seen.has(messageId)) continue;
          seen.add(messageId);
        }
        view.push({
          seq: entry.seq, ordinal: entry.ordinal, index: entry.indexOffset + index, messageId, raw,
          record: parseNativeRecord(raw),
        });
      }
    }
    return view;
  } finally {
    db.close();
  }
}

/** What `durableFirst`'s `pick` answers to say that nothing further is to be looked at. */
export const STOP = Symbol("stop");

/**
 * The first thing `pick` takes out of the envelopes of a session, in the order they were written,
 * and no further: the listing wants a working directory from the head of a history, not the
 * history. `pick` answers `undefined` to go on and `STOP` to end the look without a result.
 * `undefined` when nothing was taken, `null` when the database cannot be read.
 */
export function durableFirst<T>(
  path: string,
  native: string,
  pick: (turn: DurableTurn) => T | undefined | typeof STOP,
): T | undefined | null {
  try {
    if (!existsSync(path)) return undefined;
    const db = open(path);
    try {
      db.run("begin");
      for (const entry of entriesOf(db, native)) {
        if (entry.kind === OFFLOAD) continue;
        for (const [index, raw] of entry.envelopes.entries()) {
          const taken = pick({
            seq: entry.seq,
            ordinal: entry.ordinal,
            index,
            messageId: messageIdOf(raw),
            raw,
            record: parseNativeRecord(raw),
          });
          if (taken === STOP) return undefined;
          if (taken !== undefined) return taken;
        }
      }
      return undefined;
    } finally {
      db.close();
    }
  } catch (error) {
    tellOnce(path, error);
    return null;
  }
}

/** The `message_id` of an envelope, when it has one. */
export function messageIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { message_id?: unknown }).message_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
