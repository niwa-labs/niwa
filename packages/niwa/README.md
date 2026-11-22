# @niwa-labs/niwa

The umbrella package: the `niwa` command and the standard composition of the host, the base
plugins and the surfaces.

## Install and start

Install Bun, then add Niwa to the directory that holds your host configuration.

```sh
npm install @niwa-labs/niwa
```

Create `host.ts` next to your `package.json`.

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultComposition, HarnessInstanceRegistry } from "@niwa-labs/niwa";

export default defaultComposition({
  home: process.env.NIWA_HOME ?? join(homedir(), ".niwa"),
  harnesses: new HarnessInstanceRegistry(),
});
```

```sh
npx niwa serve -d ./host.ts
npx niwa status
npx niwa web
```

Open the local login link printed by `niwa web`. The host stores its journal in
`~/.niwa` by default. Set `NIWA_HOME` to choose another persistent directory.
Use `npx niwa stop` to stop the host. For agent configuration and optional
plugins, see the [Niwa configuration guide](https://github.com/niwa-labs/niwa#run-from-source).

## Override an installation's network profile

Every harness kind declares a box profile. In `host.ts`, set
`kind.bind({ id, boxProfile: { net: ["proxy.example.com"] } })` to replace that
installation's outbound hosts. Omit `net` to inherit the kind's hosts, or pass
`net: []` to clear them. Enter hostnames, IP addresses, or explicit subdomain
patterns such as `*.example.com`.

The same profile can set `listen: { host: "127.0.0.1", port: 0 }` for a
loopback listener on a port chosen by the OS. `listen: null` removes the
listener, subject to the harness's transport requirements. Each field can be
overridden independently. For a provider configuration and a complete
composition, see the [OpenCode example](../harness-opencode/README.md#use-your-own-provider-in-hostts).

## Package contents

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
