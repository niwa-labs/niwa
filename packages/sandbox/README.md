# @niwa-labs/sandbox

Process boxes (srt and nono), `BoxSpec`, launching a process inside a box, and how a box gets its access.

- A **profile** is the paths a program needs: `{ read?, write?, net? }`, or a function of
  `{ home, env, bin }` (`bin(name)` gives the program's path, its real path and its package root).
  `@niwa-labs/sandbox/profiles` is the catalog: `git`, `node`, `bun`, `npm`, `cargo`, `uv`.
- `sandbox({ adapter?, profiles?, closed? })` is a host's sandbox: the catalog, the host's own
  profiles (their names typed by augmenting `BoxProfiles`), and the profile of every harness
  installation, given by the sessions module.
- A box asks with `{ allow: [...] }` (added to the host's default) or `{ only: [...] }` (replacing it):
  `"project"` (the working directory, writable), `"toolchains"` (the PATH, Homebrew and the catalog's
  programs, readable), a profile's name, `{ read }`, `{ write }`, `{ net }`.
- The plan guarantees the paths it allows and the paths it closes: every path a profile names is closed
  to every box that did not take it (programs excepted), and so are `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/Library/Keychains` and niwa's own secrets, unless a place in them is asked for by name. The rest is
  the sandbox's own: srt reads it, nono does not. A sandbox that cannot hold the plan refuses it with
  `BoxRefused`, every reason at once.
- Widening beyond the host's default needs a rule of the caller's grant: `box.use@<profile>`,
  `box.read@<path>`, `box.write@<path>`, `box.net@<host>`.
- `BoxManifest` is what is recorded of a box: the request and where each item came from, the paths and
  their origins, what was closed and left out, the rules taken, and the policy the sandbox applies.
