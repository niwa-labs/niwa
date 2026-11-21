/** Where a relative path of a spec is read from, said once: the sandboxes and their checks all use it. */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { boxSpec } from "./spec.ts";
import type { BoxSpec } from "./spec.ts";

/**
 * The path a spec entry names, absolute. A relative one is taken from `base`, never from whatever
 * directory the host happens to be in; `~` is left for the sandbox to expand.
 */
export function anchored(path: string, base: string): string {
  return path === "~" || path.startsWith("~/") || isAbsolute(path) ? path : resolve(base, path);
}

/**
 * The working directory of a spec, absolute: the one place the host's own directory is consulted,
 * and the one place a leading `~` is expanded here, since every relative path is read from the result.
 */
export function workingDirectory(cwd: string): string {
  if (cwd === "~" || cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return anchored(cwd, process.cwd());
}

/** The spec with every relative path made absolute against its working directory. */
export function anchoredSpec(spec: BoxSpec): BoxSpec {
  const cwd = workingDirectory(spec.cwd);
  const within = (paths: readonly string[]) => paths.map((path) => anchored(path, cwd));
  return boxSpec({ ...spec, cwd, read: within(spec.read), write: within(spec.write), denyRead: within(spec.denyRead), sockets: within(spec.sockets) });
}
