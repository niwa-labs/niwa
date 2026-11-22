# Niwa

Niwa is a local host for coding agents and workflows. It records sessions,
workflow runs, messages, requests and tasks in a journal. The CLI, web Cockpit
and stdio MCP server connect to the same host. Plugins add actions, record
types, workflows and Cockpit pages.

## Run from source

Use Git and Bun on your PATH. The commands below use a shell and were tested
with Bun 1.4.4 on macOS. In this example the host configuration and the
companion repositories live together at `~/niwa-labs`.

```sh
mkdir -p "$HOME/niwa-labs"
cd "$HOME/niwa-labs"
git clone https://github.com/niwa-labs/niwa.git niwa
(cd niwa && bun install)
```

Create `~/niwa-labs/host.ts`. This TypeScript file is the host composition.
The example starts the standard plugins and can run workflows without model
credentials. It also shows how to bind a signed-in Codex installation and
make it available to workflows and agent roles.

```ts
import { resolve } from "node:path";
import { homeOf } from "./niwa/packages/cli/src/index.ts";
import {
  codexKind,
  defaultComposition,
  HarnessInstanceRegistry,
} from "./niwa/packages/niwa/src/index.ts";

const home = resolve(homeOf(process.argv.slice(2), process.env));
const harnesses = new HarnessInstanceRegistry();
const useCodex = process.env.NIWA_USE_CODEX === "1";

if (useCodex) {
  harnesses.register(codexKind.bind({ id: "codex-local" }));
}

export default defaultComposition({
  home,
  harnesses,
  git: { cleanup: false },
  ...(useCodex ? { agents: { roles: { assistant: "codex-local" } } } : {}),
  workflow: {
    root: import.meta.dir,
    harnesses: useCodex ? ["codex-local"] : [],
  },
});
```

The Niwa home is the data directory. It holds the journal, workflow sources
and versions, owner credentials, the Unix socket and the detached host's log.
It defaults to `~/.niwa` and stays in place across stops and restarts. Keep
`host.ts` in the workspace so the configuration and data have independent
locations. To use a different persistent directory, put
`export NIWA_HOME="$HOME/.niwa-work"` in your shell profile or set the same
variable in your service environment. The host creates the directory on its
first start. You can also pass `--home "$HOME/.niwa-work"` before the command,
which overrides the environment. Use the same home for the host and every
client.

Run these commands from your workspace. Save the shell function in your shell
profile if you want to use it in new terminals.

```sh
cd "$HOME/niwa-labs"
niwa() { bun "$HOME/niwa-labs/niwa/packages/niwa/bin/niwa.ts" "$@"; }

niwa serve -d host.ts
niwa status
niwa web
```

Open the login link printed by `web`. The first launch may build the Cockpit.
Press Ctrl+C to close the web server. The detached host stays up until
`niwa stop`. After editing the composition, stop the host and start it again
with the same home. The host writes to `niwa.log` in that directory.

### Connect an MCP client

Configure a stdio server with the absolute path to `bun` as the command.
Pass the absolute path to
`~/niwa-labs/niwa/packages/niwa/bin/niwa.ts` as its first argument, followed by
`mcp`. For a custom home, put `--home` and the absolute data directory before
`mcp`. Keep the host running while the client uses its actions.

### Run a workflow

Create `~/niwa-labs/hello.ts`. The workflow runner supplies the script's
`workflow`, `z`, `log` and `sleep` globals.

```ts
export default workflow(
  {
    name: "hello",
    description: "Write a journal line and return a greeting.",
    input: z.object({ name: z.string() }),
    output: z.string(),
  },
  async ({ name }) => {
    log("Preparing a greeting");
    await sleep("1s");
    return `Hello, ${name}!`;
  },
);
```

```sh
niwa workflow.check --file hello.ts
niwa workflow.start --file hello.ts --args '{"name":"Niwa"}' --wait
niwa workflow.runs
```

The first command checks the script. The second starts one run and waits for
its result. The run and its timer wake remain in the journal. Open the workflow
runs in Cockpit or use `niwa log` to see the recorded activity.

### Add a coding agent installation

With Codex installed and signed in on this machine, restart the host with the
example's opt-in flag and check the bound installation.

```sh
niwa stop
NIWA_USE_CODEX=1 niwa serve -d host.ts
niwa harness.list
```

The binding uses Codex's usual home (`CODEX_HOME` or `~/.codex`). Inside a
project directory, start a session on that installation with
`niwa session.start --harness codex-local --cwd "$PWD" --prompt "Describe this project"`.
The installation ID is also the name a workflow passes to `ask()` or
`session()`. Other [harness kinds](packages/niwa/src/kinds.ts) have their own
installation requirements and capabilities.

## What the standard host includes

| Packages | What they do |
| --- | --- |
| [Sessions](packages/sessions/README.md), [history](packages/history/README.md) and [agents](packages/agent/README.md) | Start and control sessions in configured harnesses, read native transcripts, and give long-lived agents addresses and inboxes. |
| [Workflows](packages/workflow/README.md) and [timers](packages/timer/README.md) | Check and run TypeScript workflows, wait for records or scheduled wake-ups, and resume a run using its journal. |
| [Messages](packages/messages/README.md), [requests](packages/requests/README.md) and [tasks](packages/tasks/README.md) | Route messages, ask for typed decisions, and track assignments and outcomes. |
| [Git](packages/git/README.md), [proc](packages/proc/README.md) and [sandbox](packages/sandbox/README.md) | Track repositories and worktrees, run processes, and configure filesystem and network access for boxed work. |

The [umbrella package](packages/niwa/README.md) documents the CLI entry point.
See the [examples](packages/niwa/examples/) for plugin code, host composition
and workflow scripts. [Telegram](packages/telegram/README.md) is an optional
surface alongside [Cockpit](packages/cockpit/README.md) and [MCP](packages/mcp/README.md).

## Companion repositories

- [Niwa Plugins](https://github.com/niwa-labs/niwa-plugins) provides optional
  modules such as GitLab integration, activity monitoring, evidence, plans
  and agent memory. A host can load them individually.
- [Rin](https://github.com/niwa-labs/niwa-rin) is an optional agent and Cockpit
  page. She composes the memory, commitments and delegation plugins on top
  of the standard host.
- [pstack](https://github.com/niwa-labs/niwa-pstack) adds engineering workflows
  on top of Niwa and the forge, evidence, watch and plan plugins.

The companion guides show the sibling checkout names and composition order.
Install Niwa before installing a companion checkout. Rin and pstack also
need the `plugins` checkout.

## Packages

The planned npm package is `@niwa-labs/niwa`. After it is published, install it
in a Bun project with `bun add @niwa-labs/niwa` and run its `niwa` command with
`bun run niwa`.

## License

Niwa's own code is licensed under the [MIT License](LICENSE). Bundled
third-party components carry their own licenses in the
[Cockpit build](packages/cockpit/README.md).
