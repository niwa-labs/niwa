// Typed emits, waits and reads of a script: `workflow({ emits: [record(name, schema)] })` declares the records a
// script writes (only those, their data held to the schema, on the host too), and `wait`, `read.records` and the
// filter of a wait are typed by the record catalogue the trigger typing is made from.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, requests, eventually, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowGet, workflowRegister, workflowStart } from "../src/index.ts";
import { z } from "zod";

import { emittedTypesOf } from "../src/describe.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const Ping = record("ping.sent", z.object({ id: z.string(), size: z.number(), to: z.object({ id: z.string() }) }));
/** A type the host knows that no script starts on: a wait for it is typed by name. */
const Pong = record("pong.sent", z.object({ id: z.string(), ok: z.boolean() }));

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("ping", (api) => api.declare(Ping, Pong)), workflow({ triggers: [Ping] }));
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

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> => (await host.records.read()).filter((row) => row.type === type);

const Blocked = [
  'const Blocked = record("blocked", z.object({ repo: z.string(), pr: z.number().int(), reasons: z.array(z.string()) }));',
  'export default workflow({ name: "sweep", emits: [Blocked], output: z.number() }, async () => {',
  '  await emit(Blocked, { repo: "niwa", pr: 7, reasons: ["red"] });',
  "  return 1;",
  "});",
];

test("check lists the records a script emits under wf.<name>., with their schemas, and they are part of the contract", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "sweep.ts", Blocked);
  const report = await host.call(workflowCheck, { file });
  expect(report.ok).toBe(true);
  expect(report.emits).toEqual([
    {
      record: "blocked",
      type: "wf.sweep.blocked",
      schema: expect.objectContaining({ type: "object", required: ["repo", "pr", "reasons"] }),
    },
  ]);
  const bare = await scriptIn(home, "bare.ts", ['export default workflow({ name: "sweep", output: z.number() }, async () => 1);']);
  const without = await host.call(workflowCheck, { file: bare });
  expect(without.emits).toBeUndefined();
  expect(without.contract).not.toBe(report.contract);
  expect(emittedTypesOf({ described: { name: "sweep", emits: [{ name: "blocked", schema: { type: "object" } }], problems: [] } })).toEqual([
    { record: "blocked", type: "wf.sweep.blocked", schema: { type: "object" } },
  ]);
  expect(emittedTypesOf({ described: { emits: [{ name: "blocked", schema: { type: "object" } }], problems: [] } })).toEqual([]);
}, 60_000);

test("a run writes the record it declares, as wf.<name>.<record>, with the data its schema parsed", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "sweep.ts", Blocked);
  await host.call(workflowStart, { file });
  await eventually(async () => (await ofType(host, "workflow.run.finished")).length === 1, 20_000, "the run should finish");
  expect((await ofType(host, "wf.sweep.blocked")).map((row) => row.data)).toEqual([{ repo: "niwa", pr: 7, reasons: ["red"] }]);
}, 60_000);

test("a record of emits that says nothing is a schema error; emits that is not a list is an emit error", async () => {
  const { host, home } = await served();
  const loose = await scriptIn(home, "loose.ts", [
    'const Any = record("any", z.object({ value: z.unknown() }));',
    'export default workflow({ name: "loose", emits: [Any] }, async () => {});',
  ]);
  expect((await host.call(workflowCheck, { file: loose })).errors).toMatchObject([{ code: "schema", line: 2, message: expect.stringContaining('the record "any"') }]);
  const opaque = await scriptIn(home, "opaque.ts", [
    'const list = [record("one", z.object({}))];',
    'export default workflow({ name: "opaque", emits: list }, async () => {});',
  ]);
  expect((await host.call(workflowCheck, { file: opaque })).errors).toMatchObject([{ code: "emit", line: 2 }]);
}, 60_000);

test("the host holds the data of an emit to the declared schema, whatever the script process parsed", async () => {
  const { host, home } = await served();
  // A plain JS script swaps the schema of its record after the declaration was read: the child's parse lets anything by.
  const file = await scriptIn(home, "swapped.js", [
    'const Note = record("note", z.object({ text: z.string() }));',
    'export default workflow({ name: "swapped", emits: [Note], output: z.string() }, async () => {',
    "  Note.schema = z.json();",
    "  try {",
    "    await emit(Note, { text: 3 });",
    '    return "written";',
    "  } catch (error) {",
    "    return error.message;",
    "  }",
    "});",
  ]);
  await host.call(workflowStart, { file });
  await eventually(async () => (await ofType(host, "workflow.run.finished")).length === 1, 20_000, "the run should finish");
  const finished = (await ofType(host, "workflow.run.finished"))[0]?.data as { outcome: { result: string } };
  expect(finished.outcome.result).toContain("does not pass the record's schema");
  expect(await ofType(host, "wf.swapped.note")).toHaveLength(0);
}, 60_000);

/** The errors of a check, with the line and the code. */
async function errorsOf(host: Host, file: string): Promise<Array<{ line: number; code: string; message: string }>> {
  return (await host.call(workflowCheck, { file })).errors.map(({ line, code, message }) => ({ line, code, message }));
}

test("emit takes data of the record's schema, and wait and read.records give data typed by the type", async () => {
  const { host, home } = await served();
  const typed = await scriptIn(home, "typed.ts", [
    'const Note = record("note", z.object({ text: z.string() }));',
    'export default workflow({ name: "typed", emits: [Note], output: z.number() }, async () => {',
    "  const { data: ping } = await wait(\"ping.sent\", { filter: { \"to.id\": \"owner\" } });",
    "  const pong = await wait(\"pong.sent\", { timeout: \"1m\" });",
    "  const ok: boolean = \"timedOut\" in pong ? false : pong.data.ok;",
    '  const { records: rows } = await read.records({ types: ["ping.sent", "pong.sent"], limit: 2 });',
    '  const sizes = rows.map((row) => (row.type === "ping.sent" ? row.data.size : row.data.ok ? 1 : 0));',
    "  await emit(Note, { text: ping.id });",
    "  return ping.size + sizes.length + (ok ? 1 : 0);",
    "});",
  ]);
  expect(await errorsOf(host, typed)).toEqual([]);

  const wrong = await scriptIn(home, "wrong.ts", [
    'const Note = record("note", z.object({ text: z.string() }));',
    'export default workflow({ name: "wrong", emits: [Note], output: z.number() }, async () => {',
    "  await emit(Note, { text: 1 });",
    '  const { data: ping } = await wait("ping.sent");',
    "  const pong = await wait(\"pong.sent\", { timeout: \"1m\" });",
    "  if (pong.ok) return 0;",
    '  await wait("no.such.type");',
    "  return ping.nothing;",
    "});",
  ]);
  expect((await errorsOf(host, wrong)).map(({ line, code }) => ({ line, code }))).toEqual([
    { line: 3, code: "TS2322" },
    { line: 6, code: "TS2339" },
    { line: 7, code: "TS2769" },
    { line: 8, code: "TS2339" },
  ]);
}, 60_000);

test("the filter of a wait is held to the schema of its type: an unknown path and a literal the field cannot hold are errors, in JS too", async () => {
  const { host, home } = await served();
  const waiting = (filter: string): string[] => [
    "export default workflow({ uses: [\"niwa.records.read\"] }, async () => {",
    `  await wait("ping.sent", { filter: ${filter} });`,
    "});",
  ];
  const typo = await errorsOf(host, await scriptIn(home, "typo.js", waiting('{ idd: "a" }')));
  expect(typo).toEqual([{ line: 2, code: "wait", message: expect.stringContaining('names "idd"') }]);
  const kind = await errorsOf(host, await scriptIn(home, "kind.js", waiting('{ "to.id": 3 }')));
  expect(kind).toEqual([{ line: 2, code: "wait", message: expect.stringContaining("cannot hold") }]);
  // In TypeScript the type checker says it too.
  expect((await errorsOf(host, await scriptIn(home, "typo.ts", waiting('{ idd: "a" }')))).map(({ code }) => code)).toEqual(["wait", "TS2769"]);
  expect(await errorsOf(host, await scriptIn(home, "fine.ts", waiting('{ id: "a", "to.id": "owner" }')))).toEqual([]);
}, 60_000);

test("the records a registered workflow declares join the catalogue: a check made before the registration does not keep its answer", async () => {
  const { host, home } = await served();
  // Nobody has registered `sweep`: its records are of any shape, so a filter on a field of them is not held to anything.
  const waiter = await scriptIn(home, "waiter.ts", [
    'export default workflow({ description: "Wait for a block", output: z.number() }, async () => {',
    '  const blocked = await wait("wf.sweep.blocked", { filter: { pr: "seven" } });',
    '  return "timedOut" in blocked ? 0 : blocked.data.pr;',
    "});",
  ]);
  const before = await errorsOf(host, waiter);
  expect(before.map(({ code }) => code)).not.toContain("wait");

  const sweep = await scriptIn(home, "sweep.ts", [
    'const Blocked = record("blocked", z.object({ repo: z.string(), pr: z.number().int(), reasons: z.array(z.string()) }));',
    'export default workflow({ name: "sweep", description: "Sweep the pull requests", emits: [Blocked], output: z.number() }, async () => {',
    '  await emit(Blocked, { repo: "niwa", pr: 7, reasons: ["red"] });',
    "  return 1;",
    "});",
  ]);
  const registered = await host.call(workflowRegister, { file: sweep });
  expect(registered.added).toBe(true);
  const shown = await host.call(workflowGet, { id: registered.id });
  expect(shown.versions[0]?.emits).toEqual([{ record: "blocked", type: "wf.sweep.blocked", schema: expect.objectContaining({ type: "object" }) }]);

  // The same script, the same text, on the same host: the answer is the one of the catalogue now.
  const after = await errorsOf(host, waiter);
  expect(after.map(({ code }) => code)).toEqual(["wait", "TS2769"]);
  expect(after[0]?.message).toContain("cannot hold");

  // A script that waits for the record the right way passes, and a field the type does not have is a type error.
  const fine = await scriptIn(home, "fine.ts", [
    'export default workflow({ description: "Wait for a block", output: z.number() }, async () => {',
    '  const blocked = await wait("wf.sweep.blocked", { filter: { pr: 7 } });',
    '  return "timedOut" in blocked ? 0 : blocked.data.pr;',
    "});",
  ]);
  expect(await errorsOf(host, fine)).toEqual([]);
  const nothing = await scriptIn(home, "nothing.ts", [
    'export default workflow({ description: "Wait for a block", output: z.number() }, async () => {',
    '  const blocked = await wait("wf.sweep.blocked");',
    '  return "timedOut" in blocked ? 0 : blocked.data.nothing;',
    "});",
  ]);
  expect((await errorsOf(host, nothing)).map(({ code }) => code)).toEqual(["TS2339"]);

  // A script that starts on the record is typed by it too: the filter of `on` is held to the schema.
  const reacting = (filter: string): string[] => [
    `export default workflow({ description: "React to a block", on: [{ type: "wf.sweep.blocked", filter: ${filter} }], output: z.number() }, async (trigger) => trigger.data.pr);`,
  ];
  expect(await errorsOf(host, await scriptIn(home, "reacts.ts", reacting('{ pr: 7 }')))).toEqual([]);
  expect((await errorsOf(host, await scriptIn(home, "reacts-wrong.ts", reacting('{ pr: "seven" }')))).length).toBeGreaterThan(0);
}, 90_000);

test("a script reads up to a position and waits on from it: records written in between are not missed", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "cursor.ts", [
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    '  const { records, next } = await read.records({ types: ["ping.sent"], filter: { "to.id": "owner" } });',
    '  await wait("pong.sent", { filter: { id: "go" } });',
    '  const first = await wait("ping.sent", { filter: { "to.id": "owner" }, from: next });',
    '  const second = await wait("ping.sent", { filter: { "to.id": "owner" }, from: first.at });',
    "  return { before: records.map((row) => row.data.id), after: [first.data.id, second.data.id], ordered: first.at < second.at };",
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
  // Both pings are written while the script waits for something else: its later waits find them by the position.
  await host.emit(Ping, { id: "one", size: 1, to: { id: "owner" } });
  await host.emit(Ping, { id: "elsewhere", size: 1, to: { id: "else" } });
  await host.emit(Ping, { id: "two", size: 1, to: { id: "owner" } });
  await host.emit(Pong, { id: "go", ok: true });
  await eventually(async () => (await ofType(host, "workflow.run.finished")).length === 1, 20_000, "the run should finish");
  const finished = (await ofType(host, "workflow.run.finished"))[0]?.data as { run: string; outcome: { result: unknown } };
  expect(finished.run).toBe(run);
  expect(finished.outcome.result).toEqual({ before: ["old"], after: ["one", "two"], ordered: true });
}, 60_000);
