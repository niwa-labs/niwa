# @niwa-labs/proc

Running commands.

- `proc.run { cmd, cwd, timeout, env? }` always runs in a box from `@niwa-labs/sandbox`: it may write only in
  `cwd`, has no network and no credentials. Because the box holds that, the action is a write in the local world.
  A box that cannot run here stops the call; a run never falls back to no box.
- `proc.exec { cmd, cwd, timeout, env?, net?, secrets? }` runs with no box. It is irreversible and external, so a
  grant names it. `env` values may be `secret("name")` references and `secrets` lists secrets given as variables
  of their own names; values are resolved from `<home>/secrets/<name>` (mode 0600) or `NIWA_SECRET_<name>`, and
  are never written to a record, result or error. Known values are replaced in the output.

`cmd` is the program and its arguments, run as they are; a shell is `["sh", "-c", "…"]`. A command that outlasts
`timeout` (milliseconds) is stopped with everything it started, and so is anything it leaves running once it exits.

The whole output is an artifact under `<home>/proc/artifacts/<sha256>`, flushed before anything points at it.
The result and the `proc.finished` record carry the exit code, how it ended, and a bounded tail. A non-zero exit
is a result, not an error.

Entries: `@niwa-labs/proc` (the plugin `proc()`), `@niwa-labs/proc/records` (action references, record type,
`secret()`), which needs only core and zod.
