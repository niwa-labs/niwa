// A mask never grants an irreversible action.
//
//   1. a subject whose grant holds the action only by a mask (`*`, `forge.*`) is refused, and the
//      refusal says why; a write next to it passes under the same mask
//   2. a rule that names the action grants it, within its target
//   3. the owner calls it under its own `*`
//   4. a child asked for by name, under a parent that holds the action by a mask, is refused at birth

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { connectAsOwner, tempHome } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";

import { COMMENT, MERGE, forge } from "./fixtures/forge-plugin.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const START = actionName("workflow.start");

async function served(): Promise<{ host: Host; home: string; as: (name: string, rules: string[]) => Promise<NiwaApi> }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(forge, workflow());
  await host.serve();
  hosts.push(host);
  const as = async (name: string, rules: string[]): Promise<NiwaApi> => {
    const token = host.issueToken(principalOf("session", name), { grant: grant(rules) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    clients.push(client);
    return client;
  };
  return { host, home: home.path, as };
}

test("a mask does not grant an irreversible action, and a rule that names it does within its target", async () => {
  const { as } = await served();
  const pr = { repo: "acme/billing", pr: 7 };
  for (const rules of [["*"], ["forge.*"], ["forge.*@git.example.com/acme/billing/pr/*"]]) {
    const masked = await as(`masked-${rules.join("-").replace(/[^a-z]/g, "")}`, rules);
    await expect(masked.call(MERGE, pr)).rejects.toThrow('"forge.pr.merge" is irreversible: only a rule that names it grants it');
    expect(await masked.call(COMMENT, pr)).toEqual({ ok: true });
  }
  const named = await as("named", ["forge.pr.merge@git.example.com/acme/billing/pr/*"]);
  expect(await named.call(MERGE, pr)).toEqual({ ok: true });
  await expect(named.call(MERGE, { repo: "acme/other", pr: 7 })).rejects.toThrow("not in the grant");
}, 30_000);

test("the owner merges under its own grant", async () => {
  const { home } = await served();
  const owner = await connectAsOwner(home);
  clients.push(owner);
  expect(await owner.call(MERGE, { repo: "acme/billing", pr: 1 })).toEqual({ ok: true });
}, 30_000);

test("a parent that holds an irreversible action only by a mask cannot give it to a child by name", async () => {
  const { home, as } = await served();
  const file = join(home, "merge.js");
  await writeFile(file, 'export default workflow({ uses: ["forge.pr.merge"], output: z.null() }, async () => null);');
  const masked = await as("parent", ["forge.*", "workflow.start"]);
  await expect(masked.call(START, { file })).rejects.toThrow("forge.pr.merge");
  const named = await as("named-parent", ["forge.pr.merge", "workflow.start"]);
  expect(await named.call(START, { file })).toMatchObject({ run: expect.stringMatching(/^run-/) });
}, 30_000);
