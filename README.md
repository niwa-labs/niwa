# Niwa

Niwa is a local host for coding agents and workflows. It runs on your machine
and writes sessions, workflow runs, messages, requests and tasks to one
durable journal. The command line, the web Cockpit, a stdio MCP server and an
optional Telegram bot all talk to that same host. Plugins add actions, record
types, workflows and Cockpit pages.

Version 0.2.0 is the current release. The [changelog](CHANGELOG.md) lists every
version from the first.

## What it does

- Starts, resumes, messages and interrupts sessions in Claude Code, the Claude
  Agent SDK, Codex, MiniMax Code, Ncode, OpenCode v2, pi and ZCode. Each kind
  declares what it supports, and one kind can have several installations.
- Reads the transcript of any session, in full, as a digest or as a short
  brief, and searches across all of them.
- Runs workflows written as TypeScript scripts. A run survives restarts, pauses
  on request, can be extended or cancelled, and resumes from the part of the
  script that did not change.
- Confines every session and command in a sandbox built from the profile of its
  installation, with explicit filesystem and network rules.
- Asks you typed questions, routes messages between agents, and tracks tasks
  from assignment to result.
- Controls what each run and each agent may do through grants. An irreversible
  action needs a rule that names it, and every refusal is recorded.

## Run it from source

Install Git and Bun. Clone the Niwa repository and install its dependencies
with Bun. A convenient layout keeps the checkout and your host configuration
in one workspace directory, such as a folder named niwa-labs in your home
directory.

The host configuration is a TypeScript file that you write next to the
checkout. It imports the default composition from the umbrella package and
returns it with your choices. The default composition starts the standard
plugins and can run workflows without any model credentials. To bring in a
coding agent, register an installation of its kind in the same file and give it
an identifier. That identifier is the name sessions, workflows and agent roles
use to refer to it.

The Niwa home is the data directory. It holds the journal, workflow sources and
versions, owner credentials, the Unix socket and the log of the detached host.
It defaults to a hidden directory named niwa in your home directory and stays
in place across stops and restarts. Set the home environment variable, or pass
the home option before the command, to use another directory. The host and
every client must use the same home. Keep the host file outside the home so
that configuration and data stay apart.

Start the host with the serve command and the path to your host file. The host
detaches and keeps running. The status command reports whether it is up. The
web command prints a login link for the Cockpit, and the first launch may build
it. Closing the web server leaves the host running. The stop command shuts the
host down. After you edit the host file, stop the host and start it again with
the same home.

### Connect an MCP client

Configure a stdio server whose command is the absolute path to Bun. Its first
argument is the absolute path to the Niwa command script in the checkout,
followed by the word mcp. For a custom home, add the home option and the
absolute data directory before mcp. Keep the host running while the client uses
its actions.

### Run a workflow

A workflow script exports one definition with a name, a description, an input
schema, an output schema and an async body. The runner supplies the globals the
body needs, including the schema builder, a logger and a sleep function. The
check command validates a script. The start command runs it and can wait for
the result. The runs command lists past runs. A run and its timer wake-ups stay
in the journal, so you can follow them in the Cockpit or read them back with
the log command.

### Install the command outside the checkout

A script in the repository stages a copy of Niwa with its locked production
dependencies and puts it outside the checkout. A second step of the same script
activates a staged copy by switching the installed launcher to it. The default
launcher lives in the local bin directory of your home. Point stdio MCP clients
at that launcher. Activation checks both entry points before it replaces the
launcher and leaves the host running. To go back, activate the earlier copy.

### Add a coding agent

With Codex installed and signed in on the machine, register a Codex
installation in the host file, restart the host, and list the harnesses to
confirm the binding. The installation reads Codex's usual home. Start a session
on it from a project directory by naming the installation, the directory and a
first prompt. Other kinds have their own requirements; the
[kind list](packages/niwa/src/kinds.ts) describes each one.

Each kind declares the network hosts its sandboxed sessions need. For an
installation that uses your own model provider, set the provider address in the
agent's own configuration and add the matching host name to that installation's
network profile in the host file. Omit the list to inherit the defaults of the
kind, or give an empty list to clear them. Other installations keep their own
profiles. The [OpenCode guide](packages/harness-opencode/README.md) walks
through a complete provider setup.

## Niwa and Ncode

Niwa coordinates workflows and tool access. Ncode runs coding sessions over
the Agent Client Protocol, with session-scoped MCP tools, paged history,
reconnect status for active turns and queues, and an always-deny choice for
permissions that can be saved.

- **Tool limits.** Start an Ncode session in Niwa-only mode and it sees only
  the MCP tools Niwa supplies for that session. Alternatively, give it an exact
  list of built-in tools it may use, which can be empty. After every start and
  resume, Niwa reads back what the build allows. It refuses the session when
  the build cannot enforce the list or still offers a tool you left out. A
  resumed session keeps its own list and cannot widen it. Upstream MiniMax Code
  keeps its default tool set and refuses both modes.
- **Resume and history.** A cold resume loads the same session in a new process
  with its restrictions. Niwa checks for an active turn on reconnect and reads
  past messages and tool calls, including results Ncode stored outside the
  transcript, from Ncode's local session store.
- **Permissions.** Choose ask, auto or full when you open a session. Niwa
  restores that mode on cold resume and shows the decisions Ncode reports. An
  approval prompt can allow a tool once.
- **Questions and answers.** Ncode can send a questionnaire to the owner
  through Niwa requests. A workflow's question to a session carries an answer
  schema, and the reply is checked against it.

A pull-request review workflow, for example, can hand a pinned Git diff to
Ncode and ask a separate session to verify a finding before it requests
changes.

[Ncode and Niwa](https://github.com/niwa-labs/ncode#niwa-and-ncode) ·
[Niwa adapter guide](packages/harness-mcode/README.md)

## Sandboxes and credentials

Sessions run in a box by default. A box gets the filesystem and network access
that its installation's profile lists and nothing else. Socket and Git
metadata access covers only the session being launched. On macOS, Claude Code
can sign in from the local Keychain inside a box, and Claude startup failures
come back with a reason. A workflow that holds an explicit launch grant can
start a session without a box. Niwa checks the isolation of that workflow and
its parent runs before it does.

## What the standard host includes

- **Sessions, history and agents.** Start and control sessions in configured
  harnesses, read native transcripts, and give long-lived agents addresses and
  inboxes. See [sessions](packages/sessions/README.md),
  [history](packages/history/README.md) and [agents](packages/agent/README.md).
- **Workflows and timers.** Check and run workflows, wait on records or
  scheduled wake-ups, wait on several turns at once, and resume a run from its
  journal. See [workflows](packages/workflow/README.md) and
  [timers](packages/timer/README.md).
- **Messages, requests and tasks.** Route messages, ask for typed decisions, and
  track assignments and outcomes. See [messages](packages/messages/README.md),
  [requests](packages/requests/README.md) and [tasks](packages/tasks/README.md).
- **Git, processes and sandboxes.** Track repositories and worktrees, run
  commands, and configure access for boxed work. See [Git](packages/git/README.md),
  [proc](packages/proc/README.md) and [sandbox](packages/sandbox/README.md).
- **Cockpit.** The web interface shows sessions with live transcripts that load
  earlier messages as you scroll, workflow runs with a timeline of each step's
  current attempt and the sessions it started, open requests and tasks. See
  [Cockpit](packages/cockpit/README.md).

The [umbrella package](packages/niwa/README.md) documents the command line
entry point. The [examples](packages/niwa/examples/) show plugin code, host
composition and workflow scripts. [Telegram](packages/telegram/README.md) and
[MCP](packages/mcp/README.md) are further surfaces over the same host.

## Companion repositories

- [Niwa Plugins](https://github.com/niwa-labs/niwa-plugins) provides optional
  modules such as GitLab integration, activity monitoring, evidence, plans and
  agent memory. A host can load them individually.
- [Rin](https://github.com/niwa-labs/niwa-rin) is an optional agent and Cockpit
  page. She composes the memory, commitments and delegation plugins on top of
  the standard host.
- [pstack](https://github.com/niwa-labs/niwa-pstack) adds engineering workflows
  on top of Niwa and the forge, evidence, watch and plan plugins.

The companion guides show the sibling checkout names and composition order.
Install Niwa before a companion checkout. Rin and pstack also need the plugins
checkout.

## License

Niwa's own code is licensed under the [MIT License](LICENSE). Bundled
third-party components carry their own licenses, listed with the
[Cockpit build](packages/cockpit/README.md).
