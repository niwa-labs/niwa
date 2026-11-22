# @niwa-labs/niwa

The umbrella package: the `niwa` command and the standard composition of the host, the base
plugins and the surfaces.

- `bin/niwa.ts` is the command. Actions of the host are commands (`niwa <action> --field value`);
  `niwa serve` runs a host from a composition file, `niwa mcp` serves MCP over stdio, `niwa web`
  serves the web surface, `niwa skill` installs the skill, and `niwa insert report` is what the
  inserts inside a harness run to report an event.
- `src/index.ts` re-exports the foundation, the base plugins and the harness kinds, so a program
  that runs a host imports from one place.
- `NIWA_CLI` is the absolute path of the bin. Inserts installed from here (`installInsert`,
  `insertEnv`, `cliReporter`) report through it, so they work where `niwa` is not on the PATH.
- `examples/` are programs and workflow scripts that show one thing each. They are type-checked
  with the package.
- `test/` holds the acceptance tests: they compose a host with the plugins and the kinds, run the
  command and the hooks as programs, and drive real harnesses when `NIWA_LIVE=1`.
