// A built-in offered with `gated: true` comes in as a candidate: the sync registers each new version of it as one,
// and neither the latest version nor the installation moves to it. Before any version was accepted the candidate is
// shown and starts on nothing. A host that starts again with the same file counts the candidate as in place.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { record } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempDir, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowGet, workflowInstallationList, workflowList, workflowStart } from "../src/index.ts";
import { z } from "zod";

const Go = record("gated.go", z.object({ n: z.number() }));

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A plugin that ships the gated built-in `entry`. */
const shipper = (file: string) =>
  plugin("gated", (api) => {
    api.declare(Go);
    api.offer(BUILTIN_WORKFLOW, { name: "entry", file, description: "Answer every go", triggers: [Go], gated: true });
  });

function script(file: string, text: string): void {
  writeFileSync(file, `export default workflow({ on: ["gated.go"], output: z.string() }, async () => ${JSON.stringify(text)});\n`);
}

async function served(home: string, file: string): Promise<Host> {
  const host = createNiwa({ home });
  host.use(shipper(file), workflow());
  await host.serve();
  hosts.push(host);
  return host;
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> => (await host.records.read()).filter((row) => row.type === type);

test("a gated built-in with no accepted version is a candidate: shown, not installed, not started", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join(await tempDir("gated"), "entry.ts");
  script(file, "v1");
  const host = await served(home.path, file);
  await eventually(async () => (await ofType(host, "workflow.registered")).length === 1, 20_000, "the candidate was not registered");
  await Bun.sleep(300);

  const [listed] = (await host.call(workflowList, {})).items;
  const got = await host.call(workflowGet, { id: listed?.id ?? "" });
  expect(got.versions.map((one) => one.candidate)).toEqual([true]);
  expect((await host.call(workflowInstallationList, {})).items).toEqual([]);
  await expect(host.call(workflowStart, { id: listed?.id ?? "" })).rejects.toThrow("candidate");

  await host.emit(Go, { n: 1 });
  await Bun.sleep(500);
  expect(await ofType(host, "workflow.run.requested")).toEqual([]);

  // The same file again: the candidate is in place, and nothing is asked for.
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  const again = await served(home.path, file);
  await Bun.sleep(500);
  expect(await ofType(again, "workflow.builtins.wanted")).toHaveLength(1);
  expect(await ofType(again, "workflow.registered")).toHaveLength(1);
}, 60_000);
