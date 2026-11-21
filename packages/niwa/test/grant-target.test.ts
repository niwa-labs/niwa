// The target of a call is one place: an action whose input would make a target with a wildcard or
// an empty segment is refused for a subject a grant limits, so data cannot widen a rule's target.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { action, actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { plugin, tempHome } from "@niwa-labs/testing";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const files = plugin("files", (api) => {
  api.action(action("files.touch", {
    description: "Touches a place.",
    input: z.object({ place: z.string() }),
    output: z.object({ ok: z.boolean() }),
    recovery: "repeat",
    effect: "write",
    world: "local",
    target: (input) => input.place,
    run: () => ({ ok: true }),
  }));
});

test("a call whose target has a wildcard or an empty segment is refused under a target rule", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(files);
  await host.serve();
  hosts.push(host);
  const token = host.issueToken(principalOf("session", "s"), { grant: grant(["files.touch@acme/*"]) });
  const client = await connect({ home: home.path, id: "session:s", token });
  clients.push(client);
  const TOUCH = actionName("files.touch");
  expect(await client.call(TOUCH, { place: "acme/billing" })).toEqual({ ok: true });
  for (const place of ["acme/*", "acme//billing", "acme/"]) {
    await expect(client.call(TOUCH, { place })).rejects.toThrow("is not the target of a call");
  }
}, 30_000);
