// The types of the script API as a script meets them: snippets are type-checked against `src/script-api.ts`, and a call
// that the host would answer differently from what its type says is an error, not a value the script may misuse.

import { join } from "node:path";

import { expect, test } from "bun:test";
import ts from "typescript";

const FILE = join(import.meta.dir, "snippet.ts");

const PREFACE = [
  'import type { ScriptApi, ScriptRecordRef, ScriptTypeQuery } from "../src/script-api.ts";',
  'import { z } from "zod";',
  "declare const api: ScriptApi;",
  "declare const Ping: ScriptRecordRef<{ count: number; id: string }>;",
  "declare const Pong: ScriptRecordRef<{ ok: boolean }>;",
];

/** The type errors of a snippet of a script, by the text of the first line of each. */
function errorsOf(lines: readonly string[]): string[] {
  // A `declare const` of a snippet is a name given to the script: it stands outside the function.
  const given = lines.filter((line) => line.startsWith("  declare const ")).map((line) => line.trim());
  const body = lines.filter((line) => !line.startsWith("  declare const "));
  const text = [...PREFACE, ...given, "export async function main() {", ...body, "}"].join("\n");
  const before = PREFACE.length + given.length + 1;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.readFile = (name) => (name === FILE ? text : read(name));
  host.fileExists = (name) => name === FILE || exists(name);
  host.getSourceFile = (name, language, ...rest) => (name === FILE ? ts.createSourceFile(name, text, language, true) : source(name, language, ...rest));
  const program = ts.createProgram([FILE], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(FILE))
    .map((diagnostic) => `${String(ts.getLineAndCharacterOfPosition(diagnostic.file as ts.SourceFile, diagnostic.start as number).line + 1 - before)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 120)}`);
}

test("a wait whose options may hold a timeout may answer that it timed out", () => {
  expect(errorsOf(["  const opts = { from: 1, timeout: 10 };", "  const got = await api.wait(Ping, opts);", "  const count: number = got.data.count;"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  declare const opts: { timeout?: string };", "  const got = await api.wait(Ping, opts);", "  const at: number = got.at;"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  declare const opts: { timeout: number };", '  const got = await api.wait("a.b", opts);', "  const at: number = got.at;"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  declare const opts: { timeout: number };", "  declare const query: ScriptTypeQuery<typeof Ping>;", "  const got = await api.wait(query, opts);", "  const at: number = got.at;"]).length).toBeGreaterThan(0);
  expect(
    errorsOf(["  declare const opts: { from: number; timeout: number };", "  const got = await api.wait(Ping, opts);", '  if ("timedOut" in got) return;', "  const count: number = got.data.count;"]),
  ).toEqual([]);
  // Options with no timeout, written out or in a variable, answer the record.
  expect(errorsOf(["  declare const opts: { from: number };", "  const got = await api.wait(Ping, opts);", "  const count: number = got.data.count;", "  const again = await api.wait(Ping, { filter: { id: 'x' } });", "  const id: string = again.data.id;"])).toEqual([]);
  expect(errorsOf(["  const got = await api.wait(Ping, { timeout: '1m' });", '  if ("timedOut" in got) return;', "  const count: number = got.data.count;"])).toEqual([]);
});

test("a wait takes a query of one type that names no stream, as a read does", () => {
  expect(errorsOf(["  const query = { types: [Ping] as const, stream: 's' };", "  await api.wait(query);"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  const query = { types: [Ping] as const, from: 3 };", "  await api.wait(query);"])).toEqual([]);
  expect(errorsOf(["  const query = { types: [Ping] as const, stream: 's' };", "  await api.read.records(query);"])).toEqual([]);
});

test("a scope with a deadline gives undefined past it unless it is told to throw", () => {
  const number = (opts: string) => errorsOf([`  const n: number = await api.scope("a", ${opts}, async () => 1);`]);
  expect(number("{ deadline: 1 }").length).toBeGreaterThan(0);
  expect(number('{ deadline: 1, onDeadline: "skip" }').length).toBeGreaterThan(0);
  expect(number("{ concurrency: 2, deadline: 1 }").length).toBeGreaterThan(0);
  expect(errorsOf(['  declare const opts: import("../src/script-api.ts").ScopeOptions;', '  const n: number = await api.scope("a", opts, async () => 1);']).length).toBeGreaterThan(0);
  expect(number('{ deadline: 1, onDeadline: "fail" }')).toEqual([]);
  expect(number("{ concurrency: 2 }")).toEqual([]);
  expect(number("undefined")).toEqual([]);
  expect(errorsOf(['  const n: number = await api.scope("a", async () => 1);'])).toEqual([]);
  expect(errorsOf(['  const n: number | undefined = await api.scope("a", { deadline: 1 }, async () => 1);'])).toEqual([]);
});

test("a read of a list that may be empty gives data of unknown shape, and one of references written out gives theirs", () => {
  expect(errorsOf(["  declare const refs: (typeof Ping)[];", "  const { records } = await api.read.records({ types: refs });", "  const count: number = records[0]!.data.count;"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  const { records } = await api.read.records({ types: [] });", "  const count: number = records[0]!.data.count;"]).length).toBeGreaterThan(0);
  expect(errorsOf(['  const { records } = await api.read.records({ types: [Ping, "other.*"] });', "  const count: number = records[0]!.data.count;"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  const { records } = await api.read.records({ types: [Ping] });", "  const count: number = records[0]!.data.count;"])).toEqual([]);
  expect(errorsOf(["  const { records } = await api.read.records({ types: [Ping, Pong] });", '  for (const row of records) if ("count" in row.data) { const n: number = row.data.count; }'])).toEqual([]);
  expect(errorsOf(["  declare const refs: (typeof Ping)[];", "  await api.read.records({ types: refs, filter: { anything: 1 } });", '  await api.read.records({ types: ["a.*"], filter: { anything: 1 } });', "  await api.read.records();"])).toEqual([]);
});

test("a filter of a read of references is held to their data, and is not let through by another overload", () => {
  expect(errorsOf(['  await api.read.records({ types: [Ping], filter: { count: "no" } });']).length).toBeGreaterThan(0);
  expect(errorsOf(["  await api.read.records({ types: [Ping], filter: { nothing: 1 } });"]).length).toBeGreaterThan(0);
  expect(errorsOf(['  await api.read.records(Ping, { filter: { count: "no" } });']).length).toBeGreaterThan(0);
  expect(errorsOf(["  await api.read.records({ types: [Ping], filter: { count: 1 } });", '  await api.read.records({ types: [Ping, Pong], filter: { id: "a" } });'])).toEqual([]);
});

test("an agent call with a worktree answers an object, so the worktree can ride along", () => {
  expect(errorsOf(["  await api.ask({ worktree: true, schema: z.string() }, 'go');"]).length).toBeGreaterThan(0);
  expect(errorsOf(["  declare const opts: { worktree: true; schema: z.ZodString };", "  await api.ask(opts, 'go');"]).length).toBeGreaterThan(0);
  expect(
    errorsOf([
      "  const done = await api.ask({ worktree: true, schema: z.object({ ok: z.boolean() }) }, 'go');",
      "  const ok: boolean = done.ok;",
      "  const path: string | undefined = done.worktree?.path;",
      "  const text = await api.ask({ schema: z.string() }, 'go');",
      "  const s: string = text;",
      "  const answer = await api.ask({ worktree: { base: 'main' } }, 'go');",
      "  const a: string = answer.answer;",
    ]),
  ).toEqual([]);
});
