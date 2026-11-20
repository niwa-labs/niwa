# niwa

The niwa platform, published as `@niwa-labs/*` packages under one shared version:
the foundation (`core`, `plugin`, `client`, `host`), the packages that need no
host (script language, flow helpers, the harness model and every harness kind,
`digest`, `sandbox`, `ui-kit`), the base plugins, script libraries, the cockpit
and its SDK, the surfaces, `testing` and the `niwa` umbrella.

## Layout

- `packages/<name>/` is the package `@niwa-labs/<name>` (`packages/niwa/` is the umbrella `niwa`).
  `src/index.ts` is its root entry; `src/records.ts` (record types and action
  references), `src/flow.ts` (script helpers) and `src/journal.ts` back the
  extra entries of the packages that export them.
- Dependencies on `@niwa-labs/*` are `workspace:*` inside this repository and `*`
  across repositories.
- `scripts/check-boundaries.ts` holds the module map and the import rules.

## Commands

```sh
bun install
bun run typecheck          # tsc --noEmit -p .
bun test
bun run check:boundaries
```

All three checks must pass before a commit.

## Import boundaries

Zones, lowest first: packages that need no host, the foundation, packages built
on niwa (plugins, script libraries, the cockpit SDK), and leaves (the cockpit
app, surfaces, compositions, `testing`, the umbrella). The check fails when a
package:

- imports another package's internal file instead of an exported entry;
- imports a higher zone (the only exception: packages that need no host may use
  the contracts entry of `@niwa-labs/core`) or a leaf (only the umbrella may);
- imports a plugin other than through its `/records` entry, or its `/flow` entry
  from script code; compositions import their plugins directly;
- imports an `@niwa-labs/*` package that its `package.json` does not declare, or
  declares one the map does not allow.

The map is the same file in every niwa repository. Change it in all of them in
the same way.

## Other repositories

`plugins`, `rin` and `pstack` are checked out next to this one and link to
these packages from their own root `package.json` overrides. Run `bun install`
here first; linked packages resolve their dependencies from this checkout.

## Commits

- Author and committer: `Niwa Mori <mori@niwa.sh>` (set in the repository
  config).
- Subject: one imperative sentence naming what changes, at most 72 characters,
  no final period, no type prefixes such as `feat:` or `fix:`.
- Body only when the subject does not explain the change: a blank line, then at
  most 100 words wrapped at 72 columns, saying why the change was needed and
  why this approach.
- One self-contained, revertible change per commit, with its tests.
- No co-author or generator trailers.
