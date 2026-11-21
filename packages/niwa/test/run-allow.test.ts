// `allow` of a run narrows what the run may do below what `uses` and its starter give it, and
// never widens it: a call is decided on its final input against the narrowed rules, and an
// `allow` that names more than the run would have refuses the start.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { tempHome } from "@niwa-labs/testing";
import { RunRequested, workflow } from "@niwa-labs/workflow";

import { forge } from "./fixtures/forge-plugin.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const START = actionName("workflow.start");

const comment = (repo: string): string =>
  `(async () => { try { await niwa.forge.comment.create({ repo: "${repo}", pr: 1 }); return "commented"; } catch (error) { return error.message; } })()`;

test("allow narrows a run to the targets it names, and an allow wider than the run refuses the start", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(forge, workflow());
  await host.serve();
  hosts.push(host);
  const token = host.issueToken(principalOf("session", "s"), { grant: grant(["forge.comment.create", "workflow.start"]) });
  const starter = await connect({ home: home.path, id: "session:s", token });
  clients.push(starter);
  const file = join(home.path, "comment.js");
  await writeFile(file, [
    'export default workflow({ uses: ["forge.comment.create"], output: z.json() }, async () => {',
    `  return { mine: await ${comment("acme/billing")}, other: await ${comment("acme/other")} };`,
    "});",
  ].join("\n"));

  const allow = ["forge.comment.create@git.example.com/acme/billing/pr/*"];
  const done = (await starter.call(START, { file, allow, wait: true, timeoutMs: 20_000 })) as {
    run: string;
    outcome?: { status: string; result?: { mine: string; other: string } };
  };
  expect(done.outcome?.result?.mine).toBe("commented");
  expect(done.outcome?.result?.other).toContain("not in the grant");
  const requested = (await host.records.read()).filter((row) => row.type === RunRequested.name).map((row) => RunRequested.schema.parse(row.data));
  expect(requested.find((one) => one.run === done.run)?.allow).toEqual({ rules: allow, version: expect.stringMatching(/^[0-9a-f]{64}$/) });

  await expect(starter.call(START, { file, allow: ["forge.pr.merge"] })).rejects.toThrow("allow only narrows the run: forge.pr.merge is not");
}, 60_000);
