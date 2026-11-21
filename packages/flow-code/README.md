# @niwa-labs/flow-code

Workflow helpers for work in a repository: worktrees, fork-and-select, review and fix loops, TDD, diagnosis, debugging, coverage, self-tests, implementation and integration.

```ts
import { inWorktree, reviewFix } from "@niwa-labs/flow-code";
```

Built on `@niwa-labs/flow` and on the git and proc modules' actions, called by name: worktrees with
`git.worktree.create`, `git.worktree.get` (the head of a worktree is read by the git module, not by a
command in the worktree) and `git.worktree.remove`, checks with `runCheck` of `@niwa-labs/proc/flow`
(re-exported here). A run that uses them needs those actions in its grant.

- `inWorktree` removes a worktree its block left clean and keeps one with commits; a block that
  throws leaves it as it is. `forkSelect` keeps the picked fork and removes the others; `forkRace`
  takes the first fork that passes and cancels the rest.
- The commit a helper reports is read from the worktree after the agent is done, never from the
  agent's answer, and changes left outside it are a blocking finding: a check must leave the
  worktree as it found it, or have its output ignored by git.
- `reviewFix`, `tddLoop`, `debugLoop` and `coverageLoop` return their last result and why they
  stopped; a check that does not pass is a blocking finding sent back to the author, and one that
  does not finish (timed out, cancelled) shows neither a failure nor a pass. A coverage measure that
  fails before the first round throws `MeasureFailed`.
- `reviewPanel` lists the reviewers that could not look in `failures`; with it empty the panel is
  complete.
- `diagnoseLoop`, `selfTest`, `implement` (`economy`, `race`, `quality`, `safe`)
  and `integrate`.
