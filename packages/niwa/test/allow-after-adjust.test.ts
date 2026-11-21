// The grant of a run judges the call an action is finally made with: an adjust that moves a call
// to another target moves it under the grant again, and the decision written for a step of a run
// says which step it was and under which `allow` the run was started.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_TYPES, actionName, grant, principalOf } from "@niwa-labs/core";
import type { ActionRef } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { plugin, tempHome } from "@niwa-labs/testing";
import { RunRequested, workflow } from "@niwa-labs/workflow";

import { COMMENT, forge } from "./fixtures/forge-plugin.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const START = actionName("workflow.start");

/** Sends every comment on a pull request of acme/billing to acme/other instead. */
const redirect = plugin("redirect", (api) => {
  api.adjust({ name: COMMENT } as ActionRef<{ repo: string; pr: number }, unknown>, (input) =>
    input.repo === "acme/billing" ? { ...input, repo: "acme/other" } : undefined,
  );
});

const script = [
  'export default workflow({ uses: ["forge.comment.create"], output: z.json() }, async () => {',
  '  try { await niwa.forge.comment.create({ repo: "acme/billing", pr: 1 }); return "commented"; } catch (error) { return error.message; }',
  "});",
].join("\n");

async function started(...extra: Parameters<Host["use"]>) {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(forge, ...extra, workflow());
  await host.serve();
  hosts.push(host);
  const token = host.issueToken(principalOf("session", "s"), { grant: grant(["forge.comment.create", "workflow.start"]) });
  const starter = await connect({ home: home.path, id: "session:s", token });
  clients.push(starter);
  const file = join(home.path, "comment.js");
  await writeFile(file, script);
  return { host, starter, file };
}

const allow = ["forge.comment.create@git.example.com/acme/billing/pr/*"];

test("a call an adjust moves outside the allow of its run is denied", async () => {
  const { host, starter, file } = await started(redirect);
  const done = (await starter.call(START, { file, allow, wait: true, timeoutMs: 20_000 })) as { outcome?: { result?: string } };
  expect(done.outcome?.result).not.toBe("commented");
  const decisions = (await host.records.read())
    .filter((row) => row.type === CORE_TYPES.stepDecision)
    .map((row) => row.data as { final: { repo?: string }; denied: boolean; reason?: string })
    .filter((one) => one.final.repo === "acme/other");
  expect(decisions).toEqual([expect.objectContaining({ denied: true, reason: expect.stringContaining("not in the grant") })]);
}, 60_000);

test("the decision of a step of a run names the step and the version of its allow", async () => {
  const { host, starter, file } = await started();
  const done = (await starter.call(START, { file, allow, wait: true, timeoutMs: 20_000 })) as { run: string; outcome?: { result?: string } };
  expect(done.outcome?.result).toBe("commented");
  const rows = await host.records.read();
  const version = rows.filter((row) => row.type === RunRequested.name).map((row) => RunRequested.schema.parse(row.data)).find((one) => one.run === done.run)?.allow?.version;
  expect(version).toMatch(/^[0-9a-f]{64}$/);
  const decided = rows
    .filter((row) => row.type === CORE_TYPES.accessDecided)
    .map((row) => row.data as { name: string; outcome: string; policy?: string; step?: string })
    .find((one) => one.name === "forge.comment.create");
  expect(decided).toMatchObject({ outcome: "allowed", policy: version, step: expect.any(String) });
}, 60_000);
