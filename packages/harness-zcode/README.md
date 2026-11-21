# @niwa-labs/harness-zcode

The ZCode harness kind.

- Reading side: lists and reads sessions straight from the SQLite database ZCode writes, read-only.
- Control side: drives `zcode app-server --stdio` to start, resume, send, interrupt and ask, and answers the server's permission and question requests.
- `src/protocol/generated` holds the zod schemas of the app-server wire; `bun run gen` regenerates them from a ZCode checkout (`--zcode <path>`).

There is no insert side.
