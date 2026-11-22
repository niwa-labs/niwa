# @niwa-labs/harness-mcode

The `mcode` and `ncode` harness kinds share the MiniMax Code ACP adapter.

## Ncode with Niwa tools only

A compatible Ncode executable lists both `--no-builtin-tools` and
`--session-mcp-only` in `ncode acp --help`. Niwa probes the executable selected
for each Ncode installation.

Check `niwa harness.list` for `capabilities.control.tools.niwaOnly: true` on
the selected Ncode installation.

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
Niwa passes both switches at start and when it launches a replacement process
on cold resume. They restrict Ncode to the MCP servers passed for that session
and disable its built-in tools. A running process retains its launch policy.
An explicit request to change it is refused. The `all` mode uses the ordinary
ACP launch without the switches.

Niwa refuses `niwa-only` when the selected Ncode executable lacks either
switch or the installation uses upstream MCode. Both lineages refuse native
tool allowlists and per-tool disable lists. Typed asks use the adapter's
structured answer path.
