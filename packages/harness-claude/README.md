# @niwa-labs/harness-claude

The Claude harness kinds: `code`, driven over ACP, and `sdk`, driven through the agent SDK. Both share transcript reading and format parsing.

It is a zone I library: it needs no host. Its dependencies are `@niwa-labs/harness` (the common model), `@niwa-labs/acp` (the protocol client of the `code` kind), the contracts entry of `@niwa-labs/core`, and process launch from `@niwa-labs/sandbox`; `scripts/check-boundaries.ts` holds the boundary.
