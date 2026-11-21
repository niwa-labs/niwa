// A quick script: the smallest thing that uses niwa. It runs as it is:
//
//   bun run examples/12-quick-script.ts
//
// A script is its own host. `createNiwa` makes the host object, `niwa.use(...)` installs a
// plugin in it, and the plugin is a function that receives the plugin API, called `api`.
// The host and the plugin API are different objects: `api` declares records, listens and
// registers actions; `niwa` installs plugins, serves, calls and reads.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { z } from "zod";

const Ping = record("script.ping", z.object({ text: z.string() }));

const home = await mkdtemp(join(tmpdir(), "niwa-quick-"));
const niwa = createNiwa({ home });

let heard: (text: string) => void = () => {};
const handled = new Promise<string>((resolve) => {
  heard = resolve;
});

niwa.use(
  plugin("my-script", (api) => {
    api.declare(Ping);
    api.on(Ping, async (ping) => {
      console.log("the handler heard:", ping.text);
      heard(ping.text);
    });
  }),
);

await niwa.serve();
await niwa.emit(Ping, { text: "hello from a script" });
await handled;

await niwa.close();
await rm(home, { recursive: true, force: true });
