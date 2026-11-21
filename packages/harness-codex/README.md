# @niwa-labs/harness-codex

The Codex harness kind. The reading side lists and reads the rollouts Codex writes to
`~/.codex`; the control side drives `codex app-server` over JSON-RPC. It has no insert side.

The zod schemas of the app-server protocol in `src/protocol/generated/` are generated from the
installed codex with `bun run gen:codex`.

Codex supports the default tool mode and `tools: "all"`. Its app-server thread API
cannot enforce an exact tool list across built-ins, feature groups and configured
MCP servers. Starts and cold resumes requesting `niwa-only` or `{ allow: [...] }`
return `Unsupported` before launching a process.
