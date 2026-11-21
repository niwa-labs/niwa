/** The way a client reads the path of a home. */

import { homedir } from "node:os";
import { join } from "node:path";

/** `~` at the start of a home is the user's home directory — the same rule the host uses. */
export function expandHome(home: string): string {
  if (home === "~") return homedir();
  if (home.startsWith("~/")) return join(homedir(), home.slice(2));
  return home;
}
