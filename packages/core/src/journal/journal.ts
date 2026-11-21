/**
 * The journal: one SQLite file, one writer, one order.
 *
 * - Append first, publish after: a record exists only after its transaction committed.
 * - A deterministic id makes a repeated write harmless: the same id with the same content returns
 *   the committed record; the same id with different content is an integrity error and writes
 *   nothing.
 * - One writer, guarded in the database: the epoch, the pid and a random instance id are written
 *   in one transaction. A living foreign writer is refused (`WriterBusy`); a dead one is taken
 *   over; the previous holder learns it has lost ownership (`LostOwnership`).
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { grantId } from "../grant.ts";
import { principalSchema } from "../access.ts";
import { IntegrityError, LostOwnership, WriterBusy } from "../errors.ts";
import { holds } from "../filter.ts";
import { isFamily } from "../record-query.ts";
import type { ResolvedQuery } from "../record-query.ts";
import { realClock } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { recordId, recordTypeName, seq as seqOf, stableJson, streamId, timestamp } from "../record.ts";
import { RECORD_DATA_LIMIT, RecordTooLarge } from "../stores.ts";
import type {
  AppendEntry,
  Caller,
  ClientId,
  HandlerId,
  InvocationId,
  Journal,
  JournalQuery,
  NewRecord,
  RecordId,
  RecordTypeName,
  Seq,
  StoredRecord,
  StreamId,
} from "../types.ts";

/**
 * The version of the journal's own tables.
 *
 * It grows when the tables change. The statements that create the tables are idempotent, so a
 * journal of a lower version is brought forward by running them again.
 */
const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  id     TEXT    UNIQUE NOT NULL,
  stream TEXT    NOT NULL,
  type   TEXT    NOT NULL,
  schema INTEGER NOT NULL,
  data   TEXT    NOT NULL,
  actor  TEXT    NOT NULL,
  cause  TEXT    NULL,
  root   TEXT    NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_type  ON records (type, seq);
CREATE INDEX IF NOT EXISTS records_stream ON records (stream, seq);
CREATE INDEX IF NOT EXISTS records_cause ON records (cause);
CREATE INDEX IF NOT EXISTS records_root  ON records (root);
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS links_to ON links (to_id);
CREATE TABLE IF NOT EXISTS writer (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  epoch    INTEGER NOT NULL,
  pid      INTEGER NOT NULL,
  instance TEXT    NOT NULL
);
`;

interface RecordRow {
  seq: number;
  id: string;
  stream: string;
  type: string;
  schema: number;
  data: string;
  actor: string;
  cause: string | null;
  root: string;
  at: number;
}

interface WriterRow {
  epoch: number;
  pid: number;
  instance: string;
}

/** The pid of a journal nobody holds: no process, no foreign writer. */
const NO_HOLDER_PID = 0;

/** The row of the one writer of the journal, or nothing when there is none. */
function writerRow(db: Database): WriterRow | undefined {
  const row = db
    .query<WriterRow, []>("SELECT epoch, pid, instance FROM writer WHERE id = 1")
    .get();
  return row ?? undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * Is that process alive? `process.kill(pid, 0)` sends no signal; it throws ESRCH when there is no
 * such process and EPERM when there is one we may not signal — a living writer we cannot see.
 * Only ESRCH means dead.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/** Run `body` in one transaction: all of it is committed, or none of it is. */
function inTransaction<T>(db: Database, body: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.run("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Already gone; the original error is the one that matters.
      }
    }
    throw error;
  }
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/** Bring the database up to the schema this build knows. */
function migrate(db: Database): void {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`the journal database has schema v${current}, this build knows v${SCHEMA_VERSION}`);
  }
  if (current === SCHEMA_VERSION) return;
  inTransaction(db, () => {
    if (userVersion(db) > current) return; // another process migrated it while we waited for the lock
    db.run(SCHEMA_SQL);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * Take the journal, or say why it cannot be taken. The whole decision is one transaction: read
 * the owner, decide, write the new owner. A living holder is a fact to report, not a race to win,
 * and that includes another journal of this very process: only a closed or dead holder is taken
 * over, and the epoch grows by one.
 *
 * `takeover` says that the caller asked for the journal explicitly: then a living holder is
 * taken over too, and it learns it has lost ownership from its next write.
 */
function claimWriter(db: Database, instance: string, takeover: boolean): number {
  return inTransaction(db, () => {
    const row = writerRow(db);
    if (!takeover && row && isProcessAlive(row.pid)) {
      throw new WriterBusy(`another living process (pid ${row.pid}) holds the journal`, {
        pid: row.pid,
        epoch: row.epoch,
      });
    }
    const epoch = (row?.epoch ?? 0) + 1;
    db.run(
      "INSERT INTO writer (id, epoch, pid, instance) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, pid = excluded.pid, instance = excluded.instance",
      [epoch, process.pid, instance],
    );
    return epoch;
  });
}

function decodeActor(text: string): Caller {
  const value = JSON.parse(text) as {
    kind?: unknown;
    id?: unknown;
    principal?: unknown;
    grant?: unknown;
    handler?: unknown;
    invocation?: unknown;
  };
  if (value !== null && typeof value === "object") {
    if (value.kind === "host") return { kind: "host" };
    if (value.kind === "client" && typeof value.id === "string") {
      const principal = principalSchema.safeParse(value.principal);
      const held = typeof value.grant === "string" && value.grant !== "" ? grantId(value.grant) : undefined;
      return {
        kind: "client",
        id: value.id as ClientId,
        ...(principal.success ? { principal: principal.data } : {}),
        ...(held === undefined ? {} : { grant: held }),
      };
    }
    if (value.kind === "handler" && typeof value.handler === "string" && typeof value.invocation === "string") {
      return {
        kind: "handler",
        handler: value.handler as HandlerId,
        invocation: value.invocation as InvocationId,
      };
    }
  }
  throw new Error(`the journal holds a corrupt actor row: ${text}`);
}

function decode(row: RecordRow): StoredRecord {
  return {
    id: recordId(row.id),
    seq: seqOf(row.seq),
    stream: streamId(row.stream),
    type: recordTypeName(row.type),
    schema: row.schema,
    data: JSON.parse(row.data) as unknown,
    actor: decodeActor(row.actor),
    cause: row.cause === null ? null : recordId(row.cause),
    root: recordId(row.root),
    at: timestamp(row.at),
  };
}

/** Links are a set: the same dependencies in any order, repeated or not, are the same content. */
function sameLinks(stored: readonly RecordId[], declared: readonly RecordId[] | undefined): boolean {
  const wanted = new Set<string>(declared ?? []);
  return wanted.size === stored.length && stored.every((id) => wanted.has(id));
}

/** The fields in which a record contradicts what is committed under the same id. */
function differingFields(existing: StoredRecord, rec: NewRecord): string[] {
  const differing: string[] = [];
  if (existing.stream !== rec.stream) differing.push("stream");
  if (existing.type !== rec.type) differing.push("type");
  if (existing.schema !== rec.schema) differing.push("schema");
  if (stableJson(existing.data) !== stableJson(rec.data)) differing.push("data");
  if (stableJson(existing.actor) !== stableJson(rec.actor)) differing.push("actor");
  if (existing.cause !== rec.cause) differing.push("cause");
  if (existing.root !== rec.root) differing.push("root");
  return differing;
}

/** How many rows a filtered query reads at a time. */
const QUERY_CHUNK = 1000;

/** The SQL test of one type selector: a name is equal, a family (`wf.*`) is the range of names under its prefix. */
function typeClause(selector: string, params: SQLQueryBindings[]): string {
  if (!isFamily(selector)) {
    params.push(selector);
    return "type = ?";
  }
  const prefix = selector.slice(0, -1);
  params.push(prefix, `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`);
  return "(type >= ? AND type < ?)";
}

class SqliteJournal implements Journal {
  readonly instance: string;
  readonly epoch: number;

  private readonly db: Database;
  /** The clock of the host: the moment a record was committed. */
  private readonly clock: Clock;
  private closed = false;

  constructor(db: Database, instance: string, epoch: number, clock: Clock) {
    this.db = db;
    this.instance = instance;
    this.epoch = epoch;
    this.clock = clock;
  }

  append(rec: NewRecord): StoredRecord {
    const written = this.appendMany([rec]);
    const first = written[0];
    if (first === undefined) throw new Error("the journal wrote no record");
    return first;
  }

  appendMany(recs: NewRecord[]): StoredRecord[] {
    return this.appendAll(recs.map((record) => ({ record })));
  }

  /**
   * Append the records, each with the links it declares.
   *
   * The links are committed in the same transaction as the records: a record that exists has
   * its links, and a link to a record that was not written is not written either.
   */
  appendAll(entries: AppendEntry[]): StoredRecord[] {
    if (entries.length === 0) return [];
    this.assertOpen();
    return inTransaction(this.db, () => {
      // Checked inside the transaction: a takeover that happened while this transaction waited for
      // the write lock must be seen by it, not by a check before it.
      this.assertOwnership();
      const written: StoredRecord[] = [];
      for (const entry of entries) {
        const rec = entry.record;
        const existing = this.get(rec.id);
        if (existing !== undefined) {
          const differing = differingFields(existing, rec);
          if (!sameLinks(this.linksOf(rec.id), entry.links)) differing.push("links");
          if (differing.length > 0) {
            throw new IntegrityError(
              rec.id,
              `record "${rec.id}" already exists with different content (${differing.join(", ")})`,
              { differing },
            );
          }
          written.push(existing);
          continue;
        }
        const inserted = this.insert(rec, this.clock.now());
        this.writeLinks(rec.id, entry.links);
        written.push(inserted);
      }
      return written;
    });
  }

  /**
   * The records a record depends on, apart from its cause: the links it declared.
   *
   * A link is stored as one row, from the dependent record to the record it depends on, and the
   * table is indexed both ways: by the dependent record to ask what it depends on, and by the
   * other one to ask what depends on it.
   */
  linksOf(id: RecordId): RecordId[] {
    this.assertOpen();
    const rows = this.db
      .query<{ to_id: string }, [string]>("SELECT to_id FROM links WHERE from_id = ? ORDER BY rowid")
      .all(id);
    return rows.map((row) => recordId(row.to_id));
  }

  /**
   * The records that grew from a record: the ones it caused, and the ones that depend on it
   * through a link.
   */
  dependentsOf(id: RecordId): RecordId[] {
    this.assertOpen();
    const caused = this.db
      .query<{ id: string }, [string]>("SELECT id FROM records WHERE cause = ? ORDER BY seq")
      .all(id);
    const linked = this.db
      .query<{ from_id: string }, [string]>("SELECT from_id FROM links WHERE to_id = ? ORDER BY rowid")
      .all(id);
    const seen = new Set<string>();
    const out: RecordId[] = [];
    for (const child of caused) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(recordId(child.id));
    }
    for (const dependent of linked) {
      if (seen.has(dependent.from_id)) continue;
      seen.add(dependent.from_id);
      out.push(recordId(dependent.from_id));
    }
    return out;
  }

  /** Write the links of a record: one row per link, from the dependent record. */
  private writeLinks(from: RecordId, links: readonly RecordId[] | undefined): void {
    if (links === undefined || links.length === 0) return;
    const insert = this.db.prepare("INSERT OR IGNORE INTO links (from_id, to_id) VALUES (?, ?)");
    for (const to of links) insert.run(from, to);
  }

  get(id: RecordId): StoredRecord | undefined {
    this.assertOpen();
    const row = this.db.query<RecordRow, [string]>("SELECT * FROM records WHERE id = ?").get(id);
    return row === null ? undefined : decode(row);
  }

  since(
    from: Seq,
    types?: RecordTypeName[],
    limit?: number,
    stream?: StreamId,
  ): StoredRecord[] {
    this.assertOpen();
    const where = ["seq > ?"];
    const params: SQLQueryBindings[] = [from];
    if (types !== undefined && types.length > 0) {
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
    if (stream !== undefined) {
      where.push("stream = ?");
      params.push(stream);
    }
    let tail = "";
    if (limit !== undefined) {
      tail = " LIMIT ?";
      params.push(limit);
    }
    return this.db
      .query<RecordRow, SQLQueryBindings[]>(
        `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY seq${tail}`,
      )
      .all(...params)
      .map(decode);
  }

  query(q: ResolvedQuery, limit?: number): StoredRecord[] {
    this.assertOpen();
    const { where, params } = this.clauseOf(q);
    const statement = this.db.query<RecordRow, SQLQueryBindings[]>(
      `SELECT * FROM records WHERE ${where} ORDER BY seq LIMIT ?`,
    );
    // The filter is equality on paths of the data, read the same way everywhere: the rows of the
    // types and the stream are read a chunk at a time and the filter is applied to each.
    const found: StoredRecord[] = [];
    let cursor: number = q.from ?? 0;
    for (;;) {
      const want = q.filter === undefined && limit !== undefined ? limit - found.length : QUERY_CHUNK;
      const rows = statement.all(cursor, ...params, want);
      for (const row of rows) {
        const record = decode(row);
        if (q.filter !== undefined && !holds(record.data, q.filter)) continue;
        found.push(record);
        if (limit !== undefined && found.length >= limit) return found;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < want) return found;
      cursor = last.seq;
    }
  }

  tail(q: ResolvedQuery, count: number): StoredRecord[] {
    this.assertOpen();
    const { where, params } = this.clauseOf(q);
    const statement = this.db.query<RecordRow, SQLQueryBindings[]>(
      `SELECT * FROM records WHERE ${where} AND seq < ? ORDER BY seq DESC LIMIT ?`,
    );
    // From the end backwards, the same way `query` reads forwards: a chunk at a time, the filter applied to each row,
    // and no more rows than the count needs when nothing is filtered.
    const found: StoredRecord[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const want = q.filter === undefined ? count - found.length : QUERY_CHUNK;
      const rows = statement.all(q.from ?? 0, ...params, before, want);
      for (const row of rows) {
        const record = decode(row);
        if (q.filter !== undefined && !holds(record.data, q.filter)) continue;
        found.push(record);
        if (found.length >= count) return found.reverse();
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < want) return found.reverse();
      before = last.seq;
    }
  }

  /** The condition of the types and the stream of a query, and what it binds after the position: the filter is not SQL. */
  private clauseOf(q: ResolvedQuery): { where: string; params: SQLQueryBindings[] } {
    const where = ["seq > ?"];
    const params: SQLQueryBindings[] = [];
    if (q.types !== undefined && q.types.length > 0) {
      const one = q.types.map((selector) => typeClause(selector, params));
      where.push(`(${one.join(" OR ")})`);
    }
    if (q.stream !== undefined) {
      where.push("stream = ?");
      params.push(q.stream);
    }
    return { where: where.join(" AND "), params };
  }

  find(q: JournalQuery): StoredRecord[] {
    this.assertOpen();
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    where.push(typeClause(q.type, params));
    if (q.field !== undefined && q.equals !== undefined) {
      where.push("json_extract(data, ?) = ?");
      params.push(`$.${q.field}`, q.equals);
    }
    if (q.after !== undefined) {
      where.push("seq > ?");
      params.push(q.after);
    }
    return this.db
      .query<RecordRow, SQLQueryBindings[]>(
        `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY seq`,
      )
      .all(...params)
      .map(decode);
  }

  last(): Seq {
    this.assertOpen();
    const row = this.db
      .query<{ seq: number }, []>("SELECT COALESCE(MAX(seq), 0) AS seq FROM records")
      .get();
    return seqOf(row?.seq ?? 0);
  }

  /**
   * Close the journal. The ownership is given back: the row keeps the epoch (so the next writer
   * continues the sequence) but names no living process.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      inTransaction(this.db, () => {
        const row = writerRow(this.db);
        if (row === undefined || row.instance !== this.instance) return;
        this.db.run("UPDATE writer SET pid = ?, instance = ? WHERE id = 1", [NO_HOLDER_PID, ""]);
      });
    } catch {
      // A journal that cannot give its ownership back leaves a row with a dead pid behind, which the
      // next writer takes over. Failing to close must not fail to close the database.
    } finally {
      this.db.close();
    }
  }

  /** Do we still hold the journal? The instance says so: only the writer that took it knows it. */
  private assertOwnership(): void {
    const row = writerRow(this.db);
    if (row === undefined || row.instance !== this.instance) {
      throw new LostOwnership(`the journal was taken over by another writer (epoch ${row?.epoch ?? 0})`, {
        instance: this.instance,
        epoch: row?.epoch,
      });
    }
  }

  private insert(rec: NewRecord, at: number): StoredRecord {
    const data = stableJson(rec.data);
    // A record holds what niwa did and decided; anything larger is an artifact the record points at.
    const size = Buffer.byteLength(data);
    if (size > RECORD_DATA_LIMIT) throw new RecordTooLarge(rec.type, size);
    const row = this.db
      .query<RecordRow, SQLQueryBindings[]>(
        "INSERT INTO records (id, stream, type, schema, data, actor, cause, root, at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(rec.id, rec.stream, rec.type, rec.schema, data, stableJson(rec.actor), rec.cause, rec.root, at);
    if (row === null) throw new Error("the journal wrote no record");
    return decode(row);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("the journal is closed");
  }
}

/**
 * Open the journal of a home directory, and take it. The home is created if missing; the journal
 * is `<home>/journal.db`. Throws `WriterBusy` when another living process holds it.
 *
 * `takeover` takes the journal even from a living holder: it is an explicit operation, and the
 * holder learns it has lost ownership from its next write.
 */
export function openJournal(home: string, opts: { takeover?: boolean; clock?: Clock } = {}): Journal {
  const directory = expandHome(home);
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, "journal.db"), { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA synchronous = FULL");
    migrate(db);
    const instance = crypto.randomUUID();
    const epoch = claimWriter(db, instance, opts.takeover === true);
    return new SqliteJournal(db, instance, epoch, opts.clock ?? realClock());
  } catch (error) {
    db.close();
    throw error;
  }
}

/** A leading `~` is the home of the user, as in the host. */
function expandHome(home: string): string {
  if (home === "~") return homedir();
  if (home.startsWith("~/")) return join(homedir(), home.slice(2));
  return home;
}
