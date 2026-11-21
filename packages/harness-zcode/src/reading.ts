/**
 * The reading side of a ZCode installation. It reads the
 * harness's SQLite database read-only and copies nothing. The format is in `format.ts`, the
 * layout in `paths.ts`.
 *
 * A locator is `zcode:v1:<message>:<part>:<sub>`: the `sequence` of the message, the `sequence`
 * of the part inside it, and which of the part's records it is (a tool part is two: the call,
 * then its result, and a third, the checklist, when the call wrote one). The sequences are the
 * harness's own order, so a locator names the same place however the session grows. A session
 * spawned inside this one sits where it was created: right after the last part that existed
 * then, with a `sub` of 3 and up.
 *
 * Only the tail of a running session is half written: the last message while its answer has no
 * completion time, and the tool parts of it that still run. Those records are marked incomplete.
 * An older message that was never completed (its process was killed) is whole as it stands.
 */

import { existsSync } from "node:fs";

import { Database } from "bun:sqlite";
import { z } from "zod";

import { assertNever, optionalJsonOf, timestamp } from "@niwa-labs/core";
import {
  EMPTY,
  LocatorSchema,
  NOT_SCANNED,
  NativeSessionIdSchema,
  failedCoverage,
  unavailableCoverage,
} from "@niwa-labs/harness";
import type {
  Coverage,
  HarnessId,
  Locator,
  SessionFilter,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
} from "@niwa-labs/harness";

import { isHumanMessage, isRunning, millisOf, modelOf, readMessage, readPart, resultOf } from "./format.ts";
import type { MessageData } from "./format.ts";
import { configuredModeOf } from "./config.ts";
import { dbPathOf } from "./paths.ts";
import { zcodeChecklist, zcodeToolShape } from "./tools.ts";

export interface ZcodeReadingOptions {
  /** The id of the installation this side serves. */
  readonly harness: HarnessId;
  /** The directory that holds `cli/db/db.sqlite`. */
  readonly home: string;
}

/** The sub of the first nested session at a place: the parts' own records take 0 to 2. */
const FIRST_NESTED_SUB = 3;
/** How many ids a query names at most; more than that is filtered after the query. */
const MAX_NAMED = 500;

/** A record before the reading side has put its locator in. */
type Unlocated = SessionRecord extends infer R ? (R extends unknown ? Omit<R, "locator"> : never) : never;

/** The place of a record in its session. */
interface Position {
  readonly message: number;
  readonly part: number;
  readonly sub: number;
}

interface Item {
  readonly at: Position;
  readonly record: Unlocated;
}

const LOCATOR = /^zcode:v1:(-?\d+):(-?\d+):(\d+)$/;

function encode(at: Position): Locator {
  return LocatorSchema.parse(`zcode:v1:${at.message}:${at.part}:${at.sub}`);
}

function decode(locator: Locator): Position {
  const match = LOCATOR.exec(locator);
  if (match === null) throw new Error(`zcode: ${locator} is not a locator of this side`);
  return { message: Number(match[1]), part: Number(match[2]), sub: Number(match[3]) };
}

function compare(a: Position, b: Position): number {
  return a.message - b.message || a.part - b.part || a.sub - b.sub;
}

/** The database, read-only: no write lock is ever taken, and a short wait rides out a checkpoint. */
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

interface Row {
  readonly mseq: number;
  readonly pseq: number;
  readonly mdata: string;
  readonly pdata: string;
  readonly ptime: number;
}

function sessionExists(db: Database, native: string): boolean {
  return db.query("select 1 from session where id = ?").get(native) !== null;
}

/** The sessions spawned inside a session, each anchored after the last part that existed when it was created. */
function nestedOf(db: Database, harness: HarnessId, native: string): Item[] {
  const children = new Map<string, number>();
  const direct = db.query("select id, time_created as created from session where parent_id = ?").all(native) as {
    id: string;
    created: number;
  }[];
  for (const child of direct) children.set(child.id, child.created);
  // Workflow actors name their parent only in the link table, which an older database lacks.
  try {
    const linked = db
      .query(
        "select s.id as id, s.time_created as created from session_task_link l join session s on s.id = l.child_session_id where l.parent_session_id = ?",
      )
      .all(native) as { id: string; created: number }[];
    for (const child of linked) children.set(child.id, child.created);
  } catch {
    // No link table: the parent ids are all there is.
  }
  if (children.size === 0) return [];
  // Where the parts sit in the session's order, read once: a child is anchored after the last of
  // them that existed when it was created.
  const parts = db
    .query(
      "select m.sequence as message, p.sequence as part, p.time_created as created from part p join message m on m.id = p.message_id where p.session_id = ? order by m.sequence, p.sequence",
    )
    .all(native) as { message: number; part: number; created: number }[];
  const anchorOf = (created: number): { message: number; part: number } => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const found = parts[index];
      if (found !== undefined && found.created <= created) return found;
    }
    return { message: -1, part: -1 };
  };
  const sorted = [...children].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const taken = new Map<string, number>();
  return sorted.map(([id, created]) => {
    const anchor = anchorOf(created);
    const place = { message: anchor.message, part: anchor.part };
    const key = `${place.message}:${place.part}`;
    const index = taken.get(key) ?? 0;
    taken.set(key, index + 1);
    return {
      at: { ...place, sub: FIRST_NESTED_SUB + index },
      record: {
        kind: "nested",
        child: { harness, native: NativeSessionIdSchema.parse(id) },
        at: millisOf(created),
        incomplete: false,
      },
    };
  });
}

/** What a part says, as common records: none for what is not conversation. */
function recordsOf(
  db: Database,
  message: MessageData | undefined,
  row: Row,
  running: boolean,
  open: boolean,
): Array<{ sub: number; record: Unlocated }> {
  const read = readPart(row.pdata);
  const unknown = (raw: unknown): Array<{ sub: number; record: Unlocated }> => [
    { sub: 0, record: { kind: "unknown", raw, at: millisOf(row.ptime), incomplete: false } },
  ];
  // A part of a type ZCode has added since, or one that is not JSON: kept whole.
  if (read.kind === "unknown") return unknown(read.raw);
  const part = read.part;
  const at = (value: unknown): number | undefined => millisOf(value) ?? millisOf(row.ptime);
  switch (part.type) {
    // The harness's own bookkeeping and the model's thoughts are not conversation: no record.
    case "reasoning":
    case "step-start":
    case "step-finish":
    case "timeline":
      return [];
    // What a person or the model wrote that no common record has a kind for, or the harness's file bookkeeping:
    // kept whole as the harness's own part, which is what an unknown record is.
    case "file": // an attachment
    case "agent": // an @agent mention
    case "subtask": // the request to spawn a subtask (the session it spawned is the `nested` record)
    case "retry": // a request of the model that was tried again
    case "snapshot": // the hash of a snapshot of the files
    case "patch": // the files a step changed
      return unknown(part);
    case "text": {
      if (message === undefined) return unknown(part);
      if (part.synthetic === true) return [];
      const base = { at: at(part.time?.start), incomplete: running };
      if (message.role === "user") {
        return isHumanMessage(message) ? [{ sub: 0, record: { kind: "user", text: part.text, ...base } }] : [];
      }
      if (message.role === "assistant") {
        const model = modelOf(message);
        return [{ sub: 0, record: { kind: "assistant", text: part.text, ...(model === undefined ? {} : { model }), ...base } }];
      }
      return [{ sub: 0, record: { kind: "unknown", raw: part, ...base } }];
    }
    case "tool": {
      if (message === undefined) return unknown(part);
      const started = at(part.state.time?.start);
      const call: Unlocated = {
        kind: "tool-call",
        callId: part.callID,
        name: part.tool,
        ...zcodeToolShape(part.tool, part.state.input),
        input: optionalJsonOf(part.state.input),
        at: started,
        // A call left running in an older message was abandoned (its process died): it has no result
        // and never will, so it does not hold the reader back. Only the last message can still be at work.
        incomplete: running || (open && isRunning(part)),
      };
      if (isRunning(part)) return [{ sub: 0, record: call }];
      const result: Unlocated = {
        kind: "tool-result",
        callId: part.callID,
        name: part.tool,
        output: optionalJsonOf(resultOf(part)),
        ok: part.state.status === "completed",
        at: at(part.state.time?.end),
        incomplete: running,
      };
      const checklist = part.state.status === "completed" ? zcodeChecklist(part.tool, part.state.input) : undefined;
      return [
        { sub: 0, record: call },
        { sub: 1, record: result },
        ...(checklist === undefined
          ? []
          : [{ sub: 2, record: { kind: "checklist" as const, callId: part.callID, items: checklist.items, at: call.at, incomplete: running } }]),
      ];
    }
    case "compaction": {
      if (message === undefined) return unknown(part);
      const summary = part.summaryMessageId === undefined ? undefined : summaryOf(db, part.summaryMessageId);
      return [{ sub: 0, record: { kind: "compaction", summary: summary ?? "", at: at(undefined), incomplete: false } }];
    }
    default:
      return assertNever(part, "part type");
  }
}

/** The summary a compaction left, in the message it names. */
function summaryOf(db: Database, messageId: string): string | undefined {
  const found = db.query("select data from message where id = ?").get(messageId) as { data: string } | null;
  return found === null ? undefined : readMessage(found.data)?.summary?.body;
}

/** The records of a session in the order they sit, with where each is. Only what follows `after` is given. */
export function* itemsOf(db: Database, harness: HarnessId, native: string, after: Position | undefined): Generator<Item> {
  // One snapshot for the marker of the tail, the sessions spawned inside and the rows: a message that
  // is written between two of the reads must not be taken for a finished one. The connection is closed
  // by the caller, which ends the read.
  db.run("begin");
  const last = (db.query("select max(sequence) as last from message where session_id = ?").get(native) as {
    last: number | null;
  }).last;
  const pending = nestedOf(db, harness, native);
  const rows = db
    .query(
      "select m.sequence as mseq, p.sequence as pseq, m.data as mdata, p.data as pdata, p.time_created as ptime from message m join part p on p.message_id = m.id where m.session_id = ? and m.sequence >= ? order by m.sequence, p.sequence",
    )
    .iterate(native, Math.max(after?.message ?? 0, 0)) as IterableIterator<Row>;
  let current: { sequence: number; message: MessageData | undefined } | undefined;
  // From the first record that is not whole on, nothing is: a reader does not move past a half-written line.
  let tail = false;
  const given = (item: Item): boolean => after === undefined || compare(item.at, after) > 0;

  for (const row of rows) {
    const place = { message: row.mseq, part: row.pseq };
    while (pending[0] !== undefined && compare({ ...pending[0].at, sub: 0 }, { ...place, sub: 0 }) < 0) {
      const nested = pending.shift();
      if (nested !== undefined && given(nested)) yield nested;
    }
    if (current?.sequence !== row.mseq) current = { sequence: row.mseq, message: readMessage(row.mdata) };
    const unfinished =
      row.mseq === last && current.message?.role === "assistant" && current.message.time?.completed === undefined;
    for (const { sub, record } of recordsOf(db, current.message, row, unfinished, row.mseq === last)) {
      tail ||= record.incomplete;
      const item: Item = { at: { ...place, sub }, record: tail ? { ...record, incomplete: true } : record };
      if (given(item)) yield item;
    }
  }
  for (const nested of pending) if (given(nested)) yield nested;
}

/** What `raw` gives back: the harness's own rows whole, or the session that was spawned. */
const RawRecordSchema = z.union([
  z.looseObject({ kind: z.literal("part"), message: z.unknown(), part: z.unknown() }),
  z.looseObject({ kind: z.literal("child"), session: z.string() }),
]);

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The directory a session ran in, as the database has it; `undefined` when it is not there. */
export function directoryOf(home: string, native: string): string | undefined {
  const path = dbPathOf(home);
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = open(path);
    const found = db.query("select directory from session where id = ?").get(native) as { directory: string } | null;
    return found?.directory;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** ZCode's built-in mode when nothing else names one (`DefaultRuntimeConfig.permission.mode`). */
const BUILT_IN_MODE = "build";

/**
 * The mode ZCode restores a resumed session in, as it derives it: the `mode` stamped on the last
 * assistant message; else the project's permission mode in `local_setting` (the project of the
 * session's row); else the user's config file `permission.mode` (project config files cannot set
 * it, see `config.ts`); else ZCode's built-in default. `undefined` when the database cannot say (no
 * database, no such session, a read that fails).
 */
export function persistedModeOf(home: string, native: string): string | undefined {
  const path = dbPathOf(home);
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = open(path);
    const rows = db.query("select data from message where session_id = ? order by sequence desc").all(native) as Array<{ data: string }>;
    for (const row of rows) {
      const message = readMessage(row.data);
      if (message?.role !== "assistant") continue;
      const mode = message["mode"];
      if (typeof mode === "string" && mode !== "") return mode;
    }
    const session = db.query("select project_id from session where id = ?").get(native) as { project_id: string } | null;
    if (session === null) return undefined;
    const setting = db
      .query("select value from local_setting where scope = 'project' and scope_id = ? and namespace = 'permission' and key = 'mode'")
      .get(session.project_id) as { value: string } | null;
    if (setting !== null) {
      const mode = (jsonOrText(setting.value) as { mode?: unknown } | null)?.mode;
      if (typeof mode === "string" && mode !== "") return mode;
    }
    return configuredModeOf(home) ?? BUILT_IN_MODE;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export class ZcodeReading implements SessionReading {
  readonly #harness: HarnessId;
  readonly #path: string;

  constructor(options: ZcodeReadingOptions) {
    this.#harness = options.harness;
    this.#path = dbPathOf(options.home);
  }

  readonly rawSchema = RawRecordSchema;

  /** The sessions of the database, last changed first. */
  async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
    if (!existsSync(this.#path)) return;
    const db = open(this.#path);
    try {
      const named = filter?.natives !== undefined && filter.natives.length <= MAX_NAMED;
      const where = ["time_deleted is null"];
      const args: Array<string | number> = [];
      if (filter?.cwd !== undefined) {
        where.push("directory = ?");
        args.push(filter.cwd);
      }
      if (filter?.since !== undefined) {
        where.push("time_updated >= ?");
        args.push(filter.since);
      }
      if (named) {
        where.push(`id in (${filter.natives.map(() => "?").join(", ")})`);
        args.push(...filter.natives);
      }
      const wanted = filter?.natives !== undefined && !named ? new Set(filter.natives) : undefined;
      const rows = db
        .query(
          `select id, directory, title, title_source as source, time_created as created, time_updated as updated from session where ${where.join(" and ")} order by time_updated desc`,
        )
        .iterate(...args) as IterableIterator<{
        id: string;
        directory: string;
        title: string;
        source: string;
        created: number;
        updated: number;
      }>;
      for (const row of rows) {
        if (wanted !== undefined && !wanted.has(row.id)) continue;
        // A title the harness has not made yet is its placeholder, not a title.
        const title = row.source === "default" ? "" : row.title.replace(/\s+/g, " ").trim();
        yield {
          id: { harness: this.#harness, native: NativeSessionIdSchema.parse(row.id) },
          ...(title === "" ? {} : { title }),
          cwd: row.directory,
          startedAt: timestamp(row.created),
          updatedAt: timestamp(row.updated),
        };
      }
    } finally {
      db.close();
    }
  }

  /** Records of a session, after `from` when given. */
  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    if (!existsSync(this.#path)) return;
    const after = from === undefined ? undefined : decode(from);
    const db = open(this.#path);
    try {
      if (!sessionExists(db, id.native)) return;
      for (const { at, record } of itemsOf(db, this.#harness, id.native, after)) {
        yield { ...record, locator: encode(at) } as SessionRecord;
      }
    } finally {
      db.close();
    }
  }

  /** The harness's own rows, whole, at a locator. */
  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    const at = decode(locator);
    const db = this.#openFor(id);
    try {
      if (at.sub >= FIRST_NESTED_SUB) {
        const child = nestedOf(db, this.#harness, id.native).find((item) => compare(item.at, at) === 0);
        if (child?.record.kind === "nested") return { kind: "child", session: child.record.child.native };
      } else {
        const row = db
          .query(
            "select m.data as mdata, p.data as pdata from message m join part p on p.message_id = m.id where m.session_id = ? and m.sequence = ? and p.sequence = ?",
          )
          .get(id.native, at.message, at.part) as { mdata: string; pdata: string } | null;
        if (row !== null) return { kind: "part", message: jsonOrText(row.mdata), part: jsonOrText(row.pdata) };
      }
    } finally {
      db.close();
    }
    throw new Error(`zcode: no record at ${locator} in session ${id.native}`);
  }

  /**
   * `unavailable` — not in the database; `failed` — the scan broke; `empty` — nothing in the range;
   * `not-scanned` — there are records niwa has not read: it copies nothing, so a range is only
   * read when a caller asks `read`. The answer comes from the generator `read` uses, so the two
   * never disagree about what is a record.
   */
  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    if (!existsSync(this.#path)) return unavailableCoverage(`zcode: there is no database at ${this.#path}`);
    try {
      const after = from === undefined ? undefined : decode(from);
      const db = open(this.#path);
      try {
        if (!sessionExists(db, id.native)) return unavailableCoverage(`zcode: session ${id.native} is not in the database`);
        for (const _ of itemsOf(db, this.#harness, id.native, after)) return NOT_SCANNED;
        return EMPTY;
      } finally {
        db.close();
      }
    } catch (error) {
      return failedCoverage(`zcode: session ${id.native} could not be scanned: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #openFor(id: SessionId): Database {
    if (!existsSync(this.#path)) throw new Error(`zcode: there is no database at ${this.#path}`);
    const db = open(this.#path);
    if (!sessionExists(db, id.native)) {
      db.close();
      throw new Error(`zcode: session ${id.native} is not in the database`);
    }
    return db;
  }
}
