# @niwa-labs/cli

The niwa command line as a library: a client of a host and nothing more.

The commands that are actions are generated from what the host describes, so a plugin that
declares a new action has a command at once. `niwa log` reads the journal the way a person reads
a log, `niwa insert report` carries an event from inside a harness to the host, and `niwa skill`
prints and installs the skill niwa ships.

Starting a host, the cockpit or the MCP server is not here: those commands compose other
packages. The kinds of harness that read skills are given to `runSkill` by whoever runs it.
