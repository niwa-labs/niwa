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
 *   dirty, ahead of its base (on its branch or on the head of its checkout), has a live session in it
 *   or cannot be read, unless forced; git's own refusal (a locked worktree) stands without force.
 * - **git.head.observe** records `git.head.moved` for each worktree whose head is on another commit
 *   than the last one recorded for it, and `git.remote.updated` for each whose verified remote is
 *   another than the last recorded. The module looks by itself when a session's turn ends in a
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
 * The id is issued from the record that reserves the worktree (its repository, base commit, branch and
 * directory, written before the checkout), so a replayed create finds what it made and makes the same.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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
import { aheadOf, branchOf, commitOf, commonDirOf, copyIncluded, currentBase, gitOut, gitRun, headOf, isDirty, repoOf, topOf, verifiedRemote } from "./git.ts";
import { registeredWorktree, verifyCheckout } from "./registration.ts";
export { registeredWorktree } from "./registration.ts";
import { CheckoutVerified, HeadMoved, RemoteUpdated, WorktreeCreated, WorktreeRemote, WorktreeRemovalClaimed, WorktreeRemoved, WorktreeReserved } from "./record-types.ts";
import type { RemovalMatch, Worktree, WorktreeId } from "./record-types.ts";

const DAY_MS = 86_400_000;

/** Why a worktree action did not do what it was asked. */
export type WorktreeRefusalCode =
  | "not-a-repo"
  | "unknown-base"
  | "occupied"
  | "dirty"
  | "ahead"
  | "live-session"
  | "orphan"
  | "unverifiable"
  | "changed";

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

/** A worktree id comes from its first record, which may be a creation without a reservation. */
function worktreeIds(journal: () => JournalReader | undefined): IdIndex<"worktree"> {
  return new IdIndex("worktree", () => {
    const issued = new Map<string, IssuedId>();
    for (const stored of journal()?.since(seq(0), [WorktreeReserved.name, WorktreeCreated.name]) ?? []) {
      const parsed = WorktreeCreated.schema.safeParse(stored.data);
      if (parsed.success && !issued.has(parsed.data.id)) issued.set(parsed.data.id, { id: parsed.data.id, seed: stored.id });
    }
    return [...issued.values()];
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

/** How a worktree stands, as the list and a get show it. */
type Standing = Pick<WorktreeEntity, "dirty" | "aheadOfBase" | "sessions" | "head" | "remote">;

/** How a worktree stands, and what removing it would need to know. */
interface Inspected {
  readonly standing: Standing;
  readonly repo: string | undefined;
  /** The commit its branch is on, when it has one. */
  readonly tip: string | undefined;
  /** Whether what was read can be trusted: the repository and the checkout answered. What cannot be read is not known to be clean. */
  readonly sound: boolean;
}

/**
 * How a worktree stands now: dirty, ahead of its base, the sessions alive in it, its head and the remote of its base.
 *
 * Ahead counts what is reachable from the branch and from the head of the checkout, so work committed after
 * detaching the head is not lost with the branch.
 */
async function inspect(place: Place, worktree: Worktree): Promise<Inspected> {
  const present = existsSync(worktree.path);
  // A record can name a linked source checkout that went away. Recover the owner from the
  // surviving checkout so its refs can still be inspected and updated after it is removed.
  const owner = existsSync(worktree.repo) ? worktree.repo : await repoOf(worktree.path);
  const repo = owner === real(worktree.path) ? undefined : owner;
  let sound = repo !== undefined && (await commonDirOf(repo)) !== undefined;
  let dirty = false;
  let head: string | undefined;
  let tip: string | undefined;
  let aheadOfBase = 0;
  let remote: Awaited<ReturnType<typeof verifiedRemote>>;
  try {
    if (present) {
      dirty = await isDirty(worktree.path);
      head = await headOf(worktree.path);
      if (head === undefined) sound = false;
    }
    if (repo !== undefined) {
      tip = await commitOf(repo, `refs/heads/${worktree.branch}`);
      // Ahead of the base as it is now: a base branch that took the commits makes them merged.
      const base = (await commitOf(repo, worktree.base)) === undefined ? worktree.baseSha : worktree.base;
      const tips = [...new Set([tip, head].filter((commit): commit is string => commit !== undefined))];
      aheadOfBase = tips.length === 0 ? 0 : await aheadOf(repo, base, tips);
      remote = await verifiedRemote(repo, worktree.base);
    }
  } catch {
    sound = false;
  }
  const sessions = present ? liveSessionsIn(place.journal(), real(worktree.path), place.bootedAt) : [];
  return {
    standing: { dirty, aheadOfBase, sessions, ...(head === undefined ? {} : { head }), ...(remote === undefined ? {} : { remote }) },
    repo,
    tip,
    sound,
  };
}

const standing = async (place: Place, worktree: Worktree): Promise<Standing> => (await inspect(place, worktree)).standing;

/** The last head recorded for each worktree: the one its last `git.head.moved` names, else none. */
function recordedHeads(journal: JournalReader | undefined): Map<string, string> {
  const heads = new Map<string, string>();
  for (const stored of journal?.since(seq(0), [HeadMoved.name]) ?? []) {
    const parsed = HeadMoved.schema.safeParse(stored.data);
    if (parsed.success) heads.set(parsed.data.worktree, parsed.data.head);
  }
  return heads;
}

/** The last verified remote recorded for each worktree: absent for one whose last record says there is none. */
function recordedRemotes(journal: JournalReader | undefined): Map<string, WorktreeRemote> {
  const remotes = new Map<string, WorktreeRemote>();
  for (const stored of journal?.since(seq(0), [RemoteUpdated.name]) ?? []) {
    const parsed = RemoteUpdated.schema.safeParse(stored.data);
    if (!parsed.success) continue;
    if (parsed.data.remote === undefined) remotes.delete(parsed.data.worktree);
    else remotes.set(parsed.data.worktree, parsed.data.remote);
  }
  return remotes;
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
function refusalOf(id: string, inspected: Inspected): WorktreeRefusal | undefined {
  const state = inspected.standing;
  if (state.sessions.length > 0) {
    return new WorktreeRefusal("live-session", `the worktree "${id}" has a live session in it (${state.sessions.join(", ")})`);
  }
  if (!inspected.sound) {
    return new WorktreeRefusal("unverifiable", `the worktree "${id}" and its repository cannot both be read, so nothing says what would be lost`);
  }
  if (state.dirty) return new WorktreeRefusal("dirty", `the worktree "${id}" has uncommitted changes`);
  if (state.aheadOfBase > 0) {
    return new WorktreeRefusal("ahead", `the worktree "${id}" has ${String(state.aheadOfBase)} commit(s) its base does not have`);
  }
  return undefined;
}

/** What is removed with a worktree: where its repository is, if it is anywhere, its directory and its branch. */
interface Dismantled {
  readonly repo: string | undefined;
  readonly path: string;
  readonly branch: string;
}

/** The worktree paths and refs Git still has registered, including locked or missing checkouts. */
async function registeredWorktrees(repo: string): Promise<Array<{ path: string; ref: string | undefined }>> {
  const listed = await gitRun(repo, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) {
    throw new WorktreeRefusal("unverifiable", `git could not list the worktrees of ${repo}: ${listed.stderr.trim()}`);
  }
  return listed.stdout.split("\0\0").flatMap((row) => {
    const [worktree, ...details] = row.split("\0");
    if (!worktree?.startsWith("worktree ")) return [];
    return [{ path: worktree.slice("worktree ".length), ref: details.find((field) => field.startsWith("branch "))?.slice("branch ".length) }];
  });
}

/** An update-ref can delete a branch in use, so check the other worktrees first. */
function keepCheckedOutBranch(worktrees: Awaited<ReturnType<typeof registeredWorktrees>>, branch: string, except?: string): void {
  const other = worktrees.find((worktree) => worktree.ref === `refs/heads/${branch}` &&
    (except === undefined || real(worktree.path) !== real(except)));
  if (other !== undefined) {
    throw new WorktreeRefusal("changed", `the branch "${branch}" is checked out at ${other.path}`);
  }
}

/**
 * Remove the directory and the branch of a worktree; what is gone already stays gone.
 *
 * Without `force`, git decides whether the directory may go (it keeps a dirty or locked one), and the branch goes
 * only if it is still on the commit that was checked. Force may remove an orphaned directory without
 * a readable checkout. Either way, what was asked to go is checked to be gone before this returns.
 */
async function dismantle(target: Dismantled, force: boolean, seen?: Inspected): Promise<void> {
  const { repo, path, branch } = target;
  const known = repo !== undefined && existsSync(repo);
  const checkouts = known ? await registeredWorktrees(repo) : [];
  const present = existsSync(path);
  const atPath = (worktree: { path: string }): boolean => real(worktree.path) === real(path);
  keepCheckedOutBranch(checkouts, branch, path);
  if (present || checkouts.some(atPath)) {
    const common = present ? await commonDirOf(path) : undefined;
    if (common !== undefined && (!known || common !== (await commonDirOf(repo)))) {
      throw new WorktreeRefusal("changed", `${path} belongs to another repository`);
    }
    if (!force && present && (await headOf(path)) !== seen?.standing.head) {
      throw new WorktreeRefusal("changed", `the HEAD of ${path} moved while the worktree was being removed`);
    }
    const removed = known ? await gitRun(repo, ["worktree", "remove", ...(force ? ["--force", "--force"] : []), path]) : undefined;
    if (removed?.code !== 0) {
      if (!force || common !== undefined || (known && (await registeredWorktrees(repo)).some(atPath)) ||
        (await commonDirOf(path)) !== undefined) {
        throw new WorktreeRefusal("changed", `git keeps ${path}: ${removed?.stderr.trim() ?? "its repository cannot be read"}`);
      }
      rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(path)) throw new Error(`${path} is still there after it was removed`);
  }
  if (!known) return;
  const now = await commitOf(repo, `refs/heads/${branch}`);
  if (now === undefined) return;
  if (!force && now !== seen?.tip) {
    throw new WorktreeRefusal("changed", `the branch "${branch}" moved while the worktree was being removed, and is kept`);
  }
  keepCheckedOutBranch(await registeredWorktrees(repo), branch);
  const deleted = await gitRun(repo, ["update-ref", "-d", `refs/heads/${branch}`, now]);
  if (deleted.code !== 0) throw new WorktreeRefusal("changed", `git keeps the branch "${branch}": ${deleted.stderr.trim()}`);
  if ((await commitOf(repo, `refs/heads/${branch}`)) !== undefined) throw new Error(`the branch "${branch}" is still there after it was removed`);
}

/**
 * Make the checkout of a worktree from its reservation, or take the one a create that was cut off made: the same
 * path, on the same branch and base commit, of the same repository.
 */
async function checkout(reserved: Worktree, retry: boolean): Promise<void> {
  const { repo, path, branch, baseSha } = reserved;
  if (existsSync(path)) {
    const top = await topOf(path);
    const common = await commonDirOf(repo);
    if (retry && common !== undefined && top !== undefined && real(top) === real(path) &&
      (await commonDirOf(path)) === common && (await branchOf(path)) === branch && (await headOf(path)) === baseSha) return;
    throw new WorktreeRefusal("occupied", `${path} exists and is not the worktree of the branch "${branch}" of ${repo}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  await gitRun(repo, ["worktree", "prune"]);
  if ((await commitOf(repo, `refs/heads/${branch}`)) !== undefined) {
    throw new WorktreeRefusal("occupied", `the branch "${branch}" already exists`);
  }
  await gitOut(repo, ["worktree", "add", "-b", branch, path, baseSha]);
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

    api.declare(CheckoutVerified, WorktreeReserved, WorktreeCreated, WorktreeRemovalClaimed, WorktreeRemoved, HeadMoved, RemoteUpdated);

    api.action(
      action(gitWorktreeCreate, {
        // A create made again finds what it made: the id comes from the step, and the checkout of
        // that id is taken as it is.
        recovery: "repeat",
        effect: "write",
        world: "local",
        async run(input, ctx) {
          const birth = birthOf(ctx);
          const id = ids.issue(birth);
          const known = entries().get(id);
          if (known !== undefined) return known.worktree;
          // What an earlier attempt reserved is what this one makes: the base is not read again.
          const earlier = journal()?.get(birth);
          let reserved: ReturnType<typeof WorktreeReserved.schema.parse>;
          if (earlier === undefined) {
            const top = await topOf(resolve(input.repo));
            if (top === undefined) throw new WorktreeRefusal("not-a-repo", `${input.repo} is not inside a git repository`);
            const source = real(top);
            const repo = real((await repoOf(source)) ?? source);
            const base = input.base ?? (await currentBase(source));
            const baseSha = await commitOf(source, base);
            if (baseSha === undefined) throw new WorktreeRefusal("unknown-base", `"${base}" names no commit of ${repo}`);
            const path = join(real(api.home()), "worktrees", id);
            reserved = { id, description: input.description, repo, path, branch: id, base, baseSha, ...(repo === source ? {} : { source }) };
          } else {
            reserved = WorktreeReserved.schema.parse(earlier.data);
            const top = await topOf(resolve(input.repo));
            if (top === undefined || reserved.id !== id || reserved.branch !== id ||
                reserved.path !== join(real(api.home()), "worktrees", id) ||
                reserved.repo !== real((await repoOf(real(top))) ?? top) ||
                (reserved.source ?? reserved.repo) !== real(top)) {
              throw new WorktreeRefusal("changed", "the reserved checkout differs from the requested repository");
            }
          }
          await ctx.emit(WorktreeReserved, reserved);
          const { source, ...worktree } = reserved;
          await checkout(worktree, earlier !== undefined);
          await copyIncluded(source ?? worktree.repo, worktree.path);
          await verifyCheckout(api, worktree, `${ctx.operationId}/emit/2`);
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

    // Observations and removals of a worktree read its state and record their result one at a time.
    const turns = new Map<string, Promise<unknown>>();
    const worktreeTurn = async <T>(worktree: string, act: () => Promise<T>): Promise<T> => {
      const turn = (turns.get(worktree) ?? Promise.resolve()).then(act);
      const done = turn.catch(() => undefined);
      turns.set(worktree, done);
      try {
        return await turn;
      } finally {
        if (turns.get(worktree) === done) turns.delete(worktree);
      }
    };

    api.action(
      action(gitHeadObserve, {
        // What is recorded is the last one known: looking again writes nothing new, and a look cut off is made
        // again by writing what it wrote under the same identity, then going on.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        async run(input, ctx) {
          const only = input.worktree === undefined ? undefined : ids.require(input.worktree);
          const moved: Array<{ worktree: WorktreeId; head: string }> = [];
          // The records are numbered in the order they are written: an attempt that was cut off wrote the first
          // ones, and they are written again as they were, so the new ones follow them and are not taken for them.
          for (let ordinal = 1; ; ordinal += 1) {
            const written = journal()?.get(recordId(`${ctx.operationId}/emit/${String(ordinal)}`));
            if (written === undefined) break;
            if (written.type === RemoteUpdated.name) {
              await ctx.emit(RemoteUpdated, RemoteUpdated.schema.parse(written.data));
              continue;
            }
            const head = HeadMoved.schema.parse(written.data);
            await ctx.emit(HeadMoved, head);
            moved.push({ worktree: head.worktree, head: head.head });
          }
          for (const { worktree, removed } of entries().values()) {
            if (removed || (only !== undefined && worktree.id !== only)) continue;
            await worktreeTurn(worktree.id, async () => {
              if (!existsSync(worktree.path)) return;
              const head = await headOf(worktree.path);
              const previous = recordedHeads(journal()).get(worktree.id) ?? worktree.baseSha;
              if (head !== undefined && head !== previous) {
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
              const remote = existsSync(worktree.repo) ? await verifiedRemote(worktree.repo, worktree.base) : undefined;
              const recorded = recordedRemotes(journal()).get(worktree.id);
              if (stableJson(remote ?? null) !== stableJson(recorded ?? null)) {
                await ctx.emit(RemoteUpdated, { worktree: worktree.id, repo: worktree.repo, ...(remote === undefined ? {} : { remote }) });
              }
            });
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
      const seen = await inspect(place, worktree);
      const refusal = refusalOf(worktree.id, seen);
      if (refusal !== undefined && !force) throw refusal;
      await dismantle({ ...worktree, repo: seen.repo }, force, seen);
      await emit({ id: idSchema("worktree").parse(worktree.id), forced: refusal !== undefined });
    };

    /** Remove the expected checkout without deleting the branch or any reachable commits. */
    const removeMatchingCheckout = async (worktree: Worktree, onlyIf: RemovalMatch, ctx: ActionContext): Promise<void> => {
      const { id, repo, branch, path } = worktree;
      if (repo !== onlyIf.repo || branch !== onlyIf.branch || path !== onlyIf.path) {
        throw new WorktreeRefusal("changed", `the worktree "${id}" no longer matches the saved checkout`);
      }
      const prior = journal()?.get(birthOf(ctx));
      const resumed = prior?.type === WorktreeRemovalClaimed.name;
      const checkouts = await registeredWorktrees(repo);
      const registration = checkouts.find((checkout) => checkout.path === path);
      if (!resumed || registration !== undefined || existsSync(path)) {
        if (registration?.ref !== `refs/heads/${branch}` || registeredWorktree(api, path)?.id !== id) {
          throw new WorktreeRefusal("changed", `the registered checkout "${id}" is missing, replaced, or on another branch`);
        }
      }
      await ctx.emit(WorktreeRemovalClaimed, { id, onlyIf });
      if (registration !== undefined || existsSync(path)) {
        const remote = await verifiedRemote(repo, worktree.base);
        if (remote?.host !== onlyIf.project.host || remote.path !== onlyIf.project.path) {
          throw new WorktreeRefusal("changed", `the worktree "${id}" no longer points to the saved forge project`);
        }
        // Git checks its lock and ordinary changes itself. Include ignored files here as Git's removal
        // test does not protect them and this checkout may contain local-only files.
        const status = await gitRun(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
        if (status.code !== 0) throw new WorktreeRefusal("unverifiable", `cannot read worktree "${id}": ${status.stderr.trim()}`);
        if (status.stdout !== "") throw new WorktreeRefusal("dirty", `the worktree "${id}" has local files or changes`);
        if ((await branchOf(path)) !== branch || (await headOf(path)) !== onlyIf.head || registeredWorktree(api, path)?.id !== id) {
          throw new WorktreeRefusal("changed", `the worktree "${id}" moved after its pull request was registered`);
        }
        const sessions = liveSessionsIn(journal(), path, place.bootedAt);
        if (sessions.length > 0) throw new WorktreeRefusal("live-session", `the worktree "${id}" has a live session in it (${sessions.join(", ")})`);
        const removed = await gitRun(repo, ["worktree", "remove", "--", path]);
        if (removed.code !== 0) throw new WorktreeRefusal("changed", `git keeps ${path}: ${removed.stderr.trim()}`);
      }
      if (existsSync(path)) throw new WorktreeRefusal("changed", `the worktree "${id}" is still present`);
      await ctx.emit(WorktreeRemoved, { id, forced: false, branchKept: true });
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
          return worktreeTurn(id ?? input.id, async () => {
            const entry = id === undefined ? undefined : entries().get(id);
            if (input.onlyIf !== undefined) {
              if (entry === undefined || input.id !== entry.worktree.id) return { id: input.id, removed: false };
              if (entry.removed) {
                const outcome = journal()?.get(recordId(`${ctx.operationId}/emit/2`));
                return { id: entry.worktree.id, removed: outcome?.type === WorktreeRemoved.name };
              }
              await removeMatchingCheckout(entry.worktree, input.onlyIf, ctx);
              return { id: entry.worktree.id, removed: true };
            }
            if (entry !== undefined && !entry.removed) {
              await removeEntry(entry, force, (data) => ctx.emit(WorktreeRemoved, data));
              return { id: entry.worktree.id, removed: true };
            }
            // A directory of the store that no record names, or that took the place of a worktree that was removed.
            const orphan = entry === undefined ? idSchema("worktree").safeParse(input.id) : idSchema("worktree").safeParse(entry.worktree.id);
            const path = orphan.success ? join(place.store(), orphan.data) : undefined;
            if (!orphan.success || path === undefined || !existsSync(path)) return { id: orphan.success ? orphan.data : input.id, removed: false };
            if (!force) throw new WorktreeRefusal("orphan", `${path} has no record, so nothing says what it holds: remove it with force`);
            const common = await commonDirOf(path);
            const repo = common === undefined ? undefined : basename(common) === ".git" ? dirname(common) : undefined;
            await dismantle({ repo, path, branch: orphan.data }, true);
            return { id: orphan.data, removed: true };
          });
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
  WorktreeEntity,
  WorktreeOption,
  WorktreeState,
  gitWorktreeCreate,
  gitWorktreeGet,
  gitWorktreeList,
  gitWorktreeRemove,
} from "./actions.ts";
export type { WorktreeOptionGiven } from "./actions.ts";
export {
  CommitId,
  GIT_TYPES,
  HeadMoved,
  RemoteUpdated,
  Worktree,
  WorktreeCreated,
  WorktreeId,
  WorktreeRemote,
  WorktreeRemovalClaimed,
  WorktreeRemoved,
  WorktreeReserved,
} from "./record-types.ts";
