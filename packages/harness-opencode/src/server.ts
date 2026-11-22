/**
 * What both sides of this kind share with the HTTP server of opencode v2: how a child of
 * `opencode serve --stdio` is pointed at the installation, the password every call of a server
 * carries, the one JSON line a child announces itself with, and the ladder that ends it.
 *
 * The control side starts its children through the sandbox funnel (`spawnAgent`). Local history
 * reads use the same database settings without starting a server.
 */

import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { realPlace } from "@niwa-labs/sandbox";
import type { OpenCode } from "@opencode/client";

/** How many bytes one line of a child's output may take before it is given up on. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The environment settings OpenCode uses to select its database within or outside its data root. */
export const STORAGE_ENV_NAMES = ["OPENCODE_DB", "OPENCODE_DISABLE_CHANNEL_DB"] as const;

/**
 * OpenCode roots its state at `$XDG_DATA_HOME/opencode`: an installation home of `<dir>/opencode`
 * sets `XDG_DATA_HOME` to `<dir>`. An explicit home must end in `opencode` to select that store.
 */
export function installationEnvOf(home: string | undefined): Readonly<Record<string, string>> {
  if (home === undefined) return {};
  return { XDG_DATA_HOME: dirname(installationHome(home)) };
}

export function installationHome(home: string): string {
  const resolved = resolve(home.startsWith("~/") ? join(homedir(), home.slice(2)) : home);
  if (home === "" || basename(resolved) !== "opencode") {
    throw new Error(`opencode: installation home "${home}" must end in /opencode`);
  }
  return resolved;
}

/** Capture the database settings before either side starts a child. */
export function storageEnvOf(env?: Readonly<Record<string, string>>): Record<string, string> {
  const storage: Record<string, string> = {};
  for (const name of STORAGE_ENV_NAMES) {
    const value = env?.[name] ?? process.env[name];
    if (value !== undefined) storage[name] = value;
  }
  return storage;
}

/** A reader and a resumed session must share a persistent database. */
export function sessionStorageIssueOf(
  bound: Readonly<Record<string, string>>,
  requested?: Readonly<Record<string, string>>,
  home?: string,
): string | undefined {
  const db = bound["OPENCODE_DB"];
  const requestedDb = requested?.["OPENCODE_DB"];
  if (db === ":memory:" || requestedDb === ":memory:") {
    return "OPENCODE_DB=:memory: cannot persist sessions across OpenCode servers. Use a file-backed database";
  }
  if (requestedDb !== undefined && requestedDb !== db) {
    return "OPENCODE_DB selects the installation's database. Set it in the OpenCode installation's control.env";
  }
  const channelDb = bound["OPENCODE_DISABLE_CHANNEL_DB"];
  const requestedChannelDb = requested?.["OPENCODE_DISABLE_CHANNEL_DB"];
  if (requestedChannelDb !== undefined && disablesChannelDb(requestedChannelDb) !== disablesChannelDb(channelDb)) {
    return "OPENCODE_DISABLE_CHANNEL_DB selects the installation's database. Set it in the OpenCode installation's control.env";
  }
  if (home !== undefined && db !== undefined && !storageInside(home, db)) {
    return "OPENCODE_DB and its SQLite sidecar files must resolve inside the OpenCode installation home";
  }
  return undefined;
}

function disablesChannelDb(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Resolve existing ancestors as the sandbox does, refusing dangling links that hide their target. */
function storageLocation(path: string): string | undefined {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing || lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
    existing = parent;
  }
  return resolve(realPlace(existing), relative(existing, path));
}

/** Both the configured path and SQLite's resolved name can have adjacent sidecar files. */
function storageInside(home: string, db: string): boolean {
  try {
    const root = installationHome(home);
    const homePath = storageLocation(root);
    const configured = resolve(root, db);
    const database = storageLocation(configured);
    if (homePath === undefined || database === undefined) return false;
    const staysWithinHome = (path: string): boolean => {
      const resolved = storageLocation(path);
      if (resolved === undefined) return false;
      const inner = relative(homePath, resolved);
      return inner !== "" && !isAbsolute(inner) && inner !== ".." && !inner.startsWith(`..${sep}`);
    };
    if (!staysWithinHome(database)) return false;
    for (const name of new Set([configured, database])) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (!staysWithinHome(`${name}${suffix}`)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The Basic authorization of a session's server: the user is fixed, the password is the child's own. */
export function authOf(password: string): OpenCode.ClientOptions["headers"] {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

/**
 * The child announces the HTTP origin of its local server. Ignore other output before sending
 * the server password or any session request.
 */
export function announcementIn(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { readonly url?: unknown } | null;
    if (typeof value?.url !== "string") return undefined;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")) return undefined;
    const explicitHttpPort = `http://${url.hostname}:80`;
    if (url.port === "0") return undefined;
    if (url.port === "") {
      return value.url === explicitHttpPort || value.url === `${explicitHttpPort}/` ? url.origin : undefined;
    }
    // Require the origin itself and accept a trailing slash. This excludes user info and paths.
    if (value.url === url.origin || value.url === `${url.origin}/`) return url.origin;
  } catch {
    // Ignore other startup output.
  }
  return undefined;
}

/**
 * What stopping a server child works on. One child of each spawn path — the sandbox funnel's, and
 * `Bun.spawn`'s — is adapted to this; the ladder below walks it the same way for both.
 */
export interface ServerChild {
  readonly pid: number | undefined;
  hasExited(): boolean;
  /** Ends the input: the server exits when its stdin closes. */
  endInput(): void;
  /** Signals the child's process group, falling back to the child itself when it leads no group. */
  signalGroup(signal: NodeJS.Signals): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/** Ends the input and lets the child drain, then SIGTERM to the process group, then SIGKILL. */
export async function stopServer(child: ServerChild, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!child.hasExited()) {
    child.endInput();
    if (!(await child.waitForExit(graceMs))) {
      child.signalGroup("SIGTERM");
      if (!(await child.waitForExit(graceMs))) {
        child.signalGroup("SIGKILL");
        await child.waitForExit(graceMs);
      }
    }
  }
  // What the child started may outlive the leader.
  child.signalGroup("SIGKILL");
}
