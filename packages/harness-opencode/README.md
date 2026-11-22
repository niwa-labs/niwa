# OpenCode v2 for Niwa

Register a v2 installation in the host composition. This adapter is available
from the Niwa source tree. The published umbrella version 0.0.0 predates it.

```ts
import { HarnessInstanceRegistry, opencodeKind } from "@niwa-labs/niwa";

const harnesses = new HarnessInstanceRegistry();
harnesses.register(opencodeKind.bind({
  id: "opencode-local",
  control: { binary: "/absolute/path/to/opencode" },
}));
```

Pass `harnesses` to `defaultComposition` to expose native session history. Use a v2
executable with an already configured provider. An explicit path lets a v1
installation remain the default on your machine. The optional `model` field
on the binding takes a provider/model ID.

Niwa starts one `opencode serve --stdio` process per controlled session and
communicates through the authenticated HTTP API. The adapter supports start,
resume, send, interrupt, schema-validated questions and operator permission
decisions. It can forward interactive forms for the primary session. Control
uses the official `@opencode/client` pinned to 2.3.2. The local history reader
opens the installation's SQLite database read-only, including committed WAL
records. SQLite may update shared-memory reader marks while coordinating with
a writer. Browsing history does not start the OpenCode scheduler.
Starting a controlled session does start the upstream scheduler, which can run
automations configured in that OpenCode installation.

## Use your own provider in host.ts

This composition selects a model through a local OpenAI-compatible gateway.
Set the gateway URL and the model ID it serves.

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultComposition, HarnessInstanceRegistry, opencodeKind } from "@niwa-labs/niwa";

const home = process.env.NIWA_HOME ?? join(homedir(), ".niwa");
const gateway = new URL("http://127.0.0.1:10081/v1");
const modelId = "glm-5.3-flash";
const harnesses = new HarnessInstanceRegistry();

harnesses.register(opencodeKind.bind({
  id: "opencode-local",
  model: `gateway/${modelId}`,
  boxProfile: { net: [gateway.hostname] },
  control: {
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        providers: {
          gateway: {
            name: "Local gateway",
            package: "@ai-sdk/openai-compatible",
            settings: { baseURL: gateway.href },
            models: { [modelId]: { name: modelId, limit: { context: 200000, output: 8192 } } },
          },
        },
      }),
    },
  },
}));

export default defaultComposition({ home, harnesses });
```

OpenCode uses `providers.gateway.settings.baseURL` to connect to the gateway.
The box uses `boxProfile.net` as the outbound host list for this installation.
If the provider is already configured in OpenCode, put its exact hostname in
`boxProfile.net`. Add any other exact hosts the provider needs for requests.
Configure credentials through the [OpenCode provider connection settings](https://opencode.ai/docs/providers/).

## Operating limits

- Use `auto` (the default) for the installation's normal OpenCode permission
  policy, or choose `full` explicitly. OpenCode can honor a project-wide saved
  approval before emitting a permission request. Niwa therefore cannot offer
  its strict `ask` launch mode with this transport. Sending a schema-validated
  question to a running agent is supported independently of its launch mode.
- The OpenCode kind requests one listener on `127.0.0.1`, with a port chosen
  by the operating system. The stock nono and SRT backends cannot enforce
  that exact grant. A box request is
  refused before the agent starts. The host action `session.start` provisions a
  box for each new session. Use the reading side through the host or call the
  binding’s control side directly in a trusted unboxed SDK application.
- Provide a persistent installation home ending in `opencode`. If you select
  a database via `control.env.OPENCODE_DB`, choose a file inside that home.
  The local history reader and the controlled sessions share the installation's
  database. Use an explicit database file when selecting a different channel.
- Operator requests are routed for the controlled session. A native child
  session that asks for permission or opens an interactive form can wait for
  a response in OpenCode.
- A lost event-stream connection ends control of the current process. Resume
  the session to continue. History watching, session inserts, effort levels
  and tool-name allowlists (including Niwa-only tools) are unsupported.

## Verification

Run the offline adapter tests with `bun test packages/harness-opencode`.
The opt-in live tests use a configured local provider. Set
`NIWA_OPENCODE_BINARY` to the v2 executable and run
`NIWA_LIVE=1 bun test packages/harness-opencode/test/live`.
