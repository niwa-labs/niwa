import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Git } from "./git.ts";

/** The directories and mapping file of a downstream package. */
export interface PackagePaths {
  readonly dir: string;
  readonly upstream: string;
  readonly texts: string;
  readonly mapping: string;
}

/** The default layout within the downstream package, or a copy of it in a worktree. */
export function pathsIn(dir: string): PackagePaths {
  const upstream = join(dir, "upstream");
  return { dir, upstream, texts: join(dir, "src", "workflows", "texts"), mapping: join(upstream, "mapping.json") };
}

/** One file or subtree selected from the upstream Git checkout. Paths use forward slashes. */
export interface SnapshotPath {
  /** Path relative to the snapshot. */
  readonly snapshot: string;
  /** Path relative to the Git checkout folder given to the tool. */
  readonly from: string;
  /** Relative files and subtrees to keep. A directory prefix ends in a slash. */
  readonly keep?: readonly string[];
}

export interface SnapshotSpec {
  readonly repository: string;
  /** The recorded path within the upstream repository. */
  readonly path: string;
  readonly paths: readonly SnapshotPath[];
  /** Snapshot-relative files that must exist in a refresh. */
  readonly requiredFiles?: readonly string[];
  /** Snapshot-relative directories that must contain at least one file in a refresh. */
  readonly requiredDirectories?: readonly string[];
  /** Snapshot-relative files excluded from text coverage, in addition to the default metadata. */
  readonly metadata?: readonly string[];
  /** Name of the upstream checkout in refresh errors. */
  readonly name?: string;
}

/** Where the snapshot was taken from. */
export interface UpstreamSource {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
}

/** Files of the snapshot that do not count as upstream text. */
export const SNAPSHOT_META: readonly string[] = ["SOURCE.json", "LICENSE", "mapping.json"];

/** The path of a snapshot file in an upstream checkout. */
export function checkoutPathOf(file: string, spec: SnapshotSpec): string {
  for (const one of spec.paths) {
    if (file === one.snapshot) return one.from;
    if (file.startsWith(`${one.snapshot}/`)) return `${one.from}/${file.slice(one.snapshot.length + 1)}`;
  }
  throw new Error(`${file} is not a file of the upstream snapshot`);
}

/** The path in the snapshot of a file of an upstream checkout. */
export function snapshotPathOf(path: string, spec: SnapshotSpec): string | undefined {
  for (const one of spec.paths) {
    const root = one.from;
    if (path !== root && !path.startsWith(`${root}/`)) continue;
    const rest = path === root ? "" : path.slice(root.length + 1);
    if (one.keep !== undefined && !one.keep.some((entry) => (entry.endsWith("/") ? rest.startsWith(entry) : rest === entry))) continue;
    return rest === "" ? one.snapshot : `${one.snapshot}/${rest}`;
  }
  return undefined;
}

/** Read where a snapshot was taken from. */
export function sourceOf(upstream: string): UpstreamSource {
  return JSON.parse(readFileSync(join(upstream, "SOURCE.json"), "utf8")) as UpstreamSource;
}

/** The files of a snapshot, as paths from its folder with `/`, sorted. */
export function snapshotFiles(upstream: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else found.push(`${prefix}${name}`);
    }
  };
  walk(upstream, "");
  return found.sort();
}

/**
 * Read the configured files from a Git commit, then replace the snapshot.
 * Its mapping survives the refresh. The upstream checkout is only read.
 */
export function refreshUpstream(checkout: string, spec: SnapshotSpec, into: { upstream: string; commit?: string }): UpstreamSource {
  const { upstream } = into;
  const git = new Git(checkout);
  const commit = git.resolve(into.commit ?? "HEAD");
  if (commit === undefined) throw new Error(`${checkout} has no commit ${into.commit ?? "HEAD"}: it is not a git checkout of upstream`);
  const files = new Map<string, Buffer>();
  for (const one of spec.paths) {
    for (const path of git.list(commit, one.from)) {
      const file = snapshotPathOf(path, spec);
      if (file === undefined || files.has(file)) continue;
      if (file.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") || ["SOURCE.json", "mapping.json"].includes(file)) {
        throw new Error(`invalid snapshot path ${JSON.stringify(file)}`);
      }
      const bytes = git.blob(commit, path);
      if (bytes === undefined) throw new Error(`could not read ${path} from ${checkout} at ${commit}`);
      files.set(file, bytes);
    }
  }
  const missing = `${checkout} is not an upstream ${spec.name === undefined ? "" : `${spec.name} `}checkout at ${commit}`;
  for (const needed of spec.requiredFiles ?? []) {
    if (!files.has(needed)) throw new Error(`${missing}: ${checkoutPathOf(needed, spec)} is missing`);
  }
  for (const needed of spec.requiredDirectories ?? []) {
    if (![...files.keys()].some((file) => file.startsWith(`${needed}/`))) throw new Error(`${missing}: it has no ${needed.split("/").at(-1)}`);
  }
  if (files.size === 0) throw new Error(`${missing}: it contains none of the snapshot files`);
  const source: UpstreamSource = { repository: spec.repository, path: spec.path, commit };
  const mapping = join(upstream, "mapping.json");
  const parent = dirname(resolve(upstream));
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, ".upstream-map-"));
  const next = join(stage, "next");
  const previous = join(stage, "previous");
  let preservePrevious = false;
  try {
    for (const [file, bytes] of files) {
      const target = join(next, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(join(next, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
    if (existsSync(mapping)) writeFileSync(join(next, "mapping.json"), readFileSync(mapping));
    if (existsSync(upstream)) renameSync(upstream, previous);
    try {
      renameSync(next, upstream);
    } catch (error) {
      // Keep the old snapshot available if restoring its destination also fails.
      preservePrevious = existsSync(previous);
      if (preservePrevious) renameSync(previous, upstream);
      preservePrevious = false;
      throw error;
    }
  } finally {
    if (!preservePrevious) rmSync(stage, { recursive: true, force: true });
  }
  return source;
}
