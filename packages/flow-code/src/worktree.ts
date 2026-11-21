/**
 * Worktrees for a script: work in one and leave it when it is clean, or build in one per seat and
 * keep the one picked. A worktree is made and removed through the git module's actions; niwa never
 * merges, so the branch of a worktree is the result.
 */

import { checkKey, map, script, seatKeys } from "@niwa-labs/flow";
import type { Seat, SeatOptions } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";

/** A worktree as the git module made it: a checkout of `repo` on its own branch, in a directory niwa keeps. */
export type Worktree = { id: string; description: string; repo: string; path: string; branch: string; base: string; baseSha: string };

/** A description a worktree takes: a few words, at most 60 characters. */
function describe(text: string): string {
  const words = text.trim().replace(/\s+/g, " ");
  return (words.length < 3 ? `${words} work` : words).slice(0, 60).trim();
}

/** Make a worktree of `repo` from `base` (its current branch by default). A step of the script. */
export async function makeWorktree(opts: { repo: string; base?: string; description: string }): Promise<Worktree> {
  if (typeof opts.repo !== "string" || opts.repo === "") throw new TypeError("a worktree is made from a repository: give `repo`, any directory inside it");
  return (await script().call("git.worktree.create", {
    repo: opts.repo,
    ...(opts.base === undefined ? {} : { base: opts.base }),
    description: describe(opts.description),
  })) as Worktree;
}

/**
 * Remove a worktree. Without `force` the git module refuses one that is dirty, has commits its base
 * does not have or a live session in it: the worktree is kept, and the answer is false.
 */
export async function removeWorktree(wt: Worktree, force = false): Promise<boolean> {
  try {
    await script().call("git.worktree.remove", { id: wt.id, ...(force ? { force: true } : {}) });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "WorktreeRefusal") return false;
    throw error;
  }
}

/** A seat that works in a directory: its `agent()` calls start there. */
export function seatIn(seat: Seat, cwd: string): SeatOptions {
  return { ...(typeof seat === "string" ? { harness: seat } : seat), cwd };
}

/** The commit a worktree's branch is at: read with `git rev-parse HEAD` as a check in it, under `key`. */
export async function headOf(key: string, wt: Worktree): Promise<string> {
  const head = await runCheck(key, { cmd: ["git", "rev-parse", "HEAD"], cwd: wt.path, timeout: "1m" });
  const sha = head.summary.split("\n").at(-1) ?? "";
  if (!head.ok || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`the head of the worktree ${wt.id} could not be read: ${head.summary}`);
  return sha;
}

/**
 * Work in a new worktree. When `fn` returns, the worktree is removed if it is clean with no new
 * commit, and kept otherwise: the commits are the result. When `fn` throws, the worktree is kept as
 * it is, for whoever looks into why.
 */
export async function inWorktree<T>(key: string, opts: { repo?: string; base?: string; description?: string }, fn: (wt: Worktree) => Promise<T>): Promise<T> {
  checkKey(key, "the key of a worktree");
  return script().scope(key, undefined, async () => {
    const wt = await makeWorktree({ repo: opts.repo ?? "", ...(opts.base === undefined ? {} : { base: opts.base }), description: opts.description ?? `work in ${key}` });
    const result = await fn(wt);
    await removeWorktree(wt);
    return result;
  });
}

/**
 * Build the same thing once per seat, each in a worktree of its own, then let `pick` choose among the
 * builds that succeeded. The winner's worktree is kept; the others are removed, commits and all.
 */
export async function forkSelect<T>(
  key: string,
  opts: { seats: readonly Seat[]; repo?: string; base?: string; build: (seat: Seat, wt: Worktree) => Promise<T>; pick: (candidates: Record<string, T>) => Promise<string> },
): Promise<{ winner: { id: string; value: T; worktree: Worktree }; rejected: string[] }> {
  checkKey(key, "the key of a fork");
  const keys = seatKeys(opts.seats, "the key of a seat");
  if (keys.length === 0) throw new TypeError(`forkSelect "${key}": give at least one seat`);
  return script().scope(key, undefined, async () => {
    const made = new Map<string, Worktree>();
    const builds = await map(
      "builds",
      opts.seats.map((seat, index) => ({ seat, id: keys[index] as string })),
      { key: (one) => one.id },
      async (one) => {
        const wt = await makeWorktree({ repo: opts.repo ?? "", ...(opts.base === undefined ? {} : { base: opts.base }), description: `fork ${one.id}` });
        made.set(one.id, wt);
        return opts.build(one.seat, wt);
      },
    );
    const candidates: Record<string, T> = {};
    builds.forEach((build, index) => {
      if (build.ok) candidates[keys[index] as string] = build.value;
    });
    if (Object.keys(candidates).length === 0) throw new Error(`forkSelect "${key}": no build succeeded`);
    const id = await opts.pick(candidates);
    if (!(id in candidates)) throw new Error(`forkSelect "${key}": "${id}" is not a build that succeeded`);
    const rejected = keys.filter((one) => one !== id);
    for (const one of rejected) {
      const wt = made.get(one);
      if (wt !== undefined) await removeWorktree(wt, true);
    }
    return { winner: { id, value: candidates[id] as T, worktree: made.get(id) as Worktree }, rejected };
  });
}
