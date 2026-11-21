/**
 * The actions of the git module, as typed references.
 *
 * The module's factory builds its real actions from the same references, so the schemas here are
 * the ones the host checks against. `WorktreeOption` is what `session.start` and `agent()` take as
 * `worktree`: the sugar that makes a worktree and starts the session in it.
 */

import { z } from "zod";

import { EntityDescription, SessionRefSchema, actionRef, getRef, listRef } from "@niwa-labs/core";

import { CommitId, Worktree, WorktreeId, WorktreeRemote } from "./record-types.ts";

/** What a worktree is made from, as `session.start` and `agent()` take it: `true`, or the parts to choose. */
export const WorktreeOption = z.union([
  z.literal(true),
  z.strictObject({
    /** The repository: any directory inside it. Default: the session's cwd, else the host's directory. */
    repo: z.string().min(1).optional(),
    /** The branch or commit to start from. Default: the repository's current branch (its commit when HEAD is detached). */
    base: z.string().min(1).optional(),
    description: EntityDescription.optional(),
  }),
]);
export type WorktreeOption = z.infer<typeof WorktreeOption>;
export type WorktreeOptionGiven = z.input<typeof WorktreeOption>;

/** The worktree a session runs in, as `session.start` answers it. */
export const SessionWorktree = Worktree.pick({ id: true, path: true, branch: true });
export type SessionWorktree = z.infer<typeof SessionWorktree>;

export const gitWorktreeCreate = actionRef("git.worktree.create", {
  description:
    "Make a git worktree: a checkout of `repo` (any directory inside it) on a new branch named like its id, in a directory niwa keeps. " +
    "`base` is the branch or commit to start from; without it, the repository's current branch (its commit when HEAD is detached). " +
    "The ignored files that `<repo>/.worktreeinclude` lists (gitignore syntax) are copied in. Niwa never merges: the branch is the result.",
  input: z.strictObject({
    repo: z.string().min(1),
    base: z.string().min(1).optional(),
    description: EntityDescription,
  }),
  output: Worktree,
});

/** Where a worktree in the list stands: as recorded, its directory gone, or a directory with no record. */
export const WorktreeState = z.enum(["ok", "missing", "orphan"]);
export type WorktreeState = z.infer<typeof WorktreeState>;

export const gitWorktreeList = listRef("git.worktree.list", {
  kind: "worktree",
  noun: "git worktree",
  detail:
    "Each recorded one shows its age in days and how it stands now (dirty, commits ahead of its base, live sessions), which is what a cleanup reads, " +
    "its head commit, and the remote a push of its base goes to (`host` and `path` of the project) when the repository's configuration verifies one. " +
    "`state` flags the odd ones: `missing` is a worktree whose directory is gone, `orphan` a directory in niwa's store that no record names.",
  item: {
    state: WorktreeState,
    path: z.string().min(1),
    branch: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
    /** Days since it was made; absent for an orphan. */
    ageDays: z.number().nonnegative().optional(),
    /** How it stands now, as `git.worktree.get` says; absent for an orphan. */
    dirty: z.boolean().optional(),
    aheadOfBase: z.number().int().nonnegative().optional(),
    sessions: z.array(z.string()).optional(),
    /** The commit its head is on now; absent for an orphan and a worktree whose directory is gone. */
    head: CommitId.optional(),
    /** The verified remote of its base; absent when none is. */
    remote: WorktreeRemote.optional(),
  },
});

/** One worktree as `git.worktree.get` shows it: as made, and how it stands now. */
export const WorktreeEntity = Worktree.extend({
  /** Uncommitted changes or untracked files (ignored files do not count). */
  dirty: z.boolean(),
  /** The commits on its branch that its base does not have. */
  aheadOfBase: z.number().int().nonnegative(),
  /** The niwa sessions alive in it now. */
  sessions: z.array(z.string()),
  /** The commit its head is on now; absent when its directory is gone. */
  head: CommitId.optional(),
  /** The verified remote of its base; absent when none is. */
  remote: WorktreeRemote.optional(),
});
export type WorktreeEntity = z.infer<typeof WorktreeEntity>;

export const gitWorktreeGet = getRef("git.worktree.get", {
  kind: "worktree",
  noun: "git worktree",
  detail: "It shows what the worktree was made from and how it stands: dirty, commits ahead of its base, the live sessions in it, its head and the verified remote of its base.",
  entity: WorktreeEntity,
});

export const gitWorktreeRemove = actionRef("git.worktree.remove", {
  description:
    "Remove a git worktree: its directory and its branch. It is refused when the worktree is dirty, has commits its base does not have " +
    "(on its branch or on the head of its checkout), a live niwa session runs in it, or it cannot be read, unless `force`; " +
    "git's own refusals (a locked worktree) stand without it. An orphan directory (no record, or one that took the place of a removed worktree) " +
    "is removed only with `force`. A worktree that is gone already is a no-op.",
  input: z.strictObject({ id: z.string().min(1), force: z.boolean().optional() }),
  output: z.object({ id: z.string().min(1), removed: z.boolean() }),
});

export const gitHeadObserve = actionRef("git.head.observe", {
  description:
    "Look at the heads of the worktrees niwa keeps (or of `worktree` alone) and record `git.head.moved` for each that is on another commit than " +
    "the last one recorded for it, and `git.remote.updated` for each whose verified remote is another than the last one recorded for it. " +
    "`session` names the session, as `<harness> <native>`, that moved them; without it the record is of the caller. " +
    "A head that has not moved is not recorded again. The module looks by itself when a session's turn ends in a worktree.",
  input: z.strictObject({ worktree: z.string().min(1).optional(), session: SessionRefSchema.optional() }),
  output: z.object({ moved: z.array(z.object({ worktree: WorktreeId, head: CommitId })) }),
});

export const gitCleanupConfig = actionRef("git.cleanup.config", {
  description: "How the built-in cleanup of old worktrees is set: how many days a worktree is kept before it may be removed.",
  input: z.object({}),
  output: z.object({ days: z.number().int().min(0) }),
});
