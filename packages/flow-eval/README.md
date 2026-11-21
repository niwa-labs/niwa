# @niwa-labs/flow-eval

Workflow helpers for evaluation: blind candidate sets, rubric grading, evaluation suites and transcript chain checks.

```ts
import { blindSet, gradeCase } from "@niwa-labs/flow-eval";
```

Built on `@niwa-labs/flow` alone; an evaluation of work in a repository imports `@niwa-labs/flow-code`
itself.

- `blindSet` labels candidates A, B, C in an order drawn with the script's recorded `random()`
  (the names are put in a fixed order first, so the same candidates in another order get the same
  labels on a replay), and reveals the name behind a label.
- `gradeCase` scores a subject against a rubric (0 to 1 per item) by graders of another vendor than
  the candidate's (a seat's `vendor`, else its harness; a `candidateVendor` of null says the subject
  is not the work of a model). A grader answers with a score for every item or not at all. The rule
  counts every independent grader, so the verdict is `INCONCLUSIVE` when graders that gave no answer
  could still change it, and when no grader is independent.
- `evalSuite` runs every case on every variant, grades each output and recommends the best variant.
  `vendorOf` is required: it names the vendor of each variant, or null. A cell that has no score
  (its run failed, listed in `failures`, or no independent grader answered) is null in the table, and
  a `perCase` or `recommend` that would rest on it is null, as it is on a tie.
- `chainFromTranscript` reads a session with `history.read` and says which expected files, skills or
  tools it opened, in the order it called them: a text matches exactly the target, a path or the
  name of a tool call, a read counts only with a result that did not fail, and a message that names
  a file opens nothing. An unreadable transcript throws.
