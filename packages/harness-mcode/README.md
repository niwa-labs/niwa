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
