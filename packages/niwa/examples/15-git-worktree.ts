// An agent that works in a git worktree of its own, beside your checkout: the git module makes the
// worktree (branch `wt-<hex>`, directory `<home>/worktrees/<id>`), the session runs in it, and niwa
// never merges. When the call ends with the worktree clean and no new commit, it is removed; when the
// agent changed something, the answer says where (`worktree: { id, path, branch, changed }`) and the
// branch is yours to merge or drop (`git.worktree.remove`, with `force` when it holds work).
//
// The host installs `git()` beside `sessions(...)` and `workflow(...)` (see 01-my-harness.ts). The
// ignored files `<repo>/.worktreeinclude` lists (gitignore syntax, such as `.env`) are copied in.
//
//   niwa workflow.start --file examples/15-git-worktree.ts --args '{"repo":"/path/to/repo"}'

import type { ScriptApi } from "@niwa-labs/script";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const agent: ScriptApi["agent"];

export default workflow(
  {
    description: "Fix the failing test in a worktree of its own.",
    input: z.object({ repo: z.string() }),
    output: z.string(),
  },
  async ({ repo }) => {
    const fix = await agent("Run the tests, fix the one that fails and commit the fix.", {
      harness: "claude-personal",
      worktree: { repo, description: "fix the failing test" },
    });
    return fix.worktree === undefined ? "nothing to change" : `the fix is on ${fix.worktree.branch} in ${fix.worktree.path}`;
  },
);
