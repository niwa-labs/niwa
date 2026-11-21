// Chaining: a script starts on what another script emits (`wf.*`), with no composition setup, and
// `triggers` takes a type name as well as a type.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { createNiwa, requests, eventually, tempHome, stub } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


const INSTALL = actionName("workflow.install");
const START = actionName("workflow.start");

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(triggers?: ReadonlyArray<string>): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), stub(home.path), workflow(triggers === undefined ? {} : { triggers }));
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, lines.join("\n"));
  return file;
}

const finished = async (host: Host): Promise<StoredRecord[]> =>
  (await host.records.read()).filter((row) => row.type === "workflow.run.finished");

test("a script installed on a wf.* type starts on what another script emits", async () => {
  const { host, home } = await served();
  const ticker = await scriptIn(home, "ticker.js", [
    'export default workflow({ on: [{ type: "wf.long.tick", filter: { n: 2 } }], output: z.json() }, async (trigger) => { return { got: trigger.data.n }; });',
  ]);
  await host.call(INSTALL, { file: ticker, description: "ticker" });
  const long = await scriptIn(home, "long.js", [
    'const Tick = record("tick", z.object({ n: z.number() }));',
    'export default workflow({ name: "long", emits: [Tick], output: z.string() }, async () => { await emit(Tick, { n: 1 }); await emit(Tick, { n: 2 }); return "emitted"; });',
  ]);
  await host.call(START, { file: long });
  await eventually(async () => (await finished(host)).length === 2, 20_000, "the second tick should start the ticker");
  const results = (await finished(host)).map((row) => (row.data as { outcome: { result: unknown } }).outcome.result);
  expect(results).toContainEqual({ got: 2 });
  expect(results).toContain("emitted");
  expect(results).toHaveLength(2);
}, 30_000);

test("triggers takes names: a wf type needs no declaration, a declared type is found, an unknown one is named", async () => {
  const { host } = await served(["wf.long.tick", "stub.finished"]);
  expect(host).toBeDefined();
  const home = await tempHome();
  homes.push(home);
  expect(() => createNiwa({ home: home.path }).use(workflow({ triggers: ["no.such.type"] }))).toThrow(/no\.such\.type/);
  expect(() => createNiwa({ home: home.path }).use(workflow({ triggers: ["no.such.type"] }))).toThrow(/workflow/);
}, 30_000);

test("a script that emits the type it starts on does not start itself again, however many scripts are in the way", async () => {
  const { host, home } = await served();
  const loop = await scriptIn(home, "loop.js", [
    'const Tick = record("tick", z.object({ n: z.number() }));',
    'export default workflow({ name: "loop", on: [{ type: "wf.loop.tick" }], emits: [Tick], output: z.json() }, async (trigger) => { await emit(Tick, { n: (trigger?.data?.n ?? 0) + 1 }); return \"x\"; });',
  ]);
  await host.call(INSTALL, { file: loop, description: "loop" });
  await host.call(START, { file: loop });
  await eventually(async () => (await finished(host)).length >= 2, 20_000, "the first tick starts the installation once");
  await Bun.sleep(1500);
  expect(await finished(host)).toHaveLength(2);
}, 30_000);
