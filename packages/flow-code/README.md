# @niwa-labs/flow-code

Workflow helpers for work in a repository: worktrees, fork-and-select, review and fix loops, TDD, diagnosis, debugging, coverage, self-tests, implementation and integration.

```ts
import { inWorktree, reviewFix } from "@niwa-labs/flow-code";
```

Built on `@niwa-labs/flow` and on the git and proc modules' actions, called by name: worktrees with
`git.worktree.create` and `git.worktree.remove`, checks with `runCheck` of `@niwa-labs/proc/flow`
(re-exported here). A run that uses them needs those actions in its grant.

- `inWorktree` removes a worktree its block left clean and keeps one with commits; a block that
  throws leaves it as it is. `forkSelect` keeps the picked fork and removes the others.
- `reviewFix`, `tddLoop`, `debugLoop` and `coverageLoop` return their last result and why they
  stopped; a check that does not pass is a blocking finding sent back to the author.
- `diagnoseLoop`, `reviewPanel`, `selfTest`, `implement` (`economy`, `race`, `quality`, `safe`)
  and `integrate`.
