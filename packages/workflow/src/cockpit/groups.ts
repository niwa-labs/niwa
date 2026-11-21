/** Runs grouped in blocks by the directory they were started for: one block per project. */

import type { RunEntry } from "./actions.ts";

export type RunGroup = {
  /** The directory, or undefined for the runs that were started with none. */
  directory: string | undefined;
  /** The last part of the path: what the block is called. */
  name: string;
  /** The runs of the block, the latest first. */
  runs: readonly RunEntry[];
};

/** The last part of a path, `/work/niwa` as `niwa`; the path itself for a root. */
export function directoryName(directory: string): string {
  const parts = directory.split(/[\\/]+/).filter((part) => part !== "");
  return parts.at(-1) ?? directory;
}

const NO_DIRECTORY = "No directory";

/**
 * Blocks of runs by directory. A block is ordered by its latest run, the blocks without a directory come last, and
 * inside a block the latest run is first. Two paths that differ only by a trailing separator are one directory.
 */
export function groupByDirectory(entries: readonly RunEntry[]): RunGroup[] {
  const blocks = new Map<string | undefined, RunEntry[]>();
  for (const entry of entries) {
    const key = entry.directory === undefined || entry.directory === "" ? undefined : entry.directory.replace(/(.)[\\/]+$/, "$1");
    const block = blocks.get(key);
    if (block === undefined) blocks.set(key, [entry]);
    else block.push(entry);
  }
  const latest = (runs: readonly RunEntry[]): string => runs.map((run) => run.requestedAt).sort().at(-1) ?? "";
  return [...blocks.entries()]
    .map(([directory, runs]): RunGroup => ({
      directory,
      name: directory === undefined ? NO_DIRECTORY : directoryName(directory),
      runs: [...runs].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    }))
    .sort((a, b) => {
      if ((a.directory === undefined) !== (b.directory === undefined)) return a.directory === undefined ? 1 : -1;
      return latest(b.runs).localeCompare(latest(a.runs));
    });
}
