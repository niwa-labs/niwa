/**
 * Profiles: the paths a tool or a harness needs, and nothing about why.
 *
 * A profile is the places a program reads, writes and reaches. It is a plain object, or a
 * function of the machine it is resolved on (`home`, the environment, and `bin` to find a
 * program). It says nothing of what its paths hold: a profile is taken whole or not at all.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** What a profile names: the places read, the places written (and read), the hosts reached. */
export interface ProfilePaths {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly net?: readonly string[];
}

/** What a profile is resolved against: the machine it runs on. */
export interface ProfileContext {
  /** The real home directory of the user. */
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * A program found through the PATH of `env`, or given by its absolute path (a runtime, an
   * installed package): the path, its real path, and the root of the package it belongs to when it
   * lies in a `node_modules`. Empty when it is not there. What it gives is never closed to another
   * box: a profile names programs through it, and its own data without it.
   */
  bin(name: string): readonly string[];
}

/** A profile: its paths, or how to find them on a machine. Paths are absolute or start with `~`. */
export type BoxProfile = ProfilePaths | ((context: ProfileContext) => ProfilePaths);

/** A profile resolved on a machine: every path absolute, and the paths that are programs told apart. */
export interface ResolvedProfile {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly net: readonly string[];
  /** The paths `bin` gave: programs and their packages, which are never closed to other boxes. */
  readonly programs: readonly string[];
}

/** A path with `~` made the home directory. */
export function homeExpanded(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * A path as a sandbox sees it: absolute, `~` expanded, and the links of its longest existing part
 * resolved, so a link cannot name a place under a name that hides it.
 */
export function realPlace(path: string, home: string = homedir()): string {
  return resolvedLinks(resolve(homeExpanded(path, home)));
}

function resolvedLinks(absolute: string): string {
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolvedLinks(parent), basename(absolute));
  }
}

/**
 * A path with the links of the directories above it resolved but not its own: a program found
 * through a link is run by the link's name, so the name has to stay reachable beside its target.
 */
export function linkPlace(path: string, home: string = homedir()): string {
  const absolute = resolve(homeExpanded(path, home));
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(resolvedLinks(parent), basename(absolute));
}

/** Is `path` the place `root` names, or under it? */
export function covers(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The root of the package a real path lies in, when it lies in a `node_modules`. */
function packageRoot(real: string): string | undefined {
  const parts = real.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const scoped = parts[at + 1]?.startsWith("@") === true;
  const end = at + (scoped ? 3 : 2);
  return end > parts.length ? undefined : parts.slice(0, end).join(sep);
}

/**
 * A program on the PATH of `env`, or a program, runtime or installed package given by its absolute
 * path: where it is, its real path, and its package. Nothing when it is not there.
 */
export function programPaths(name: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const found = isAbsolute(name) ? name : Bun.which(name, { PATH: env["PATH"] ?? "" });
  if (found === null) return [];
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return [];
  }
  const root = packageRoot(real);
  return [...new Set([found, real, ...(root === undefined ? [] : [root])])];
}

/** The paths of a profile, checked: absolute or under `~`, never relative to wherever the host happens to be. */
function checked(paths: readonly string[] | undefined, home: string, of: string): string[] {
  return (paths ?? []).map((path) => {
    const expanded = homeExpanded(path, home);
    if (!isAbsolute(expanded)) throw new TypeError(`profile ${of}: ${JSON.stringify(path)} is neither absolute nor under ~`);
    return resolve(expanded);
  });
}

/** Resolves a profile on this machine. `of` names it in errors. */
export function resolveProfile(profile: BoxProfile, of: string, machine: { home: string; env: Readonly<Record<string, string | undefined>> }): ResolvedProfile {
  const programs: string[] = [];
  const context: ProfileContext = {
    home: machine.home,
    env: machine.env,
    bin(name) {
      const paths = programPaths(name, machine.env);
      programs.push(...paths);
      return paths;
    },
  };
  const paths = typeof profile === "function" ? profile(context) : profile;
  return {
    read: checked(paths.read, machine.home, of),
    write: checked(paths.write, machine.home, of),
    net: [...(paths.net ?? [])],
    programs: [...new Set(programs)],
  };
}
