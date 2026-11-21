/**
 * The records of the git module: a worktree was made, a worktree was removed, the head of a worktree moved.
 *
 * A worktree is a checkout of a repository on a branch of its own, in a directory niwa keeps
 * (`<home>/worktrees/<id>`), so an agent works beside the owner's checkout and not in it. The records
 * hold where the worktree is and what it was made from, never the content of a file.
 */

import { EntityDescription, SessionRefSchema, idSchema, record } from "@niwa-labs/core";
import type { Id } from "@niwa-labs/core";
import { z } from "zod";

/** The id of a worktree: `wt-3fa9c2`. Niwa issues it; the branch of the worktree has the same name. */
export const WorktreeId = idSchema("worktree");
export type WorktreeId = Id<"worktree">;

/** A full commit id. */
export const CommitId = z.string().regex(/^[0-9a-f]{40,64}$/, "a full commit id");

/** A worktree as it was made. */
export const Worktree = z.object({
  /** The id, which is also the name of its branch and of its directory. */
  id: WorktreeId,
  /** A few words a list shows. */
  description: EntityDescription,
  /** The top of the repository the worktree was made from. */
  repo: z.string().min(1),
  /** The directory of the worktree. */
  path: z.string().min(1),
  /** The branch the worktree is on: the id. */
  branch: z.string().min(1),
  /** What the worktree was made from: a branch name, or a commit when the repository's HEAD was detached. */
  base: z.string().min(1),
  /** The commit `base` named when the worktree was made. */
  baseSha: CommitId,
});
export type Worktree = z.infer<typeof Worktree>;

/** A worktree was made. */
export const WorktreeCreated = record("git.worktree.created", Worktree);

/** A worktree was removed: its directory and its branch are gone. */
export const WorktreeRemoved = record(
  "git.worktree.removed",
  z.object({
    id: WorktreeId,
    /** Whether it was removed past a refusal (dirty, ahead of its base, a live session in it). */
    forced: z.boolean(),
  }),
);

/**
 * The head of a worktree is on another commit than the last one recorded for it (its base commit, at first): work
 * was committed, or the checkout moved. It names the session whose turn ended when it was seen, when that is who
 * moved it; without one, the record is of whoever wrote it (the run that looked).
 */
export const HeadMoved = record(
  "git.head.moved",
  z.object({
    worktree: WorktreeId,
    /** The top of the repository the worktree was made from. */
    repo: z.string().min(1),
    /** The directory of the worktree. */
    path: z.string().min(1),
    /** The branch the head is on; absent when it is detached. */
    branch: z.string().min(1).optional(),
    head: CommitId,
    /** The commit recorded for it before. */
    previous: CommitId,
    /** The session, as `<harness> <native>`, whose turn ended in the worktree when the head was seen to move. */
    session: SessionRefSchema.optional(),
  }),
);

/** Every record type of the git module. */
export const GIT_TYPES = [WorktreeCreated, WorktreeRemoved, HeadMoved] as const;
