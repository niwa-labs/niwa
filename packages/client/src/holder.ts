/**
 * Who holds the journal of a home. A pid and lock probe of the host's home, for a client that must
 * tell a running host from a stale one without opening the journal as a writer.
 *
 * `bun:sqlite` is loaded when the probe runs, not when this module is: a client that never asks
 * does not pull the database in, and the contracts and the client entry stay free of it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "./home.ts";

/** The row of the one writer of the journal: the part of `journal.ts`'s table this probe reads. */
interface WriterRow {
  epoch: number;
  pid: number;
  instance: string;
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

/**
 * The pid of the living process that holds the journal of a home, or nothing when the journal is
 * free: the same condition `openJournal` refuses on. Read-only: it takes no lock.
 */
export function livingHolderPid(home: string): number | undefined {
  const file = join(expandHome(home), "journal.db");
  if (!existsSync(file)) return undefined;
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(file, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const row = db.query<WriterRow, []>("SELECT epoch, pid, instance FROM writer WHERE id = 1").get() ?? undefined;
    return row !== undefined && isProcessAlive(row.pid) ? row.pid : undefined;
  } finally {
    db.close();
  }
}
