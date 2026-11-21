# @niwa-labs/sessions

Session control: start, resume, ask, send, interrupt, reverse requests, the catalog and the list of harnesses, and the registration of harness actions (discovery, confirmation, support, insert reports and permission questions).

The root entry holds the plugins and their factories; `@niwa-labs/sessions/records` holds the records, the typed action references and the pure helpers that other plugins may import.

## The box of a session

Every session niwa starts runs in a box of the host's sandbox (`sessions({ sandbox: sandbox({ adapter, profiles }) })`,
srt by default). The box is the host's default (`box`, by default `{ allow: ["project", "toolchains"] }`), what the
start asks for (`session.start { box: { allow } }` adds to it, `{ only }` replaces it), and always the profile of the
installation the session runs on, a temp directory of its own (`TMPDIR`) and the host's socket. The places of every
other installation, of every profile it did not take, the user's keys and niwa's own journal and secrets are closed
to it. A start that names no working directory is not given the host's directory to write. What a start asks beyond
the default is held to the caller's `box.use@<profile>`, `box.read@<path>`, `box.write@<path>` and `box.net@<host>`
rules; a refused box says every reason, and nothing is started. `session.box.manifest` records the box before the
process starts: the request with where each item came from, the paths and their origins, what was closed and left
out, the rules taken, the policy the sandbox applies and the names of the environment.
