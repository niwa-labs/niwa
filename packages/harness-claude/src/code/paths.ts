/**
 * Where the sessions of a Claude Code installation live:
 * `<home>/projects/<slug>/<sessionId>.jsonl` — the log of a session,
 * `<home>/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` — the log of a subagent,
 * with `agent-<agentId>.meta.json` beside it.
 *
 * The slug is the working directory with its slashes turned into dashes, so it cannot be turned
 * back into a path: the working directory is read from the log itself, where it is written out
 * in full.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** The directory that holds the per-project directories. */
export const PROJECTS_DIR = "projects";

/** The directory that holds the logs of the subagents of a session. */
export const SUBAGENTS_DIR = "subagents";

/** The log of a session: the id of the session, and nothing else. */
const SESSION_FILE = /^[0-9a-fA-F-]{36}\.jsonl$/;

/** The log of a subagent. */
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

/** The description of a subagent, beside its log. */
const SUBAGENT_META_FILE = /^agent-(.+)\.meta\.json$/;

/** The directory that holds the projects. */
export function projectsRootOf(home: string): string {
  return join(home, PROJECTS_DIR);
}

/** The id of the session a log file holds; `null` when the name is not by the rules. */
export function sessionIdOfFile(name: string): string | null {
  return SESSION_FILE.test(name) ? name.slice(0, name.length - ".jsonl".length) : null;
}

/** The id of the subagent a log file holds; `null` when the name is not by the rules. */
export function agentIdOfFile(name: string): string | null {
  return SUBAGENT_FILE.exec(name)?.[1] ?? null;
}

/**
 * The id a subagent has in the harness's namespace.
 *
 * The log of a subagent carries the id of its PARENT in `sessionId`, so the id of the subagent
 * itself is only in the path.
 */
export function nativeIdOfSubagent(agentId: string): string {
  return `subagent-${agentId}`;
}

/** The id of the subagent a description file is about; `null` when the name is not by the rules. */
export function agentIdOfMetaFile(name: string): string | null {
  return SUBAGENT_META_FILE.exec(name)?.[1] ?? null;
}

/** The names of the entries of a directory that are directories. */
export async function dirNamesOf(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** The names of the entries of a directory that are files. */
export async function fileNamesOf(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/**
 * The names of the entries of a directory, whatever they are.
 *
 * A log that cannot be opened is still a session that is there, and a session that is gone is a
 * different fact: the entries are read by name for that reason.
 */
export async function entryNamesOf(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

/** The directory of the logs of the subagents of a session. */
export function subagentsDirOf(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, SUBAGENTS_DIR);
}

/** The log of a session. */
export function sessionLogOf(projectDir: string, sessionId: string): string {
  return join(projectDir, `${sessionId}.jsonl`);
}

/** The log of a subagent. */
export function subagentLogOf(projectDir: string, sessionId: string, agentId: string): string {
  return join(subagentsDirOf(projectDir, sessionId), `agent-${agentId}.jsonl`);
}
