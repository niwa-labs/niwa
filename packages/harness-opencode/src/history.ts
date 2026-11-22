/**
 * OpenCode v2.3.2 history projection. The server starts the automation scheduler at boot, so a
 * local history read uses SQLite directly. The read transaction includes committed WAL data.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Database, constants } from "bun:sqlite";
import { Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionLegacy } from "@opencode/schema/session-legacy";
import { SessionMessage } from "@opencode/schema/session-message";
import { PersistedRevert, Revert } from "@opencode/schema/session-revert";
import type { SessionMessageInfo as WireMessage } from "@opencode/client";

import { realPlace } from "@niwa-labs/sandbox";

import { sessionStorageIssueOf } from "./server.ts";

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info);
const encodeMessage = Schema.encodeSync(SessionMessage.Info);
const decodeSession = Schema.decodeUnknownSync(Session.Info);
const encodeSession = Schema.encodeSync(Session.Info);
const encodeRevert = Schema.encodeSync(Revert);
const decodeRevert = Schema.decodeUnknownSync(PersistedRevert);

interface SummaryRow {
  readonly id: string;
  readonly title: string | null;
  readonly directory: string;
  readonly time_created: number;
  readonly time_updated: number;
}

interface MessageRow {
  readonly id: string;
  readonly type: string;
  readonly data: string;
}

interface PartRow {
  readonly message_id: string;
  readonly data: string;
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(text: string): JsonObject {
  const decoded: unknown = JSON.parse(text);
  if (!object(decoded)) throw new Error("the stored OpenCode data is not a JSON object");
  return decoded;
}

export class HistoryUnavailable extends Error {}

const READ_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

function diskState(path: string) {
  return [path, ...SIDECARS.map((suffix) => path + suffix)].map((name) =>
    lstatSync(name, { bigint: true, throwIfNoEntry: false })
  );
}

function sameFile(before: BigIntStats | undefined, after: BigIntStats | undefined): boolean {
  if (before === undefined || after === undefined) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function queryFile<T>(path: string, immutable: boolean, select: (database: Database) => T): T {
  const url = pathToFileURL(path);
  if (immutable) url.searchParams.set("immutable", "1");
  const database = new Database(url.href, READ_FLAGS);
  try {
    database.run("PRAGMA busy_timeout = 250");
    database.run("PRAGMA trusted_schema = OFF");
    return database.transaction(() => select(database))();
  } finally {
    database.close();
  }
}

/** A consistent, read-only view for each list, transcript, or raw session lookup. */
export class OpenCodeHistory {
  readonly #path: string;
  readonly #realHome: string;

  constructor(private readonly home: string, private readonly databaseFile: string) {
    this.#path = resolve(home, databaseFile);
    this.#realHome = realPlace(home);
    this.#validate();
  }

  #validate(): void {
    if (realPlace(this.home) !== this.#realHome) {
      throw new HistoryUnavailable("the OpenCode installation home now points to a different directory");
    }
    const issue = sessionStorageIssueOf({ OPENCODE_DB: this.databaseFile }, undefined, this.home);
    if (issue !== undefined) throw new HistoryUnavailable(issue);
  }

  #read<T>(select: (database: Database) => T): T {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#validate();
      if (statSync(this.#path, { throwIfNoEntry: false })?.isFile() !== true) {
        throw new HistoryUnavailable("the OpenCode database is missing");
      }
      const path = realpathSync(this.#path);
      const before = diskState(path);
      const [, wal, shm, journal] = before;
      if (wal?.isFile() && shm?.isFile()) return queryFile(path, false, select);
      if (journal !== undefined || (wal !== undefined && wal.size !== 0n)) {
        throw new Error("the OpenCode database needs SQLite journal recovery before it can be read without writes");
      }
      // A checkpointed WAL-mode database can have no auxiliary files. Opening it normally
      // either requires creating them or fails on SQLite builds that forbid it. An immutable
      // connection can read the checkpointed database, but ignores WAL. Discard the result if
      // a writer touched the file or created a journal while it was open.
      const unchanged = () => {
        this.#validate();
        const after = diskState(path);
        return realpathSync(this.#path) === path && before.every((file, index) => sameFile(file, after[index]));
      };
      let result: T;
      try {
        result = queryFile(path, true, select);
      } catch (error) {
        if (unchanged()) throw error;
        continue;
      }
      if (unchanged()) return result;
    }
    throw new Error("the OpenCode database changed during the history read");
  }

  list(directory: string | undefined, since: number | undefined): SummaryRow[] {
    return this.#read((database) => database.query<SummaryRow, [string | null, number | null]>(`
      SELECT id, title, directory, time_created, time_updated FROM session_v2
      WHERE (?1 IS NULL OR directory = ?1) AND (?2 IS NULL OR time_updated >= ?2)
      ORDER BY time_updated DESC, id DESC
    `).all(directory ?? null, since ?? null));
  }

  load(native: string): {
    messages: WireMessage[];
    children: Array<{ native: string; created: number }>;
  } | undefined {
    return this.#read((database) => {
      if (database.query("SELECT id FROM session_v2 WHERE id = ?").get(native) === null) return undefined;
      const rows = database.query<MessageRow, [string]>(`
        SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq
      `).all(native);
      const children = database.query<{ native: string; created: number }, [string]>(`
        SELECT id AS native, time_created AS created FROM session_v2 WHERE parent_id = ?
      `).all(native);

      // Older OpenCode v2 builds kept assistant content inline before the parts projection.
      const parts = new Map<string, JsonObject[]>();
      if (database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_part'").get()) {
        for (const row of database.query<PartRow, [string]>(`
          SELECT message_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal
        `).all(native)) {
          const data = parseObject(row.data);
          const group = parts.get(row.message_id);
          if (group === undefined) parts.set(row.message_id, [data]);
          else group.push(data);
        }
      }
      return { messages: rows.map((row) => messageOf(database, row, parts.get(row.id))), children };
    });
  }

  rawSession(native: string): unknown {
    return this.#read((database) => {
      const row = database.query<Record<string, unknown>, [string]>("SELECT * FROM session_v2 WHERE id = ?").get(native);
      if (row === null) throw new HistoryUnavailable(`the OpenCode session ${native} is missing`);
      const json = (value: unknown): JsonObject | undefined => typeof value === "string" ? parseObject(value) : undefined;
      const model = json(row["model"]);
      const revert = json(row["revert"]);
      const wire = {
        id: row["id"],
        projectID: row["project_id"],
        title: row["title"] ?? undefined,
        parentID: row["parent_id"] ?? undefined,
        fork: row["fork_session_id"] && row["fork_boundary"]
          ? { sessionID: row["fork_session_id"], boundary: json(row["fork_boundary"]) }
          : undefined,
        agent: row["agent"] ?? undefined,
        model: model && { ...model, variant: model["variant"] ?? "default" },
        cost: row["cost"],
        tokens: {
          input: row["tokens_input"],
          output: row["tokens_output"],
          reasoning: row["tokens_reasoning"],
          cache: { read: row["tokens_cache_read"], write: row["tokens_cache_write"] },
        },
        location: { directory: row["directory"] },
        subpath: row["path"] || undefined,
        metadata: json(row["metadata"]),
        permissions: typeof row["permission"] === "string" ? JSON.parse(row["permission"]) : undefined,
        revert: revert && encodeRevert(decodeRevert(revert)),
        outcome: row["idle_outcome"] ?? undefined,
        time: {
          created: row["time_created"],
          updated: row["time_updated"],
          busy: row["time_busy"] ?? undefined,
          idle: row["time_idle"] ?? undefined,
          viewed: row["time_viewed"] ?? undefined,
          archived: row["time_archived"] ?? undefined,
        },
      };
      return encodeSession(decodeSession(JSON.parse(JSON.stringify(wire))));
    });
  }
}

/** Mirrors the default transcript endpoint's inline media. Missing stored blobs become text. */
function messageOf(database: Database, row: MessageRow, parts?: JsonObject[]): WireMessage {
  const data = parseObject(row.data);
  if (row.type === "assistant" && parts !== undefined) {
    data["content"] = Array.isArray(data["content"]) ? [...parts, ...data["content"]] : parts;
  }
  if (row.type === "user" && Array.isArray(data["files"])) {
    data["files"] = data["files"].map((file: unknown) => inlineMedia(database, file, "attachment"));
  }
  if (row.type === "assistant" && Array.isArray(data["content"])) {
    data["content"] = data["content"].map((part: unknown) => {
      if (!object(part) || part["type"] !== "tool" || !object(part["state"])) return part;
      const state = part["state"];
      if ((state["status"] !== "completed" && state["status"] !== "error") || !Array.isArray(state["content"])) return part;
      return {
        ...part,
        state: { ...state, content: state["content"].map((item: unknown) => inlineMedia(database, item, "tool")) },
      };
    });
  }
  const decoded = decodeMessage({ ...SessionLegacy.message(row.type, data), id: row.id, type: row.type });
  // The encoded upstream schema is the wire message. The generated client uses mutable arrays.
  return encodeMessage(decoded) as WireMessage;
}

function inlineMedia(database: Database, value: unknown, kind: "attachment" | "tool"): unknown {
  if (!object(value) || (kind === "tool" && value["type"] !== "file")) return value;
  const { uri, mime, name, ...rest } = value;
  if (typeof uri !== "string" || !/^media:[a-f0-9]{64}$/.test(uri) || typeof mime !== "string") return value;
  const exists = database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'blob'").get();
  const stored = exists
    ? database.query<{ data: Uint8Array }, [string]>("SELECT data FROM blob WHERE hash = ?").get(uri.slice(6))
    : null;
  const named = name === undefined ? {} : { name };
  if (stored !== null) {
    const encoded = Buffer.from(stored.data).toString("base64");
    return kind === "attachment" ? { ...rest, mime, ...named, data: encoded } : { ...value, uri: `data:${mime};base64,${encoded}` };
  }
  const text = `[media unavailable: ${typeof name === "string" ? `${name} (${mime})` : mime}]`;
  return kind === "attachment"
    ? { ...rest, ...named, mime: "text/plain", data: Buffer.from(text).toString("base64") }
    : { type: "text", text };
}
