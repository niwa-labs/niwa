// The language of a script as the check types it: the globals the checker declares answer what the host answers, and
// they agree with the types of the script package where both name the same function.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { plugin } from "@niwa-labs/plugin";
import { createNiwa, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { workflow, workflowCheck } from "../src/index.ts";
import { Ping, Pong } from "./fixtures/ping-records.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

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

/** A line of a probe: the code, and whether the type checker must refuse it. */
type Probe = readonly [code: string, refused: boolean];

/** Check a script made of probes, and say which of them the checker refused beside which it should. */
async function refusedLines(probes: readonly Probe[], extra: readonly string[] = []): Promise<{ refused: number[]; expected: number[]; other: string[] }> {
  const { host, home } = await served();
  const head = [
    `import { Ping, Pong, pingsTo } from ${JSON.stringify(RECORDS)};`,
    'import type { ScriptApi } from "@niwa-labs/script";',
    'declare const api: ScriptApi;',
    ...extra,
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
  ];
  // A `declare const` of a probe is a name given to the script: it stands outside the function.
  const given = probes.flatMap(([code]) => (code.includes(" => ") && code.startsWith("declare") ? [code.slice(0, code.indexOf(" => "))] : []));
  const body = probes.map(([code]) => `  { ${code.startsWith("declare") ? code.slice(code.indexOf(" => ") + 4) : code} }`);
  const lines = [...head.slice(0, -1), ...given, head.at(-1) as string, ...body, "  return null;", "});"];
  const before = lines.indexOf(head.at(-1) as string) + 1;
  await mkdir(home, { recursive: true });
  const file = join(home, "language.ts");
  await writeFile(file, lines.join("\n"));
  if (process.env.KEEP !== undefined) await writeFile("/tmp/language-probe.ts", lines.join("\n"));
  const errors = (await host.call(workflowCheck, { file })).errors;
  return {
    refused: [...new Set(errors.filter((error) => /^TS/.test(error.code)).map((error) => error.line - before))].sort((a, b) => a - b),
    expected: probes.flatMap(([, refused], index) => (refused ? [index + 1] : [])),
    other: errors.filter((error) => !/^TS/.test(error.code)).map((error) => `${error.code}: ${error.message}`),
  };
}

test("the check types a wait whose options may hold a timeout as one that may time out", async () => {
  const found = await refusedLines(
    [
      ["const a = { from: 1, timeout: 10 }; const got = await wait(Ping, a); const n: number = got.data.size;", true],
      ["declare const b: { timeout?: string }; => const got = await wait(Ping, b); const n: number = got.at;", true],
      ["declare const c: { timeout: number }; => const got = await wait(pingsTo('a'), c); const n: number = got.at;", true],
      ['declare const d: { timeout: number }; => const got = await wait("ping.sent", d); const n: number = got.at;', true],
      ['declare const e: { from: number; timeout: number }; => const got = await wait(Ping, e); if ("timedOut" in got) return null; const n: number = got.data.size;', false],
      ["declare const f: { from: number }; => const got = await wait(Ping, f); const n: number = got.data.size;", false],
      ['const got = await wait("ping.sent", { filter: { id: "x" } }); const n: number = got.data.size;', false],
      ['const got = await wait(Ping, { timeout: "1m" }); if ("timedOut" in got) return null; const n: number = got.data.size;', false],
    ],
  );
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);

test("the check types a wait of a query of one type that names no stream, as a read of it is", async () => {
  const found = await refusedLines([
    ["const q = { types: [Ping] as const, stream: 's' }; await wait(q);", true],
    ["const q = { types: [Ping] as const, from: 3 }; await wait(q);", false],
    ["const q = { types: [Ping] as const, stream: 's' }; await read.records(q);", false],
  ]);
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);

test("the check types a scope with a deadline as one that gives undefined past it, unless it throws", async () => {
  const found = await refusedLines([
    ['const n: number = await scope("a", { deadline: 1 }, async () => 1);', true],
    ['const n: number = await scope("a", { deadline: 1, onDeadline: "skip" }, async () => 1);', true],
    ['declare const o: { deadline?: number; onDeadline?: "skip" | "fail" }; => const n: number = await scope("a", o, async () => 1);', true],
    ['const n: number = await moveOnAfter("a", 1, async () => 1);', true],
    ['const n: number = await scope("a", { deadline: 1, onDeadline: "fail" }, async () => 1);', false],
    ['const n: number = await scope("a", { concurrency: 2 }, async () => 1);', false],
    ['const n: number = await scope("a", async () => 1);', false],
    ['const n: number = await failAfter("a", 1, async () => 1);', false],
    ['const n: number | undefined = await scope("a", { deadline: 1 }, async () => 1);', false],
  ]);
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);

test("the check types a read of a list that may be empty with data of unknown shape, and holds a filter of references to their data", async () => {
  const found = await refusedLines([
    ["declare const refs1: (typeof Ping)[]; => const { records } = await read.records({ types: refs1 }); const n: number = records[0]!.data.size;", true],
    ["const { records } = await read.records({ types: [] }); const n: number = records[0]!.data.size;", true],
    ['declare const names1: Array<"ping.sent">; => const { records } = await read.records({ types: names1 }); const n: number = records[0]!.data.size;', true],
    ['const { records } = await read.records({ types: [Ping, "other.*"] }); const n: number = records[0]!.data.size;', true],
    ['await read.records({ types: [Ping], filter: { size: "no" } });', true],
    ['await read.records({ types: ["ping.sent"], filter: { size: "no" } });', true],
    ['await read.records({ types: [Ping], filter: { nothing: 1 } });', true],
    ["const { records } = await read.records({ types: [Ping] }); const n: number = records[0]!.data.size;", false],
    ['const { records } = await read.records({ types: ["ping.sent"] }); const n: number = records[0]!.data.size;', false],
    ['const { records } = await read.records({ types: [Ping, Pong] }); for (const row of records) if ("size" in row.data) { const n: number = row.data.size; }', false],
    ["declare const refs2: (typeof Ping)[]; => await read.records({ types: refs2, filter: { anything: 1 } }); await read.records({ types: ['a.*'], filter: { anything: 1 } }); await read.records();", false],
  ]);
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);

test("the check types an agent call with a worktree as one that answers an object", async () => {
  const found = await refusedLines([
    ["await ask({ worktree: true, schema: z.string() }, 'go');", true],
    ["declare const opts: { worktree: true; schema: ReturnType<typeof z.string> }; => await ask(opts, 'go');", true],
    ["const done = await ask({ worktree: true, schema: z.object({ ok: z.boolean() }) }, 'go'); const ok: boolean = done.ok; const path: string | undefined = done.worktree?.path;", false],
    ["const text = await ask({ schema: z.string() }, 'go'); const s: string = text;", false],
    ["const answer = await ask({ worktree: { base: 'main' } }, 'go'); const a: string = answer.answer;", false],
  ]);
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);

test("the globals of the check and the types of the script package are one language where they name the same function", async () => {
  const same = ["scope", "moveOnAfter", "failAfter", "parallel", "stream", "race", "pipeline", "sleep", "now", "random", "record", "emit", "log"];
  const found = await refusedLines(
    [
      // Each pair is one type, not types that take each other: a parameter that is looser on one side is a drift.
      ...same.map((name): Probe => [`const ${name}Same: Same<typeof ${name}, ScriptApi["${name}"]> = true;`, false]),
      // The kinds of `ask` hold conditional types of their own names: each is one function of the other side's.
      ['const askOf: ScriptApi["ask"] = ask; const askBack: typeof ask = api.ask; const choice: Same<Parameters<typeof ask.choice>[0], Parameters<ScriptApi["ask"]["choice"]>[0]> = true;', false],
      ["const phaseBack: typeof phase = api.phase;", false],
      // The check itself: a pair that differs is refused.
      ['const differs: Same<typeof sleep, (duration: number) => Promise<void>> = true;', true],
    ],
    ["type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;"],
  );
  expect(found).toEqual({ refused: found.expected, expected: found.expected, other: [] });
}, 60_000);
