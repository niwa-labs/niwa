// Workflow helpers for work in a repository: worktrees, forks, review and fix, test first,
// diagnosis, debugging, coverage, self-tests, implementation and integration. Each runs inside a
// script, on its globals, and opens a scope named by the key it is given.

export { forkRace, forkSelect, headOf, inWorktree, makeWorktree, removeWorktree, seatIn, stateOf } from "./worktree.ts";
export type { Worktree } from "./worktree.ts";
export { checkFailed, commitBy, findingsText, reviewFix, reviewPanel, reviewSubject, uncommitted } from "./review.ts";
export { MeasureFailed, coverageLoop, coverageOf, debugLoop, diagnoseLoop, tddLoop } from "./loops.ts";
export type { Hypothesis } from "./loops.ts";
export { ImplementStopped, implement, integrate, selfTest, selfTestVerdict } from "./build.ts";
export type { ImplementMode, ScenarioStatus } from "./build.ts";
export { runCheck } from "@niwa-labs/proc/flow";
export type { ArtifactRef, Check, CheckResult } from "@niwa-labs/proc/flow";
