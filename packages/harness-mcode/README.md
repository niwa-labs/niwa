# @niwa-labs/harness-mcode

The `mcode` and `ncode` harness kinds share the MiniMax Code ACP adapter.

## Ncode with Niwa tools only

Use an Ncode executable that lists `--no-builtin-tools` and
`--session-mcp-only` in `ncode acp --help`.

To select a separate local build in `host.ts`, register it like any other Ncode
installation. The binary can be an installed launcher or the distribution's
executable `dist/cli.js`. Use your model provider's host for the box network
allowlist.

```ts
import { ncode } from "@niwa-labs/niwa";

harnesses.register(ncode({
  id: "ncode-review",
  profile: "review",
  control: { binary: "/absolute/path/to/ncode/dist/cli.js" },
  boxProfile: { net: ["agent.example.org"] },
}));
```

Start the session with `tools: "niwa-only"` and the Niwa actions it may see.
Niwa passes both switches at start and on cold resume. Ncode uses the MCP
servers supplied for that session and disables its built-in tools. Choose
`tools: "all"` to launch with the usual Ncode tool set.

## Ncode with an exact tool set

Start the session with `tools: { allow: ["read", "bash"] }` to keep only these
built-in tools of Ncode; `tools: { allow: [] }` keeps none. The list travels to
Ncode as `_meta["minimax-code/toolPolicy"]` on `session/new`. Ncode refuses a
name outside its catalog before the session exists. Niwa then reads the
session's listing back through `mcode/session/tools` (`toolsOf` on the control
side): a build that kept a tool the list does not name fails the start.

The list holds for the whole life of the session. A cold resume sends the
session's own list again, and Ncode keeps the narrower of the stored and the
sent list, so a new process cannot widen it. A resume that names another mode
is refused with `Unsupported`. Under an exact list the session reaches only the
MCP servers Niwa supplied for it.

The tool set does not depend on the box. A session in a box and a session
started with `box: false` are bound the same way. An older Ncode build that does
not advertise `mcode/session/tools` is refused with `Unsupported` when a session
asks for a list. Upstream MCode takes the default tool set only.
