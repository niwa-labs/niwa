import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { BoxRefused, realPlace, sandboxOf } from "@niwa-labs/sandbox";
import type { BoxRequest } from "@niwa-labs/sandbox";

import { dbPathOf } from "./paths.ts";

export function installationStorage(home: string | undefined): Readonly<Record<string, string>> {
  if (home === undefined) return {};
  const root = resolve(home);
  return { ZCODE_STORAGE_DIR: root, ZCODE_SESSION_DB_PATH: dbPathOf(root) };
}

function covers(root: string, path: string): boolean {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
}

export function installationWrites(home: string): string[] {
  const root = resolve(home);
  const dir = databaseDirectory(dbPathOf(root));
  return covers(realPlace(root), dir) ? [root] : [root, dir];
}

function databaseDirectory(file: string): string {
  return dirname(realPlace(file));
}

function databasePath(env: Readonly<Record<string, string>>, cwd: string): string | undefined {
  // The macOS box wrapper exports the legacy alias after the primary key. ZCode uses the last key.
  const file = env["ZCODE_SESSION_DB"] || env["ZCODE_SESSION_DB_PATH"];
  if (!file) return undefined;
  const home = env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
  return file.startsWith("~/") ? resolve(cwd, home, file.slice(2)) : resolve(cwd, file);
}

/** Finish the ZCode profile once the box and launch environments are both known. */
export async function boxedStorage(
  box: BoxRequest,
  env: Readonly<Record<string, string>>,
  cwd: string | undefined,
): Promise<{ box: BoxRequest; env: Readonly<Record<string, string>> }> {
  const base = resolve(cwd ?? realPlace(box.spec.cwd));
  const file = databasePath({ ...box.spec.env, ...env }, base);
  if (file === undefined) return { box, env };

  const parent = dirname(file);
  const dir = databaseDirectory(file);
  const absolute = (path: string) => path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(base, path);
  const placeOf = (path: string) => realPlace(absolute(path));
  // Refuse before a host-side mkdir. A directory grant also covers any closed child inside it.
  const closed = box.spec.closed?.find((path) => {
    const boundary = placeOf(path);
    return covers(boundary, dir) || covers(dir, boundary) || covers(absolute(path), parent);
  });
  if (closed !== undefined) {
    throw new BoxRefused([{ code: "closed", message: `ZCode database directory ${dir} overlaps ${closed}, which is closed` }], sandboxOf(box.sandbox).name);
  }

  // nono resolves a directory grant before the child can create it.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const writes = box.spec.write ?? [];
  const write = writes.some((path) => covers(placeOf(path), dir)) ? writes : [...writes, dir];
  // Send one key so the wrapper's environment ordering cannot change the selected database.
  const { ZCODE_SESSION_DB: _boxAlias, ...boxEnv } = box.spec.env ?? {};
  const { ZCODE_SESSION_DB: _launchAlias, ...launchEnv } = env;
  return {
    box: { ...box, spec: { ...box.spec, env: boxEnv, write } },
    env: { ...launchEnv, ZCODE_SESSION_DB_PATH: file },
  };
}
