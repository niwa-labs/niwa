// What a script declares is read once for one version of its code (the hash of its source closure): a second
// check, a registration or a start of the same code spawns no child, an edit of the script or of a file it imports
// is read again, a registered version is known from the journal, and the modules read at once are bounded.

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { JournalReader, StoredRecord } from "@niwa-labs/core";
import { createNiwa, requests, eventually, tempDir, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowRegister } from "../src/index.ts";

import { describer, readings } from "../src/describe-cache.ts";
import { describeScript } from "../src/describe.ts";
import type { DescribeResult } from "../src/describe.ts";
import { declaredBy, versionOf } from "../src/registry.ts";
import type { ScriptBox } from "../src/runner.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

const written = async (dir: string, name: string, lines: readonly string[]): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, lines.join("\n"));
  return file;
};

/** A script that writes a mark every time its top level runs: the marks are the processes that loaded it. */
const marking = (counter: string): string[] => [
  'import { appendFileSync } from "node:fs";',
  'import { kind } from "./kind.ts";',
  `appendFileSync(${JSON.stringify(counter)}, "x");`,
  "export default workflow({",
  '  description: "Marks every load",',
  '  output: kind === "number" ? z.number() : z.string(),',
  "}, async () => 1);",
];

const kindFile = (kind: "number" | "string"): string => `export const kind: "number" | "string" = ${JSON.stringify(kind)};\n`;

const loads = (counter: string): number => readFileSync(counter, "utf8").length;

/** A journal over the records a host wrote, answering the way the module asks it: by the type of a record. */
const journalOf = (rows: readonly StoredRecord[]): JournalReader => ({
  get: (id) => rows.find((row) => row.id === id),
  since: (from) => rows.filter((row) => row.seq > from),
  find: (query) => rows.filter((row) => row.type === query.type),
  last: () => rows.at(-1)?.seq ?? seq(0),
});

test("a second check of the same code spawns no child, and an edit of the script or of a file it imports is read again", async () => {
  const { host, home } = await served();
  const counter = join(home, "loads");
  writeFileSync(counter, "");
  await writeFile(join(home, "kind.ts"), kindFile("number"));
  const file = await written(home, "marking.ts", marking(counter));

  const first = await host.call(workflowCheck, { file });
  expect(first.ok).toBe(true);
  expect(loads(counter)).toBe(1);

  const again = await host.call(workflowCheck, { file });
  expect(again).toEqual(first);
  // Registering is a check too: the same code, so the module is not loaded for it.
  await host.call(workflowRegister, { file });
  expect(loads(counter)).toBe(1);

  // The schema is in a file the script imports: its edit is another version of the script.
  await writeFile(join(home, "kind.ts"), kindFile("string"));
  const edited = await host.call(workflowCheck, { file });
  expect(edited.output).toEqual({ type: "string" });
  expect(edited.contract).not.toBe(first.contract);
  expect(loads(counter)).toBe(2);

  // A comment in the script is another version as well.
  await writeFile(file, `${marking(counter).join("\n")}\n// edited\n`);
  await host.call(workflowCheck, { file });
  expect(loads(counter)).toBe(3);
  await host.call(workflowCheck, { file });
  expect(loads(counter)).toBe(3);
}, 60_000);

test("a module that could not be read is read again, and a module read in a box is not taken from one that was not", async () => {
  const dir = await tempDir("describe-cache");
  const file = await written(dir, "one.ts", ["export default 1;"]);
  const box: ScriptBox = { sandbox: "srt", denyRead: [] };
  const calls: Array<{ boxed: boolean }> = [];
  let outcome: DescribeResult = { failed: "it threw" };
  const describe = describer({
    readings: readings(),
    read: async (_file, boxed) => {
      calls.push({ boxed: boxed !== undefined });
      return outcome;
    },
  });

  expect(await describe(file)).toEqual({ failed: "it threw" });
  expect(await describe(file)).toEqual({ failed: "it threw" });
  expect(calls).toHaveLength(2);

  outcome = { described: { description: "one", problems: [] } };
  await describe(file);
  await describe(file);
  expect(calls).toHaveLength(3);

  await describe(file, box);
  await describe(file, box);
  expect(calls).toEqual([{ boxed: false }, { boxed: false }, { boxed: false }, { boxed: true }]);
});

test("a file that is edited while it is read is not kept under the version it had before", async () => {
  const dir = await tempDir("describe-cache");
  const original = "export default 1;";
  const file = await written(dir, "moving.ts", [original]);
  let reads = 0;
  const describe = describer({
    readings: readings(),
    read: async () => {
      reads += 1;
      if (reads === 1) writeFileSync(file, "export default 2;");
      return { described: { problems: [] } };
    },
  });
  await describe(file);
  // The file is as it was when the first reading began: what that reading saw was not this version.
  writeFileSync(file, original);
  await describe(file);
  expect(reads).toBe(2);
  await describe(file);
  expect(reads).toBe(2);
});

test("a registered version is known from its registration, and what is rebuilt is what the module declares", async () => {
  const { host, home } = await served();
  const file = await written(home, "sweep.ts", [
    'const Blocked = record("blocked", z.object({ repo: z.string(), reasons: z.array(z.string()) }));',
    "export default workflow({",
    '  name: "sweep",',
    '  description: "Sweep the repos",',
    "  input: z.object({ repo: z.string() }),",
    "  output: z.number(),",
    "  emits: [Blocked],",
    "}, async () => 1);",
  ]);
  const registered = await host.call(workflowRegister, { file });
  const journal = journalOf(await host.records.read(seq(0)));

  const version = versionOf(file);
  expect(version).toBe(registered.version);
  const rebuilt = declaredBy(journal, registered.version);
  const read = await describeScript(file);
  expect(rebuilt).toEqual("described" in read ? read.described : undefined);

  let reads = 0;
  const describe = describer({
    readings: readings(),
    known: (known, boxed) => (boxed ? undefined : declaredBy(journal, known)),
    read: async (path, boxed, run) => {
      reads += 1;
      return describeScript(path, boxed, run);
    },
  });
  expect(await describe(file)).toEqual(read);
  expect(reads).toBe(0);

  // A version the journal does not hold is read.
  await writeFile(file, `${await Bun.file(file).text()}\n// edited\n`);
  await describe(file);
  expect(reads).toBe(1);
}, 60_000);

test("the modules read at once are bounded, and the ask for one version that is being read waits for that reading", async () => {
  const dir = await tempDir("describe-cache");
  const files = await Promise.all(Array.from({ length: 10 }, (_, at) => written(dir, `s${String(at)}.ts`, [`export default ${String(at)};`])));
  const release: Array<() => void> = [];
  let going = 0;
  let peak = 0;
  let started = 0;
  const describe = describer({
    readings: readings(3),
    read: async () => {
      started += 1;
      going += 1;
      peak = Math.max(peak, going);
      await new Promise<void>((done) => release.push(done));
      going -= 1;
      return { described: { problems: [] } };
    },
  });

  const all = Promise.all(files.map((file) => describe(file)));
  // The same version asked again while it is being read is that reading.
  const same = describe(files[0] as string);
  await eventually(() => release.length === 3);
  expect(started).toBe(3);

  let ended = 0;
  while (ended < files.length) {
    await eventually(() => release.length > 0);
    release.shift()?.();
    ended += 1;
    await Bun.sleep(1);
  }
  await all;
  await same;
  expect(started).toBe(10);
  expect(peak).toBe(3);
});

test("the readings of the process are shared: a version read for one describer is not read for another", async () => {
  const dir = await tempDir("describe-cache");
  const file = await written(dir, "shared.ts", [`export default ${JSON.stringify(crypto.randomUUID())};`]);
  let reads = 0;
  const read = async (): Promise<DescribeResult> => {
    reads += 1;
    return { described: { problems: [] } };
  };
  await describer({ read })(file);
  await describer({ read })(file);
  expect(reads).toBe(1);
});
