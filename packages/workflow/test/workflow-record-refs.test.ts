// A script names record types by reference: it imports the type a plugin declares, and wait and
// read.records give data typed by it. The header stays a literal; references are for the body.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { workflow, workflowCheck, workflowStart } from "../src/index.ts";
import { Ping, PingAhead, Pong } from "./fixtures/ping-records.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

/** Where the script imports the types from. */
const RECORDS = join(import.meta.dir, "fixtures", "ping-records.ts");

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("ping", (api) => api.declare(Ping, Pong)), workflow());
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

async function errorsOf(host: Host, file: string): Promise<Array<{ line: number; code: string; message: string }>> {
  return (await host.call(workflowCheck, { file })).errors.map(({ line, code, message }) => ({ line, code, message }));
}

async function resultOf(host: Host, run: string): Promise<unknown> {
  await eventually(
    async () => (await host.records.read({ types: ["workflow.run.finished"], filter: { run } })).length === 1,
    20_000,
    "the run should finish",
  );
  const [finished] = await host.records.read({ types: ["workflow.run.finished"], filter: { run } });
  return (finished?.data as { outcome: unknown }).outcome;
}

const importing = (names: string): string => `import { ${names} } from ${JSON.stringify(RECORDS)};`;

test("a script waits for and reads an imported type: the data is typed by it and the run gets it", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "refs.ts", [
    importing("Ping, Pong"),
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    '  const { records, next } = await read.records(Ping, { filter: { "to.id": "owner" } });',
    '  await wait(Pong, { filter: { id: "go" } });',
    '  const first = await wait(Ping, { filter: { "to.id": "owner" }, from: next });',
    "  const size: number = first.data.size;",
    "  const both = await read.records({ types: [Ping, Pong], from: next });",
    '  const kinds = both.records.map((row) => ("size" in row.data ? `ping ${row.data.to.id}` : `pong ${String(row.data.ok)}`));',
    "  return { before: records.map((row) => row.data.id), first: first.data.id, size, kinds };",
    "});",
  ]);
  expect(await errorsOf(host, file)).toEqual([]);
  await host.emit(Ping, { id: "old", size: 1, to: { id: "owner" } });
  const { run } = await host.call(workflowStart, { file });
  await eventually(
    async () => (await host.records.read({ types: ["niwa.invocation.state"], filter: { state: "waiting" } })).length > 0,
    20_000,
    "the run should wait for the pong",
  );
  await host.emit(Ping, { id: "one", size: 3, to: { id: "owner" } });
  await host.emit(Pong, { id: "go", ok: true });
  expect(await resultOf(host, run)).toEqual({
    status: "done",
    result: { before: ["old"], first: "one", size: 3, kinds: ["ping owner", "pong true"] },
  });
}, 60_000);

test("the filter and the data of a wait or a read by reference are held to the type", async () => {
  const { host, home } = await served();
  const wrong = await scriptIn(home, "wrong.ts", [
    importing("Ping"),
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    '  await wait(Ping, { filter: { idd: "a" } });',
    "  const ping = await wait(Ping);",
    "  const { records } = await read.records(Ping);",
    "  return [ping.data.nothing, records[0]?.data.nothing];",
    "});",
  ]);
  expect((await errorsOf(host, wrong)).map(({ line, code }) => ({ line, code }))).toEqual([
    { line: 3, code: expect.stringMatching(/^TS/) },
    { line: 6, code: "TS2339" },
    { line: 6, code: "TS2339" },
  ]);
}, 60_000);

test("the host refuses a reference to a type it does not know or to a version it does not write, and a record the script writes", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "refused.js", [
    'const Ahead = { kind: "record", name: "ping.sent", version: 2, schema: z.object({ id: z.string() }) };',
    'const Unheard = { kind: "record", name: "never.sent", version: 1, schema: z.object({ id: z.string() }) };',
    'const Note = record("note", z.object({ text: z.string() }));',
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    "  const refused = async (fn) => fn().then(() => \"answered\", (error) => error.message);",
    "  return [",
    '    await refused(() => wait(Ahead, { timeout: "1s", label: "ahead" })),',
    '    await refused(() => wait(Unheard, { timeout: "1s", label: "unheard" })),',
    '    await refused(() => read.records(Ahead, {}, { label: "read-ahead" })),',
    '    await refused(() => wait(Note, { timeout: "1s", label: "note" })),',
    "  ];",
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  expect(await resultOf(host, run)).toEqual({
    status: "done",
    result: [
      expect.stringContaining('version 2 of the record type "ping.sent", and the host knows version 1'),
      expect.stringContaining('"never.sent", which the host does not know'),
      expect.stringContaining('version 2 of the record type "ping.sent"'),
      expect.stringContaining("is a record a script writes"),
    ],
  });
}, 60_000);

test("a read by reference gives the records of the type at its version; a read by name gives them all", async () => {
  const home = await tempHome();
  homes.push(home);
  const before = createNiwa({ home: home.path });
  before.use(requests(), timers([]), plugin("ping", (api) => api.declare(Ping, Pong)), workflow());
  await before.serve();
  await before.emit(Ping, { id: "old", size: 1, to: { id: "owner" } });
  await before.close();

  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("ping", (api) => api.declare(PingAhead, Pong)), workflow());
  await host.serve();
  hosts.push(host);
  await host.emit(PingAhead, { id: "new" });
  const file = await scriptIn(home.path, "versions.ts", [
    importing("PingAhead"),
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    "  const typed = await read.records(PingAhead);",
    '  const named = await read.records({ types: ["ping.sent"] });',
    "  return { typed: typed.records.map((row) => row.data.id), named: named.records.length };",
    "});",
  ]);
  expect(await errorsOf(host, file)).toEqual([]);
  const { run } = await host.call(workflowStart, { file });
  expect(await resultOf(host, run)).toEqual({ status: "done", result: { typed: ["new"], named: 2 } });
}, 60_000);

test("the types of the script package type a wait and a read by reference the same way", async () => {
  const { host, home } = await served();
  const lines = (body: readonly string[]): string[] => [
    importing("Ping, Pong"),
    'import type { ScriptApi } from "@niwa-labs/script";',
    'declare const wait: ScriptApi["wait"];',
    'declare const read: ScriptApi["read"];',
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    ...body,
    "});",
  ];
  const fine = await scriptIn(home, "api.ts", lines([
    '  const ping = await wait(Ping, { filter: { "to.id": "owner" }, from: 0 });',
    '  const pong = await wait(Pong, { filter: { ok: true }, timeout: "1m" });',
    "  const { records } = await read.records(Ping, { limit: 1 });",
    "  const both = await read.records({ types: [Ping, Pong] });",
    '  const ok: boolean = "timedOut" in pong ? false : pong.data.ok;',
    "  const size: number = ping.data.size + (records[0]?.data.size ?? 0) + both.records.length;",
    "  return { ok, size };",
  ]));
  expect(await errorsOf(host, fine)).toEqual([]);
  const wrong = await scriptIn(home, "api-wrong.ts", lines([
    '  await wait(Ping, { filter: { "to.id": 3 } });',
    "  const ping = await wait(Ping);",
    "  const { records } = await read.records(Ping);",
    "  return [ping.data.nothing, records[0]?.data.nothing];",
  ]));
  expect((await errorsOf(host, wrong)).map(({ line, code }) => ({ line, code }))).toEqual([
    { line: 6, code: expect.stringMatching(/^TS/) },
    { line: 9, code: "TS2339" },
    { line: 9, code: "TS2339" },
  ]);
}, 60_000);

test("a script that imports a package is not given the errors the package has under the options of the script", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "imports.js", [importing("Ping"), "export default workflow({}, async () => {", "  void Ping;", "});"]);
  expect(await errorsOf(host, file)).toEqual([]);
}, 60_000);
