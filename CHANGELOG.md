# Changelog

## Unreleased

- Register an OpenCode v2 installation with `opencodeKind` to browse its
  sessions and transcripts in Niwa. Local history reads open SQLite read-only.
  Discovery checks the executable's major version. The adapter uses the
  official `@opencode/client@2.3.2`.
- Override a harness kind's network allowlist for one installation in
  `host.ts` with `kind.bind({ id, boxProfile: { net: ["llm.example.org"] } })`.
  An omitted list inherits the kind's defaults. An empty list clears them.
- In a trusted SDK application, start or resume an OpenCode session in
  `auto` or `full` mode, send or interrupt a turn, and request a
  schema-validated answer. The adapter forwards tool permission requests
  and supported interactive forms to the operator. The host's
  `session.start` requires a sandbox, whose default policy blocks the
  OpenCode server's local listener. See the [adapter guide](packages/harness-opencode/README.md).

- Use [`@niwa-labs/upstream-map`](packages/upstream-map/README.md) to check
  and update the Git range map of an upstream snapshot from a downstream
  package, with optional generation of script texts.

## 0.0.0 — 2026-11-22

Initial public npm release of [`@niwa-labs/niwa`](https://www.npmjs.com/package/@niwa-labs/niwa/v/0.0.0),
including the local host, the `niwa` CLI, workflows and the web Cockpit.
