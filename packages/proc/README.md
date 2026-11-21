# @niwa-labs/proc

Running commands.

- `proc.run { cmd, cwd, timeout, env? }` always runs in a box from `@niwa-labs/sandbox`: it may write only in
  `cwd`, has no network and no credentials. Because the box holds that, the action is a write in the local world.
  A box that cannot run here stops the call; a run never falls back to no box. The policy the sandbox reports for
  the box has to keep writes to `cwd` (and the devices a process needs), reads to an allow-list and the network
  closed: nono's does; srt's does not (its own temp directory is writable and its reads are open), so a run is
  refused with it. The `box` of the result and of `proc.finished` is that policy: `write`, `devices`, `read`, `net`. The command has a `TMPDIR` inside `cwd`, made for the run and removed after it; a tool that asks the
  system for its temp directory instead of reading `TMPDIR` (Apple's `mktemp`) finds none it may write.
- `proc.exec { cmd, cwd, timeout, env?, net?, secrets? }` runs with no box. It is irreversible and external, so a
  grant names it. `env` values may be `secret("name")` references (`secret()` is exported by `@niwa-labs/core`)
  and `secrets` lists secrets given as variables of their own names; values are resolved from
  `<home>/secrets/<name>` (mode 0600) or `NIWA_SECRET_<name>`, and are never written to a record, result or error.
  Known values are replaced in the output.

`cmd` is the program and its arguments, run as they are; a shell is `["sh", "-c", "…"]`. A command that outlasts
`timeout` (milliseconds), or whose call is cancelled, is stopped with the process group it leads, and so is
anything left running in that group once the command exits. The limit of that: a process that moved to another
group (`setsid`) is not reached, and a command still running when the host itself dies is not stopped by it; the
`do-not-repeat` contract keeps it from being run again, not from running on.

A grant names the directory a command runs in by its real path: `proc.run@/work/repo`, or `proc.run@/work/*` for
everything under `/work`. A character a rule cannot hold (a space, `*`, `@`, `:`, a brace, and `%` itself) is
written as `%` and its hex code, so `/work/My Project` is `proc.run@/work/My%20Project`.

The output is an artifact under `<home>/artifacts/<sha256>`, flushed before anything points at it. The artifact
keeps the first 16 MiB of the output (`outputLimit`); with `truncated: true` it holds the start of the output and
`tail` the end. The result and the `proc.finished` record carry the exit code, how it ended (`exited`,
`timed-out`, `cancelled`), whether reading the output was cut off (`outputCut`), and a bounded tail. A non-zero
exit is a result, not an error. A call that could not start a command, because the directory is not there or no
box could be had, is a `ProcRefusal`: nothing ran.

Entries: `@niwa-labs/proc` (the plugin `proc()`), `@niwa-labs/proc/records` (action references, record type,
`fileTarget()`), which needs only core and zod.
`@niwa-labs/proc/flow` is the script helper `runCheck(key, { cmd, cwd, timeout?, env?, report? })`: it runs a
check with `proc.run` (with `proc.exec` when `env` holds a secret reference), passes on a zero exit, and reads the
report a command prints last (`json`, `lcov` totals, `junit` suite counts). It imports nothing.
