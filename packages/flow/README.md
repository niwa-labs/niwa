# @niwa-labs/flow

Helpers for workflow scripts that need neither git nor processes: branch groups over `scope`, keyed maps, graphs, loops, `revise`, judging panels, verification and waiting on records or on the owner.

```ts
import { revise, verify } from "@niwa-labs/flow";
```

A helper runs inside a script on the script's own globals (`scope`, `agent`, `ask`, ...) and opens a
scope named by the key it is given; the calls it makes are keyed by their branch, never by a label,
so the same helper may run in every round of a loop. Keys of branches (items, nodes, briefs, seats)
are checked before anything runs.

- Groups: `parallel`, `map` (outcomes in the order of the items), `stream`, `firstPassing`, `rankAll`,
  `mapReduce`, `swarm`, `consensus`.
- Order: `graph` (refuses missing nodes, repeated ids and cycles before it starts), `loop`, `saturate`,
  `paramGrid` (a cell that failed has the score `null`).
- Quality: `revise`, `escalate`, `gate`, `verify`, `panel` (a judge that leaves a candidate unscored
  has not answered). `INCONCLUSIVE` is never a pass.
- Waiting: `settle` (reads first, then waits for a record after what it read; `on` names its types
  as text or by reference, and takes the query a plugin's builder gives; its `deadline` bounds the
  waiting after the first reading, so the facts of a timed-out `settle` are never none), `humanGate` (a decline,
  a cancel or a timeout is an outcome, never an error).

A failed branch is a value (`Settled`), except a refusal of the grant (`Denied`), a spent budget, or a
question to the owner that was cancelled or went unanswered (`AskCancelled`, `AskExpired`), which every
helper throws as soon as it is read; a worker that met one is not run again, and only `humanGate`
turns the last two into an outcome. The calls of a helper's callback that runs again (the attempts
of a `swarm` worker, the readings of `settle`) are keyed by the attempt (`a1`, `r1`), so a callback
may open a named scope each time. `Attempt(schema)` is the zod schema of what `revise` returns, for a
script's `output`.
