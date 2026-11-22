# OpenCode v2 for Niwa

Register an OpenCode v2 installation in the Niwa host composition.

```ts
import { HarnessInstanceRegistry, opencodeKind } from "@niwa-labs/niwa";

const harnesses = new HarnessInstanceRegistry();
harnesses.register(opencodeKind.bind({
  id: "opencode-local",
  control: { binary: "/absolute/path/to/opencode" },
}));
```

Pass `harnesses` to `defaultComposition` to expose native session history. Set
`control.binary` to a v2 executable for direct unboxed SDK launches. An explicit
path lets a v1 installation remain the default on your machine. The optional
`model` field on the binding takes a provider/model ID.

The host's `session.start` and `session.resume` run the official
`@opencode/server@2.3.2` in a Bun worker inside the session's box. One worker
owns the session and serves the authenticated API through inherited pipes with
no network listener. The provider, tools and OpenCode SQLite store are used by
that worker. A direct unboxed SDK launch uses `opencode serve --stdio`, whose
`--stdio` flag keeps the process alive while the client connects to its loopback
HTTP listener. A host with a custom sandbox that can enforce a specific TCP
loopback endpoint can explicitly select that executable transport with
`boxProfile.listen`.

Both transports use the official `@opencode/client@2.3.2` and support start,
resume, send, interrupt, schema-validated questions, operator permission
decisions and interactive forms for the primary session. The local history reader
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
Use `OPENCODE_DISABLE_MODELS_FETCH: "1"` in `control.env` to use the bundled
catalog without a network refresh, or allow the configured catalog hostname.
Configure credentials through the [OpenCode provider connection settings](https://opencode.ai/docs/providers/).

## Operating limits

- Use `auto` (the default) for the installation's normal OpenCode permission
  policy, or choose `full` explicitly. OpenCode can honor a project-wide saved
  approval before emitting a permission request. Niwa therefore cannot offer
  its strict `ask` launch mode. Sending a schema-validated
  question to a running agent is supported independently of its launch mode.
- Provide a persistent installation home ending in `opencode`. If you select
  a database via `control.env.OPENCODE_DB`, choose a file inside that home.
  The local history reader and the controlled sessions share the installation's
  database. Use an explicit database file when selecting a different channel.
- Niwa prepares a read-only runtime directory with the bundled server and
  its platform PTY binary. A source checkout builds the bundle from its locked
  development dependencies on first use. The npm package carries the bundle
  created by `prepack` in `dist/opencode-runtime/` with its
  `THIRD-PARTY-LICENSES.txt`. The host removes the temporary runtime on normal
  process exit. OpenCode's app directories have individual write grants.
  Features that open listeners, such as persistent terminals, depend on the
  sandbox. External OpenCode plugins and optional provider runtimes may need
  their own dependencies and were outside the boxed verification.
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
