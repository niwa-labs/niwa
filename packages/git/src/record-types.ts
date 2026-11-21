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

/**
 * What a worktree is going to be made from, written before its checkout is: a create cut off after the checkout
 * and made again takes the checkout it made from the same repository, base commit, branch and directory, not from
 * what the base is by then. The id of the worktree is issued from this record.
 */
export const WorktreeReserved = record(
  "git.worktree.reserved",
  Worktree.extend({
    /** The checkout asked for, when it differs from the repository that owns it. */
    source: z.string().min(1).optional(),
  }),
);

/** A worktree was made. */
export const WorktreeCreated = record("git.worktree.created", Worktree);

export const WorktreeCoordinates = Worktree.pick({id: true, path: true, repo: true});

/** The git plugin attests the checkout as the host before publishing its creation. */
export const CheckoutVerified = record("git.worktree.verified", WorktreeCoordinates.extend({
  creation: z.string().min(1),
  directories: z.array(z.string()).length(3),
}));

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

/**
 * The remote a worktree's work goes to, as the repository's own configuration says it: the remote a push of its
 * base goes to. It is shown only when it is verified: the remote is configured, its fetch and push URLs name the
 * same project, and that project is on a server (`host`, lower case, no port) at a path of at least a group and a
 * name, without `.git`. A remote on this machine, or one that pushes elsewhere, is not shown.
 */
export const WorktreeRemote = z.object({
  /** The name of the remote in the repository. */
  name: z.string().min(1),
  host: z.string().min(1),
  path: z.string().min(1),
});
export type WorktreeRemote = z.infer<typeof WorktreeRemote>;

/**
 * The verified remote of a worktree is another than the last one recorded for it (none, at first): it was set, it
 * changed, or it is gone or no longer verifies. The project it names is by path; which project that is on the
 * server is for the module that talks to the server.
 */
export const RemoteUpdated = record(
  "git.remote.updated",
  z.object({
    worktree: WorktreeId,
    /** The top of the repository the worktree was made from. */
    repo: z.string().min(1),
    /** The remote now; absent when there is none that verifies. */
    remote: WorktreeRemote.optional(),
  }),
);

/** Every record type of the git module. */
export const GIT_TYPES = [WorktreeReserved, CheckoutVerified, WorktreeCreated, WorktreeRemoved, HeadMoved, RemoteUpdated] as const;
