# @niwa-labs/flow-eval

Workflow helpers for evaluation: blind candidate sets, rubric grading, evaluation suites and transcript chain checks.

```ts
import { blindSet, gradeCase } from "@niwa-labs/flow-eval";
```

Built on `@niwa-labs/flow` alone; an evaluation of work in a repository imports `@niwa-labs/flow-code`
itself.

- `blindSet` labels candidates A, B, C in an order drawn with the script's recorded `random()`, so a
  replay labels them the same, and reveals the name behind a label.
- `gradeCase` scores a subject against a rubric (0 to 1 per item) by graders of another vendor than
  the candidate's (a seat's `vendor`, else its harness). With no independent grader it is
  `INCONCLUSIVE`.
- `evalSuite` runs every case on every variant, grades each output and recommends the best variant
  (null on a tie).
- `chainFromTranscript` reads a session with `history.read` and says which expected files, skills or
  tools it opened, in the order it met them; an unreadable transcript throws.
