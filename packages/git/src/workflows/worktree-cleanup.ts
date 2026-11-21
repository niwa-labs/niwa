// The cleanup of old worktrees, a built-in workflow of the git module: every day, on
// the timer the module offers, it lists the worktrees and removes the ones older than the days of `git({ cleanup })`
// that are clean, have no commit their base lacks and no live session in them. A dirty or unmerged worktree is never
// touched; removing it is the owner's (`git.worktree.remove` with `force`).
//
// The workflow module registers and installs it when the host starts; its runs hold `uses` and nothing more.

import type { ScriptApi } from "@niwa-labs/script";

declare const niwa: ScriptApi["niwa"];
declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];

/** One worktree as `git.worktree.list` shows it. */
interface Listed {
  id: string;
  state: "ok" | "missing" | "orphan";
  ageDays?: number;
  dirty?: boolean;
  aheadOfBase?: number;
  sessions?: string[];
}

export default workflow(
  {
    on: [{ type: "timer.fired", filter: { timer: "git-worktree-cleanup" } }],
    uses: ["git.cleanup.config", "git.worktree.list", "git.worktree.remove"],
    output: z.array(z.string()),
  },
  async () => {
    const { days } = await niwa.git.cleanup.config({}, { label: "config" });
    const { items } = (await niwa.git.worktree.list({}, { label: "list" })) as { items: Listed[] };
    const old = items.filter(
      (item) =>
        item.state === "ok" &&
        (item.ageDays ?? 0) >= days &&
        item.dirty === false &&
        item.aheadOfBase === 0 &&
        item.sessions?.length === 0,
    );
    const removed: string[] = [];
    for (const item of old) {
      // Removed without force: one that changed since the list is refused, and kept.
      try {
        await niwa.git.worktree.remove({ id: item.id }, { label: `remove-${item.id}` });
        removed.push(item.id);
      } catch (error) {
        // A refusal keeps it: it is not clean any more, or a session started in it. Anything else is a failure.
        if (!(error instanceof Error) || error.name !== "WorktreeRefusal") throw error;
      }
    }
    return removed;
  },
);
