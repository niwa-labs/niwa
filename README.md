# Niwa

Niwa is a local host for coding agents and workflows. It keeps agent sessions,
workflow runs, messages, requests, and tasks in one journal. Use the `niwa`
command, the web cockpit, or the MCP server to connect to a running host.

## Run from source

Use Git and Bun on your PATH (tested with Bun 1.4.4). Clone the repository,
install the workspace, and write a small TypeScript composition. The
composition selects the plugins and agent integrations for your host. This
one loads the standard plugins with an empty harness registry, so you can
start it without agent credentials.

```sh
git clone https://github.com/niwa-labs/niwa.git
cd niwa
bun install

cat > niwa.example.ts <<'TS'
import { defaultComposition, HarnessInstanceRegistry } from "./packages/niwa/src/index.ts";

const home = process.env.NIWA_HOME;
if (!home) throw new Error("Set NIWA_HOME before starting Niwa");

export default defaultComposition({ home, harnesses: new HarnessInstanceRegistry() });
TS

export NIWA_HOME="$(mktemp -d /tmp/niwa.XXXXXX)"
bun packages/niwa/bin/niwa.ts serve -d niwa.example.ts
bun packages/niwa/bin/niwa.ts status
bun packages/niwa/bin/niwa.ts web
```

Open the login link printed by `web`. The first launch may build the cockpit.
Press Ctrl+C to close the web server, then stop the host from the same shell.

```sh
bun packages/niwa/bin/niwa.ts stop
```

## Package and examples

The planned npm package is `@niwa-labs/niwa`. After it is published, install it
in a Bun project with `bun add @niwa-labs/niwa` and run its `niwa` command with
`bun run niwa`.

See the [umbrella package](packages/niwa/README.md) for entry points and the
[examples](packages/niwa/examples/) for writing a plugin, composing a host with
agent integrations, and authoring workflows.

## License

Niwa's own code is licensed under the [MIT License](LICENSE). Bundled
third-party components carry their own licenses in the
[Cockpit build](packages/cockpit/README.md).
