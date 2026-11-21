// A new version of a registered workflow is registered by whoever made the workflow, or the
// owner: another subject that may register workflows cannot move the latest version of one it
// did not make.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { connectAsOwner, tempHome } from "@niwa-labs/testing";
import { workflow, workflowGet, workflowRegister } from "@niwa-labs/workflow";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const script = (n: number): string =>
  `export default workflow({ description: "Answer a number", output: z.number() }, async () => ${String(n)});`;

test("only the maker of a workflow and the owner register its new versions", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(workflow());
  await host.serve();
  hosts.push(host);
  const as = async (name: string): Promise<NiwaApi> => {
    const token = host.issueToken(principalOf("session", name), { grant: grant(["workflow.register", "workflow.get"]) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    clients.push(client);
    return client;
  };
  const maker = await as("maker");
  const other = await as("other");
  const file = (n: number): string => join(home.path, `v${String(n)}.js`);
  for (const n of [1, 2, 3, 4]) await writeFile(file(n), script(n));

  const made = await maker.call(workflowRegister, { file: file(1) });
  await expect(other.call(workflowRegister, { file: file(2), id: made.id })).rejects.toThrow(
    `only the owner or whoever made it may register a version of the workflow ${made.id}`,
  );
  expect((await maker.call(workflowGet, { id: made.id })).versions).toHaveLength(1);

  expect((await maker.call(workflowRegister, { file: file(3), id: made.id })).added).toBe(true);
  const owner = await connectAsOwner(home.path);
  clients.push(owner);
  expect((await owner.call(workflowRegister, { file: file(4), id: made.id })).added).toBe(true);
  expect((await maker.call(workflowGet, { id: made.id })).versions).toHaveLength(3);
}, 60_000);
