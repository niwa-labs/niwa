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
  `paramGrid`.
- Quality: `revise`, `escalate`, `gate`, `verify`, `panel`. `INCONCLUSIVE` is never a pass.
- Waiting: `settle` (reads first, then waits for a record after what it read), `humanGate` (a decline,
  a cancel or a timeout is an outcome, never an error).

A failed branch is a value (`Settled`), except a refusal of the grant (`Denied`) or a spent budget,
which every helper throws. `Attempt(schema)` is the zod schema of what `revise` returns, for a
script's `output`.
