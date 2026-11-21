/**
 * Where the sessions of a MiniMax Code installation live:
 * `<home>/v2/sessions/YYYY/MM/DD/hh-mm-ss-mmm-session_<base64url(id)>/{messages.jsonl,manifest.json}`.
 * The directory name carries the encoded id (cut to 180 characters), the manifest is authoritative.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_NAME = "messages.jsonl";
export const MANIFEST_NAME = "manifest.json";
/** The ledger of a session: the history of the sessions that kept no journal of their own. */
export const LEDGER_NAME = "ledger.jsonl";

const SESSION_DIR = /^\d{2}-\d{2}-\d{2}-\d{3}-session_[A-Za-z0-9_-]+$/;

/** Is this directory name the directory of a session? */
export function isSessionDir(name: string): boolean {
  return SESSION_DIR.test(name);
}

/** The journal and the manifest of a session directory. */
export function logPathOf(dir: string): string {
  return join(dir, LOG_NAME);
}

export function manifestPathOf(dir: string): string {
  return join(dir, MANIFEST_NAME);
}

/** The ledger of a session directory. */
export function ledgerPathOf(dir: string): string {
  return join(dir, LEDGER_NAME);
}

/** The id as the directory name carries it: base64url, no padding. */
export function encodeNativeId(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/** The id a directory name carries; `null` when the name is not by the rules. */
export function nativeIdFromDirName(dirName: string): string | null {
  const payload = /^(?:\d{2}-\d{2}-\d{2}-\d{3}-)?session_(.+)$/.exec(dirName)?.[1];
  if (payload === undefined) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  return /^[A-Za-z0-9_-]+$/.test(decoded) ? decoded : null;
}

/** Does the directory name carry this encoded id? */
export function dirNameHoldsId(dirName: string, encodedId: string): boolean {
  return dirName.endsWith(`session_${encodedId}`);
}

/** The subdirectories of a path, newest name first; a missing path has none. */
export async function subdirsOf(path: string, pattern?: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && (pattern === undefined || pattern.test(e.name)))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The profile the installation at `~/.minimax` belongs to. */
export const DEFAULT_PROFILE = "default";

/** The name of the home directory (under the user's home) of a profile; no profile is the default one. */
export function homeNameOfProfile(profile: string | undefined): string {
  return profile === undefined || profile === DEFAULT_PROFILE ? ".minimax" : `.minimax-${profile}`;
}

/** The home of the installation a profile belongs to, under `base` (the user's home by default). */
export function homeOfProfile(profile: string | undefined, base: string = homedir()): string {
  return join(base, homeNameOfProfile(profile));
}
