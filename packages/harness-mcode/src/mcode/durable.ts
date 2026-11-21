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
 * a message once. Other kinds (the offloads of tool output) are not conversation.
 *
 * The database is only ever opened read-only; this module writes nothing.
 */

import { existsSync } from "node:fs";
import * as zlib from "node:zlib";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { parseNativeRecord } from "./format.ts";
import type { McodeRecord } from "./format.ts";

const MAGIC = "MZS2";
const HEADER_BYTES = 21;
const CODEC_ZSTD = 1;
const CODEC_GZIP = 2;

const FULL = "history.v1.full";
const APPEND = "history.v1.append";

export const DURABLE_DIR = "durable-history";
export const DURABLE_NAME = "sessions.g1.db";

/** The database of an installation. */
export function durablePathOf(home: string): string {
  return join(home, DURABLE_DIR, DURABLE_NAME);
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

/** The zstd decoder the runtime has: Bun's own, else node:zlib's; `null` when there is none. */
function zstdInflate(frame: Uint8Array): Uint8Array {
  const bun = (globalThis as { Bun?: { zstdDecompressSync?: (input: Uint8Array) => Uint8Array } }).Bun;
  if (typeof bun?.zstdDecompressSync === "function") return bun.zstdDecompressSync(frame);
  const node = (zlib as { zstdDecompressSync?: (input: Uint8Array) => Uint8Array }).zstdDecompressSync;
  if (typeof node === "function") return node(frame);
  throw new Error("mcode: this runtime has no zstd decoder, a batch of the durable history cannot be read");
}

/** The frame of a batch payload, decoded. */
function decodeBatch(payload: Uint8Array): unknown[] {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < HEADER_BYTES || bytes.subarray(0, 4).toString("latin1") !== MAGIC) {
    throw new Error("mcode: a batch of the durable history has no MZS2 header");
  }
  if (bytes.readBigUInt64BE(5) > BigInt(MAX_BATCH_BYTES)) {
    throw new Error("mcode: a batch of the durable history is larger than it may be");
  }
  const frame = bytes.subarray(HEADER_BYTES);
  const codec = bytes[4];
  let text: Buffer;
  if (codec === CODEC_ZSTD) text = Buffer.from(zstdInflate(frame));
  else if (codec === CODEC_GZIP) text = zlib.gunzipSync(frame, { maxOutputLength: MAX_BATCH_BYTES });
  else throw new Error(`mcode: a batch of the durable history has an unknown codec ${String(codec)}`);
  if (text.length > MAX_BATCH_BYTES) {
    throw new Error("mcode: a batch of the durable history is larger than it may be");
  }
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

/**
 * The conversation entries of a session in the order they were written, one batch decoded at a
 * time and only as far as the caller goes. The listing is built on the first of them; a batch is
 * not decoded for an entry that is not conversation. Runs in one read transaction: a snapshot.
 */
function* entriesOf(db: Database, native: string): Generator<Located> {
  const [low, high] = rangeOf(native);
  db.run("begin");
  const rows = db
    .query(
      "select seq, ordinal, batch_id from entries where entry_id >= ? and entry_id < ? order by seq, ordinal",
    )
    .all(low, high) as Array<{ seq: number; ordinal: number; batch_id: number }>;
  const payload = db.query("select payload from batches where batch_id = ?");
  // Entries of one batch lie together, so the last decoded batch is the one that is asked again.
  let cached: { id: number; batch: unknown[] } | undefined;
  for (const row of rows) {
    if (cached?.id !== row.batch_id) {
      const found = payload.get(row.batch_id) as { payload: Uint8Array } | null;
      if (found === null) continue;
      cached = { id: row.batch_id, batch: decodeBatch(found.payload) };
    }
    const entry = cached.batch[row.ordinal];
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, payload: body } = entry as { kind?: unknown; payload?: unknown };
    if (kind !== FULL && kind !== APPEND) continue;
    const envelopes = (body as { envelopes?: unknown } | null | undefined)?.envelopes;
    yield { seq: row.seq, ordinal: row.ordinal, kind, envelopes: Array.isArray(envelopes) ? envelopes : [] };
  }
}

function readView(path: string, native: string): DurableTurn[] {
  if (!existsSync(path)) return [];
  const db = open(path);
  try {
    let view: DurableTurn[] = [];
    const seen = new Set<string>();
    for (const entry of entriesOf(db, native)) {
      if (entry.kind === FULL) {
        view = [];
        seen.clear();
      }
      for (const [index, raw] of entry.envelopes.entries()) {
        const messageId = messageIdOf(raw);
        if (messageId !== undefined) {
          if (seen.has(messageId)) continue;
          seen.add(messageId);
        }
        view.push({ seq: entry.seq, ordinal: entry.ordinal, index, messageId, raw, record: parseNativeRecord(raw) });
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
      for (const entry of entriesOf(db, native)) {
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
