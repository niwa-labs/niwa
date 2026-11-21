# @niwa-labs/proc

Running commands.

- `proc.run { cmd, cwd, timeout, env?, box? }` always runs in a box from `@niwa-labs/sandbox`: it writes `cwd`, a
  temp directory inside it (`TMPDIR`, also `TMP`, `TEMP`, removed after the run) and the places of the profiles it
  takes; it has no network and no credentials. Because the box holds that, the action is a write in the local world.
  `HOME` is the user's own. The box is the host's default (`proc({ box })`, by default `{ allow: ["toolchains"] }`:
  the PATH, Homebrew and the catalog's programs, readable), what `box.allow` adds or what `box.only` puts instead: a
  profile by its name (`git`, `bun`, `npm`, `node`, `cargo`, `uv`, the host's own), `"toolchains"`, `{ read }`,
  `{ write }`. The places of every profile the run does not take (every harness installation's among them), the
  user's keys (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`) and niwa's journal and secrets are closed to it.
  A host it asks for is refused: a command that needs the network or a credential is for `proc.exec`. Going beyond
  the default needs the caller's `box.use@<profile>`, `box.read@<path>` or `box.write@<path>` rule. A box that cannot
  run here, or that its sandbox cannot hold as it was asked (nono by default, `proc({ sandbox: sandbox({ adapter })
  })` for another), stops the call before a process exists, with every reason. The `box` of the result and of
  `proc.finished` is the box's manifest: the request and where each item came from, the paths and theirs, what was
  closed and left out, the rules taken, the policy the sandbox applies and the names of the environment.
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
`fileTarget()`), which needs core, the box schemas of the sandbox and zod.
`@niwa-labs/proc/flow` is the script helper `runCheck(key, { cmd, cwd, timeout?, env?, report? })`: it runs a
check with `proc.run` (with `proc.exec` when `env` holds a secret reference), passes on a zero exit, and reads the
report a command prints last (`json`, `lcov` totals, `junit` suite counts). It imports nothing.
