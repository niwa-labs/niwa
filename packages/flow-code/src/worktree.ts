/**
 * Worktrees for a script: work in one and leave it when it is clean, or build in one per seat and
 * keep the one picked. A worktree is made and removed through the git module's actions; niwa never
 * merges, so the branch of a worktree is the result.
 */

import { checkKey, isFatal, map, script, seatKeys, stream } from "@niwa-labs/flow";
import type { Seat, SeatOptions, Settled } from "@niwa-labs/flow";

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

/**
 * How a worktree stands now, as the git module reports it (`git.worktree.get`): the commit its
 * branch is at and whether anything in it is not in that commit. The module reads it outside any
 * box: a command run in the worktree is boxed to that directory, and a linked worktree keeps its git
 * directory in the repository it belongs to. A step of the script, under `key` when one is given.
 */
export async function stateOf(wt: Worktree, key?: string): Promise<{ sha: string; dirty: boolean }> {
  const ask = () => script().call("git.worktree.get", { id: wt.id });
  const got = (await (key === undefined ? ask() : script().scope(key, undefined, ask))) as { head?: string; dirty: boolean };
  if (got.head === undefined) throw new Error(`the head of the worktree ${wt.id} could not be read: its directory is gone`);
  return { sha: got.head, dirty: got.dirty };
}

/** The commit a worktree's branch is at: read under `key` by `stateOf`. */
export async function headOf(key: string, wt: Worktree): Promise<string> {
  return (await stateOf(wt, key)).sha;
}

/**
 * Work in a new worktree. When `fn` returns, the worktree is removed if it is clean with no new
 * commit, and kept otherwise: the commits are the result. When `fn` throws, the worktree is kept as
 * it is, for whoever looks into why.
 */
export async function inWorktree<T>(key: string, opts: { repo: string; base?: string; description?: string }, fn: (wt: Worktree) => Promise<T>): Promise<T> {
  checkKey(key, "the key of a worktree");
  return script().scope(key, undefined, async () => {
    const wt = await makeWorktree({ repo: opts.repo, ...(opts.base === undefined ? {} : { base: opts.base }), description: opts.description ?? `work in ${key}` });
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
  opts: { seats: readonly Seat[]; repo: string; base?: string; build: (seat: Seat, wt: Worktree) => Promise<T>; pick: (candidates: Record<string, T>) => Promise<string> },
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
        const wt = await makeWorktree({ repo: opts.repo, ...(opts.base === undefined ? {} : { base: opts.base }), description: `fork ${one.id}` });
        made.set(one.id, wt);
        return opts.build(one.seat, wt);
      },
    );
    const built = new Map<string, T>();
    builds.forEach((build, index) => {
      if (build.ok) built.set(keys[index] as string, build.value);
    });
    if (built.size === 0) throw new Error(`forkSelect "${key}": no build succeeded (${failures(keys, builds)})`);
    const id = await opts.pick(Object.fromEntries(built));
    if (!built.has(id)) throw new Error(`forkSelect "${key}": "${id}" is not a build that succeeded`);
    const rejected = keys.filter((one) => one !== id);
    for (const one of rejected) {
      const wt = made.get(one);
      if (wt !== undefined) await removeWorktree(wt, true);
    }
    return { winner: { id, value: built.get(id) as T, worktree: made.get(id) as Worktree }, rejected };
  });
}

/** Why builds failed, one `seat: reason` after another. */
function failures(keys: readonly string[], builds: readonly Settled<unknown>[]): string {
  return builds.flatMap((build, index) => (build.ok ? [] : [`${keys[index] as string}: ${build.error.message}`])).join("; ");
}

/**
 * Build the same thing once per seat, each in a worktree of its own, and take the first build that
 * `passes`, whichever seat is quick: the builds still running are cancelled, and every worktree but
 * the winner's is removed, commits and all. When no build passes, the first seat's build that
 * finished is the winner, with `passed: false`, for the caller to judge by what its value says.
 * A build that threw is no candidate; with none finished the call throws, naming each cause.
 */
export async function forkRace<T>(
  key: string,
  opts: { seats: readonly Seat[]; repo: string; base?: string; build: (seat: Seat, wt: Worktree) => Promise<T>; passes: (value: T) => boolean },
): Promise<{ winner: { id: string; value: T; worktree: Worktree; passed: boolean }; rejected: string[] }> {
  checkKey(key, "the key of a race");
  const keys = seatKeys(opts.seats, "the key of a seat");
  if (keys.length === 0) throw new TypeError(`forkRace "${key}": give at least one seat`);
  const made = new Map<string, Worktree>();
  const branches = Object.fromEntries(
    opts.seats.map((seat, index) => [
      keys[index] as string,
      async () => {
        const wt = await makeWorktree({ repo: opts.repo, ...(opts.base === undefined ? {} : { base: opts.base }), description: `fork ${keys[index] as string}` });
        made.set(keys[index] as string, wt);
        return opts.build(seat, wt);
      },
    ]),
  );
  const outcomes = new Map<string, Settled<T>>();
  let first: string | undefined;
  const race = stream(key, branches);
  try {
    for (let got = await race.next(); got !== null; got = await race.next()) {
      if (!got.result.ok && isFatal(got.result.error)) throw Object.assign(new Error(got.result.error.message), { name: got.result.error.name });
      outcomes.set(got.key, got.result);
      if (got.result.ok && opts.passes(got.result.value)) {
        first = got.key;
        break;
      }
    }
  } finally {
    await race.close();
  }
  const finished = keys.find((one) => outcomes.get(one)?.ok === true);
  const id = first ?? finished;
  if (id === undefined) {
    throw new Error(`forkRace "${key}": no build finished (${failures(keys, keys.map((one) => outcomes.get(one) ?? { ok: false as const, error: { name: "Cancelled", message: "cancelled" } }))})`);
  }
  const rejected = keys.filter((one) => one !== id);
  for (const one of rejected) {
    const wt = made.get(one);
    if (wt !== undefined) await removeWorktree(wt, true);
  }
  const value = (outcomes.get(id) as { ok: true; value: T }).value;
  return { winner: { id, value, worktree: made.get(id) as Worktree, passed: first !== undefined }, rejected };
}
