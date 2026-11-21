/**
 * The titles MiniMax Code gives its sessions: `<home>/v2/sqlite/runtime-state.sqlite`, table
 * `local_runtime_sessions`, columns `session_id` and `title`. The harness writes the title itself
 * (a short summary of what the session is about).
 *
 * The database is the harness's own runtime state: it is opened read-only, and one that is not
 * there, cannot be read or has no such table gives no titles. A title is a nicety, so nothing is
 * told when it is missing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

/** The runtime state of an installation, beside its sessions. */
export function runtimeStatePathOf(home: string): string {
  return join(home, "v2", "sqlite", "runtime-state.sqlite");
}

/** How many ids a query names at most; more than that reads the whole table. */
const MAX_NAMED = 500;

/** The titles of the sessions, by native id; of only `natives` when they are given. */
export function sessionTitles(path: string, natives?: readonly string[]): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(path)) return titles;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.run("pragma busy_timeout = 250");
    const named = natives !== undefined && natives.length > 0 && natives.length <= MAX_NAMED;
    const rows = db
      .query(
        `select session_id as id, title from local_runtime_sessions where title is not null${
          named ? ` and session_id in (${natives.map(() => "?").join(", ")})` : ""
        }`,
      )
      .all(...(named ? natives : [])) as { id: unknown; title: unknown }[];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.title !== "string") continue;
      const title = row.title.replace(/\s+/g, " ").trim();
      if (title.length > 0) titles.set(row.id, title);
    }
  } catch {
    // The state cannot be read, or it holds no such table: the sessions are listed without it.
  } finally {
    db?.close();
  }
  return titles;
}
