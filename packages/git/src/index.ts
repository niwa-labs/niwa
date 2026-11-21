/**
 * The git module: worktrees an agent works in, beside the owner's checkout.
 *
 * - **git.worktree.create** makes a worktree of a repository on a new branch `wt-<hex>`, the same as
 *   its id, in `<home>/worktrees/<id>`. The base is the one asked for, else the repository's current
 *   branch (its commit when HEAD is detached). The ignored files `<repo>/.worktreeinclude` lists are
 *   copied in, as clones where the file system makes them.
 * - **git.worktree.list** shows the worktrees, and flags a recorded one whose directory is gone and a
 *   directory in the store that no record names.
 * - **git.worktree.get** shows one, with how it stands now: dirty, commits ahead of its base, the
 *   live niwa sessions in it.
 * - **git.worktree.remove** removes the directory and the branch. It refuses a worktree that is
 *   dirty, ahead of its base or has a live session in it, unless forced.
 * - **git.head.observe** records `git.head.moved` for each worktree whose head is on another commit
 *   than the last one recorded for it. The module looks by itself when a session's turn ends in a
 *   worktree, and names that session in the record; a run that looks is who its record is of.
 *
 * The list and a get show each worktree's head and the remote its base pushes to, verified from the
 * repository's configuration, so what happens on a forge can be tied to the worktrees of its project.
 *
 * The cleanup of old worktrees is a built-in workflow of the module (`workflows/worktree-cleanup.ts`), on a timer
 * the module offers: every day it reads the list and removes what is older than `cleanup.days`, clean, merged and
 * unused. `git({ cleanup: false })` turns it off; the host needs the timers and the workflow module for it.
 *
 * Niwa never merges: the branch is what the work left, and merging it is the agent's or the owner's.
 * The id is issued from the record that makes the worktree, so a replayed create finds what it made.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CatchableError, EntityDescription, IdIndex, action, idSchema, recordId, seq, stableJson } from "@niwa-labs/core";
import type { ActionContext, IssuedId, JournalReader, RecordId, RecordTypeName, SessionRef, StoredRecord } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, TIMER_OFFER, plugin } from "@niwa-labs/plugin";
import type { Plugin, Subscriber } from "@niwa-labs/plugin";

import {
  gitCleanupConfig,
  gitHeadObserve,
  gitWorktreeCreate,
  gitWorktreeGet,
  gitWorktreeList,
  gitWorktreeRemove,
} from "./actions.ts";
import type { WorktreeEntity, WorktreeState } from "./actions.ts";
import { aheadOf, branchOf, commitOf, copyIncluded, currentBase, gitOut, gitRun, headOf, isDirty, topOf, verifiedRemote } from "./git.ts";
import { HeadMoved, WorktreeCreated, WorktreeRemoved } from "./record-types.ts";
import type { Worktree, WorktreeId } from "./record-types.ts";

const DAY_MS = 86_400_000;

/** Why a worktree action did not do what it was asked. */
export type WorktreeRefusalCode = "not-a-repo" | "unknown-base" | "occupied" | "dirty" | "ahead" | "live-session" | "orphan";

/**
 * A refusal of the git module: the code says which, the message says why. It is the caller's to
 * catch (a cleanup that finds a worktree changed since it looked keeps it and goes on), so it is not
 * a failed step.
 */
export class WorktreeRefusal extends CatchableError {
  override name = "WorktreeRefusal";
  override readonly code: WorktreeRefusalCode;

  constructor(code: WorktreeRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the journal says of one worktree. */
interface Entry {
  readonly worktree: Worktree;
  /** When it was made, from its record. */
  readonly at: number;
  readonly removed: boolean;
}

/** The worktrees the journal holds, by id, in the order they were made. */
function fold(journal: JournalReader | undefined): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (journal === undefined) return entries;
  for (const stored of journal.since(seq(0), [WorktreeCreated.name, WorktreeRemoved.name])) {
    if (stored.type === WorktreeCreated.name) {
      const parsed = WorktreeCreated.schema.safeParse(stored.data);
      if (parsed.success) entries.set(parsed.data.id, { worktree: parsed.data, at: stored.at, removed: false });
      continue;
    }
    const parsed = WorktreeRemoved.schema.safeParse(stored.data);
    const known = parsed.success ? entries.get(parsed.data.id) : undefined;
    if (parsed.success && known !== undefined) entries.set(parsed.data.id, { ...known, removed: true });
  }
  return entries;
}

/** The ids of worktrees: a worktree is born in the record that makes it. */
function worktreeIds(journal: () => JournalReader | undefined): IdIndex<"worktree"> {
  return new IdIndex("worktree", () => {
    const issued: IssuedId[] = [];
    for (const stored of journal()?.since(seq(0), [WorktreeCreated.name]) ?? []) {
      const parsed = WorktreeCreated.schema.safeParse(stored.data);
      if (parsed.success) issued.push({ id: parsed.data.id, seed: stored.id });
    }
    return issued;
  });
}

/** The record an action writes first: the seed of what it makes, the same when the step is made again. */
function birthOf(ctx: ActionContext): RecordId {
  return recordId(`${ctx.operationId}/emit/1`);
}

/** The path with its links resolved, when it exists. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}

/**
 * The niwa sessions alive in a directory, by their niwa ids, read from the sessions module's
 * records by name (the git module does not import it).
 *
 * A session is alive when it started in the directory (or below it), its last word is not that it
 * ended, and it said something since this host started: a session of an earlier host has no
 * process any more, as the processes of a host stop with it.
 */
function liveSessionsIn(journal: JournalReader | undefined, dir: string, bootedAt: number): string[] {
  if (journal === undefined) return [];
  const started = new Map<string, string>();
  for (const stored of journal.since(seq(0), ["session.started" as RecordTypeName])) {
    const data = stored.data as { session?: unknown; id?: unknown; cwd?: unknown };
    if (typeof data.cwd !== "string" || typeof data.id !== "string") continue;
    if (within(real(data.cwd), dir)) started.set(stableJson(data.session), data.id);
  }
  if (started.size === 0) return [];
  const last = new Map<string, StoredRecord>();
  for (const stored of journal.since(seq(0), SESSION_LIFE_TYPES.map((name) => name as RecordTypeName))) {
    const key = stableJson((stored.data as { session?: unknown }).session);
    if (started.has(key)) last.set(key, stored);
  }
  return [...started].flatMap(([key, id]) => {
    const latest = last.get(key);
    return latest !== undefined && latest.type !== "session.ended" && latest.at >= bootedAt ? [id] : [];
  });
}

/** The records of the sessions module that say a session is alive, or that it ended. */
const SESSION_LIFE_TYPES = [
  "session.started",
  "session.marked",
  "session.turn-started",
  "session.turn-ended",
  "session.activity",
  "session.ended",
] as const;

/** What the plugin knows to answer: the journal, the store and the moment the host started. */
interface Place {
  readonly journal: () => JournalReader | undefined;
  readonly store: () => string;
  readonly bootedAt: number;
}

/** How a worktree stands now: dirty, ahead of its base, the sessions alive in it, its head and the remote of its base. */
async function standing(
  place: Place,
  worktree: Worktree,
): Promise<Pick<WorktreeEntity, "dirty" | "aheadOfBase" | "sessions" | "head" | "remote">> {
  const present = existsSync(worktree.path);
  const dirty = present ? await isDirty(worktree.path) : false;
  const branch = await commitOf(worktree.repo, `refs/heads/${worktree.branch}`);
  // Ahead of the base as it is now: a base branch that took the commits makes them merged.
  const base = (await commitOf(worktree.repo, worktree.base)) === undefined ? worktree.baseSha : worktree.base;
  const aheadOfBase = branch === undefined ? 0 : await aheadOf(worktree.repo, base, worktree.branch);
  const sessions = present ? liveSessionsIn(place.journal(), real(worktree.path), place.bootedAt) : [];
  const head = present ? await headOf(worktree.path) : undefined;
  const remote = existsSync(worktree.repo) ? await verifiedRemote(worktree.repo, worktree.base) : undefined;
  return { dirty, aheadOfBase, sessions, ...(head === undefined ? {} : { head }), ...(remote === undefined ? {} : { remote }) };
}

/** The last head recorded for each worktree: the one its last `git.head.moved` names, else none. */
function recordedHeads(journal: JournalReader | undefined): Map<string, string> {
  const heads = new Map<string, string>();
  for (const stored of journal?.since(seq(0), [HeadMoved.name]) ?? []) {
    const parsed = HeadMoved.schema.safeParse(stored.data);
    if (parsed.success) heads.set(parsed.data.worktree, parsed.data.head);
  }
  return heads;
}

/** The directory a session was started in, by its ref, from the sessions module's records read by name. */
function cwdOfSession(journal: JournalReader | undefined, session: string): string | undefined {
  let cwd: string | undefined;
  for (const stored of journal?.since(seq(0), ["session.started" as RecordTypeName]) ?? []) {
    const data = stored.data as { session?: unknown; cwd?: unknown };
    if (data.session === session && typeof data.cwd === "string") cwd = data.cwd;
  }
  return cwd;
}

/** Why a worktree may not be removed, or undefined when it may. */
function refusalOf(id: string, state: Pick<WorktreeEntity, "dirty" | "aheadOfBase" | "sessions">): WorktreeRefusal | undefined {
  if (state.sessions.length > 0) {
    return new WorktreeRefusal("live-session", `the worktree "${id}" has a live session in it (${state.sessions.join(", ")})`);
  }
  if (state.dirty) return new WorktreeRefusal("dirty", `the worktree "${id}" has uncommitted changes`);
  if (state.aheadOfBase > 0) {
    return new WorktreeRefusal("ahead", `the worktree "${id}" has ${String(state.aheadOfBase)} commit(s) its base does not have`);
  }
  return undefined;
}

/** Remove the directory and the branch of a worktree; what is gone already stays gone. */
async function dismantle(repo: string, path: string, branch: string): Promise<void> {
  if (existsSync(path)) {
    const removed = existsSync(repo) ? await gitRun(repo, ["worktree", "remove", "--force", "--force", path]) : undefined;
    if (removed?.code !== 0) rmSync(path, { recursive: true, force: true });
  }
  if (!existsSync(repo)) return;
  await gitRun(repo, ["worktree", "prune"]);
  if ((await commitOf(repo, `refs/heads/${branch}`)) !== undefined) await gitOut(repo, ["branch", "-D", branch]);
}

/**
 * Make the checkout of a worktree, or take the one a create that was cut off made: the same path on
 * the same branch. A directory on another branch is not taken.
 */
async function checkout(repo: string, path: string, branch: string, baseSha: string): Promise<void> {
  if (existsSync(path)) {
    const on = await gitRun(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (on.code === 0 && on.stdout.trim() === branch && real((await gitOut(path, ["rev-parse", "--show-toplevel"])).trim()) === real(path)) return;
    throw new WorktreeRefusal("occupied", `${path} exists and is not the worktree of the branch "${branch}"`);
  }
  mkdirSync(dirname(path), { recursive: true });
  await gitRun(repo, ["worktree", "prune"]);
  const branchExists = (await commitOf(repo, `refs/heads/${branch}`)) !== undefined;
  await gitOut(repo, branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, baseSha]);
}

/** The timer of the cleanup, the one its script starts on. */
export const CLEANUP_TIMER = "git-worktree-cleanup";

/** The script of the cleanup, as it ships with the module. */
const CLEANUP_SCRIPT = fileURLToPath(new URL("./workflows/worktree-cleanup.ts", import.meta.url));

/** How the cleanup of old worktrees runs. */
export interface CleanupOptions {
  /** The time of day it runs, "HH:MM" in local time. Default: "04:00". */
  readonly daily?: string;
  /** How many days a worktree is kept before it may be removed. Default: 30. */
  readonly days?: number;
}

/** What the git module is given. */
export interface GitOptions {
  /** The daily cleanup of old worktrees, a built-in workflow: on unless it is `false`. */
  readonly cleanup?: CleanupOptions | false;
}

/** The git module. */
export function git(options: GitOptions = {}): Plugin {
  const bootedAt = Date.now();
  const cleanup = options.cleanup === false ? undefined : { daily: options.cleanup?.daily ?? "04:00", days: options.cleanup?.days ?? 30 };
  if (cleanup !== undefined && (!Number.isInteger(cleanup.days) || cleanup.days < 0)) {
    throw new TypeError(`git({ cleanup }): days is a whole number of days, not ${String(cleanup.days)}`);
  }

  return plugin("git", (api) => {
    // The cleanup is a workflow the module ships, on a timer it offers: the host lists neither.
    if (cleanup !== undefined) {
      api.offer(TIMER_OFFER, { id: CLEANUP_TIMER, daily: cleanup.daily, description: "The daily cleanup of old git worktrees" });
      api.offer(BUILTIN_WORKFLOW, {
        name: "worktree-cleanup",
        file: CLEANUP_SCRIPT,
        description: "Remove old worktrees that are clean, merged and unused",
        triggers: ["timer.fired"],
      });
      api.action(action(gitCleanupConfig, { recovery: "repeat", effect: "read", world: "niwa", run: () => ({ days: cleanup.days }) }));
    }

    const journal = () => api.journal?.();
    const ids = worktreeIds(journal);
    const place: Place = { journal, store: () => join(api.home(), "worktrees"), bootedAt };
    const entries = () => fold(journal());

    api.declare(WorktreeCreated, WorktreeRemoved, HeadMoved);

    api.action(
      action(gitWorktreeCreate, {
        // A create made again finds what it made: the id comes from the step, and the checkout of
        // that id is taken as it is.
        recovery: "repeat",
        effect: "write",
        world: "local",
        async run(input, ctx) {
          const id = ids.issue(birthOf(ctx));
          const known = entries().get(id);
          if (known !== undefined) return known.worktree;
          const top = await topOf(resolve(input.repo));
          if (top === undefined) throw new WorktreeRefusal("not-a-repo", `${input.repo} is not inside a git repository`);
          const repo = real(top);
          const base = input.base ?? (await currentBase(repo));
          const baseSha = await commitOf(repo, base);
          if (baseSha === undefined) throw new WorktreeRefusal("unknown-base", `"${base}" names no commit of ${repo}`);
          const path = join(real(api.home()), "worktrees", id);
          await checkout(repo, path, id, baseSha);
          await copyIncluded(repo, path);
          const worktree: Worktree = { id, description: input.description, repo, path, branch: id, base, baseSha };
          await ctx.emit(WorktreeCreated, worktree);
          return worktree;
        },
      }),
    );

    api.action(
      action(gitWorktreeList, {
        recovery: "repeat",
        effect: "read",
        world: "local",
        async run() {
          const live = [...entries().values()].filter((entry) => !entry.removed);
          const named = new Set<string>(live.map((entry) => entry.worktree.id));
          const now = Date.now();
          const recorded = await Promise.all(
            live.map(async ({ worktree, at }) => ({
              id: worktree.id,
              description: worktree.description,
              state: (existsSync(worktree.path) ? "ok" : "missing") satisfies WorktreeState,
              path: worktree.path,
              branch: worktree.branch,
              repo: worktree.repo,
              base: worktree.base,
              ageDays: Math.max(0, (now - at) / DAY_MS),
              ...(await standing(place, worktree)),
            })),
          );
          const orphans = orphanDirs(place.store()).filter((name) => !named.has(name)).map((name) => ({
            id: idSchema("worktree").parse(name),
            description: description("a directory no record names"),
            state: "orphan" satisfies WorktreeState,
            path: join(place.store(), name),
          }));
          return { items: [...recorded, ...orphans] };
        },
      }),
    );

    api.action(
      action(gitWorktreeGet, {
        recovery: "repeat",
        effect: "read",
        world: "local",
        async run(input) {
          const id = ids.require(input.id);
          const entry = entries().get(id);
          if (entry === undefined || entry.removed) throw new WorktreeRefusal("orphan", `the worktree "${id}" was removed`);
          return { ...entry.worktree, ...(await standing(place, entry.worktree)) };
        },
      }),
    );

    api.action(
      action(gitHeadObserve, {
        // A head recorded once is the last one known: looking again writes nothing for it.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        async run(input, ctx) {
          const only = input.worktree === undefined ? undefined : ids.require(input.worktree);
          const heads = recordedHeads(journal());
          const moved: Array<{ worktree: WorktreeId; head: string }> = [];
          for (const { worktree, removed } of entries().values()) {
            if (removed || (only !== undefined && worktree.id !== only) || !existsSync(worktree.path)) continue;
            const head = await headOf(worktree.path);
            const previous = heads.get(worktree.id) ?? worktree.baseSha;
            if (head === undefined || head === previous) continue;
            const branch = await branchOf(worktree.path);
            await ctx.emit(HeadMoved, {
              worktree: worktree.id,
              repo: worktree.repo,
              path: worktree.path,
              ...(branch === undefined ? {} : { branch }),
              head,
              previous,
              ...(input.session === undefined ? {} : { session: input.session }),
            });
            moved.push({ worktree: worktree.id, head });
          }
          return { moved };
        },
      }),
    );

    // The end of a session's turn is when its commits are seen: the worktrees it was started in are looked at, and a
    // head that moved is recorded for it. The sessions module is read by name, from when the module first serves.
    let firstServed: number | undefined;
    api.subscribers(() => {
      const reader = journal();
      if (reader === undefined) return [];
      firstServed ??= reader.last();
      const turns: Subscriber = {
        id: "head-on-turn-end",
        queries: [{ types: ["session.turn-ended"] }],
        from: firstServed,
        handler: async (data, step) => {
          const session = (data as { session?: unknown }).session;
          if (typeof session !== "string") return;
          const cwd = cwdOfSession(journal(), session);
          if (cwd === undefined) return;
          const at = real(cwd);
          for (const { worktree, removed } of entries().values()) {
            if (removed || !within(at, real(worktree.path))) continue;
            await step(gitHeadObserve, { worktree: worktree.id, session: session as SessionRef }, { key: `observe:${worktree.id}` });
          }
        },
      };
      return [turns];
    });

    /** Remove a recorded worktree: refused unless it may go or it is forced, then written. */
    const removeEntry = async (
      entry: Entry,
      force: boolean,
      emit: (data: { id: WorktreeId; forced: boolean }) => Promise<unknown>,
    ): Promise<void> => {
      const { worktree } = entry;
      const refusal = refusalOf(worktree.id, await standing(place, worktree));
      if (refusal !== undefined && !force) throw refusal;
      await dismantle(worktree.repo, worktree.path, worktree.branch);
      await emit({ id: idSchema("worktree").parse(worktree.id), forced: refusal !== undefined });
    };

    api.action(
      action(gitWorktreeRemove, {
        // Removing what is removed already is a no-op, so it may be made again.
        recovery: "repeat",
        effect: "write",
        world: "local", destructive: true,
        async run(input, ctx) {
          const force = input.force ?? false;
          const id = ids.resolve(input.id);
          const entry = id === undefined ? undefined : entries().get(id);
          if (entry !== undefined) {
            if (entry.removed) return { id: entry.worktree.id, removed: false };
            await removeEntry(entry, force, (data) => ctx.emit(WorktreeRemoved, data));
            return { id: entry.worktree.id, removed: true };
          }
          // A directory of the store that no record names.
          const orphan = idSchema("worktree").safeParse(input.id);
          const path = orphan.success ? join(place.store(), orphan.data) : undefined;
          if (!orphan.success || path === undefined || !existsSync(path)) return { id: input.id, removed: false };
          if (!force) throw new WorktreeRefusal("orphan", `${path} has no record, so nothing says what it holds: remove it with force`);
          const common = await gitRun(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
          const repo = common.code === 0 ? dirname(common.stdout.trim()) : path;
          await dismantle(repo, path, orphan.data);
          return { id: orphan.data, removed: true };
        },
      }),
    );

  });
}

/** A fixed description of the module's own. */
function description(text: string): EntityDescription {
  return EntityDescription.parse(text);
}

/** The directories of the store named like a worktree id. */
function orphanDirs(store: string): string[] {
  if (!existsSync(store)) return [];
  const pattern = idSchema("worktree");
  return readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.safeParse(entry.name).success)
    .map((entry) => entry.name);
}

export {
  SessionWorktree,
  gitCleanupConfig,
  gitHeadObserve,
  WorktreeRemote,
  WorktreeEntity,
  WorktreeOption,
  WorktreeState,
  gitWorktreeCreate,
  gitWorktreeGet,
  gitWorktreeList,
  gitWorktreeRemove,
} from "./actions.ts";
export type { WorktreeOptionGiven } from "./actions.ts";
export { CommitId, GIT_TYPES, HeadMoved, Worktree, WorktreeCreated, WorktreeId, WorktreeRemoved } from "./record-types.ts";
