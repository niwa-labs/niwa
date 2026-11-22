# Changelog

## Unreleased

- Use `tools: "niwa-only"` on Ncode installations whose ACP executable
  supports both external-tool switches. Cold resumes keep the session's
  isolation. Older Ncode builds and upstream MCode refuse that mode.
- Register an OpenCode v2 installation with `opencodeKind` to browse its
  sessions and transcripts in Niwa. Local history reads open SQLite read-only.
  Discovery checks the executable's major version. The adapter uses the
  official `@opencode/client@2.3.2`.
- Override a harness kind's network allowlist for one installation in
  `host.ts` with `kind.bind({ id, boxProfile: { net: ["llm.example.org"] } })`.
  An omitted list inherits the kind's defaults. An empty list clears them.
- Start or resume OpenCode sessions in a Niwa box with the official
  `@opencode/server@2.3.2` over inherited pipes. The worker shares the
  installation's SQLite history and follows the box's outbound policy for
  provider traffic. Direct unboxed SDK launches use the configured OpenCode v2
  executable. See the [adapter guide](packages/harness-opencode/README.md).

- Use [`@niwa-labs/upstream-map`](packages/upstream-map/README.md) to check
  and update the Git range map of an upstream snapshot from a downstream
  package, with optional generation of script texts.

## 0.0.0 — 2026-11-22

Initial public npm release of [`@niwa-labs/niwa`](https://www.npmjs.com/package/@niwa-labs/niwa/v/0.0.0),
including the local host, the `niwa` CLI, workflows and the web Cockpit.
