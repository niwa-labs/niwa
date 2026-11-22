# Upstream map

`@niwa-labs/upstream-map` tracks how text from an upstream Git snapshot
is carried into a downstream package. It checks coverage and references,
follows ranges across commits, and can generate the JSON texts that scripts
import.

## Configure the downstream package

Keep a small CLI entry in the downstream package. For example, a package
with a snapshot of one upstream guide can use this entry at
`scripts/upstream-map.ts`.

```ts
import { join } from "node:path";

import { pathsIn } from "@niwa-labs/upstream-map";
import { runUpstreamMapCli } from "@niwa-labs/upstream-map/cli";

process.exitCode = runUpstreamMapCli({
  paths: pathsIn(join(import.meta.dir, "..")),
  snapshot: {
    repository: "https://example.org/upstream",
    path: ".",
    paths: [{ snapshot: "guide.md", from: "docs/guide.md" }],
    requiredFiles: ["guide.md"],
  },
});
```

`pathsIn` uses `upstream/SOURCE.json` and `upstream/mapping.json` in the
downstream package. For each snapshot rule, `from` is relative to the Git
checkout folder passed to the tool, and `snapshot` is relative to the
snapshot folder. A rule can select a subtree and keep specific relative paths
from it. The top-level `path` records the upstream location in `SOURCE.json`.
Add a `textSpecs` function that returns text names and ordered lists of
snapshot files to generate JSON under `paths.texts`. Omit it for a map that
only tracks provenance.

Each mapping entry has an ID, one `upstream` reference, an array of `ours`
references, and a `kind` of `prompt`, `adapted`, `code` or `dropped`.
Dropped blocks have a note. References contain a full Git commit hash, a file
path and an exclusive-end range in UTF-16 code units. Upstream paths are
relative to the snapshot. Downstream paths are relative to the Git root.

## Commands

Run the downstream entry with Bun.

| Command | Effect |
| --- | --- |
| `refresh <checkout> [<commit>]` | Take a snapshot of the selected files from the commit and preserve the mapping. |
| `check` | Report coverage, moved or changed references, and generated text problems. `--summary` prints JSON numbers and `--out <file>` saves the full report. |
| `advance` | Record the unchanged entries at their current committed positions. |
| `accept <id>...` | Record the selected entries at their current committed positions. |
| `assemble [--check]` | Generate configured JSON texts or check their bytes against the map. |

Pass `--upstream <checkout>` when a reference still uses an upstream commit
older than the snapshot. `check --head <rev>` compares against a chosen
downstream commit, and `check --worktree` compares against files on disk.
