/**
 * Where a ZCode installation keeps its sessions: one SQLite database, `<home>/cli/db/db.sqlite`.
 * The desktop app and the CLI share it, and `~/.zai` holds the same layout under another root.
 */

import { join } from "node:path";

/** The database of an installation. */
export function dbPathOf(home: string): string {
  return join(home, "cli", "db", "db.sqlite");
}

/** The user's config file of an installation: `<home>/cli/config.json`, ZCode's default `~/.zcode/cli/config.json`. */
export function configPathOf(home: string): string {
  return join(home, "cli", "config.json");
}

/** The ids ZCode gives its sessions: `sess_<uuid>`, and `sess_subagent_agent_<uuid>` for a subagent. */
export function isSessionName(name: string): boolean {
  return /^sess_[A-Za-z0-9_-]+$/.test(name);
}
