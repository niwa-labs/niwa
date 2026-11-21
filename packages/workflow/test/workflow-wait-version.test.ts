// A script waits for a record type at the version the host knows it by: the version is not a part
// of what the script writes, so a type at its second version answers a wait by its name.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { z } from "zod";

import { workflow, workflowStart } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

/** A type at its second version: its records carry version 2. */
const Built = record("build.finished", z.object({ id: z.string(), green: z.boolean() }), { version: 2 });

test("a wait by name answers with a record of a type the host knows at its second version", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("builds", (api) => api.declare(Built)), workflow());
  await host.serve();
  hosts.push(host);
  await host.emit(Built, { id: "b-1", green: true });
  await mkdir(home.path, { recursive: true });
  const file = join(home.path, "built.ts");
  await writeFile(
    file,
    [
      'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
      '  const built = await wait("build.finished", { filter: { id: "b-1" }, from: 0, timeout: "5s" });',
      '  return "timedOut" in built ? "timed out" : built.data;',
      "});",
    ].join("\n"),
  );
  const { run } = await host.call(workflowStart, { file });
  await eventually(
    async () => (await host.records.read({ types: ["workflow.run.finished"], filter: { run } })).length === 1,
    20_000,
    "the run should finish",
  );
  const [finished] = await host.records.read({ types: ["workflow.run.finished"], filter: { run } });
  expect((finished?.data as { outcome: { result: unknown } }).outcome.result).toEqual({ id: "b-1", green: true });
}, 60_000);
