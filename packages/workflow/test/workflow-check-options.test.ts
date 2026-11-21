// The typing of a script knows the options block of each harness by the kind the sessions module binds
// it to: a field the block does not have, a value of the wrong type, a field in a block that takes none
// and the block of another kind are errors of the checker, found by `workflow.check` with their place
// in the file. The hand-written types of `ScriptApi` say
// the same as the schemas the kinds declare.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { KIND_OPTIONS, OptionBlocks, harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, KindOptions } from "@niwa-labs/harness";
import { harnessGet, harnessList } from "@niwa-labs/sessions/records";
import { createNiwa, sessions, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck } from "../src/index.ts";
import type { ScriptApi } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** An installation with no side: the check only needs to know what it is bound to. */
const installed = (id: string): Harness => ({ id: harnessId(id), kind: "test" as never, machine: machineId("machine-1"), home: "/tmp/fake-home", sides: {} });

/**
 * One harness of each kind, named after its block (`claude-sonnet` a Claude Code, `codex-x` a Codex), and `bare` bound
 * to no block. The workflow module is given the names alone: the kind is the sessions module's to know.
 */
const BOUND: ReadonlyArray<readonly [string, KindOptions | undefined]> = [
  ["claude-sonnet", KIND_OPTIONS.claude],
  ...(["codex", "mcode", "ncode", "pi", "zcode"] as const).map((kind) => [`${kind}-x`, KIND_OPTIONS[kind]] as const),
  ["bare", undefined],
];

async function check(lines: readonly string[], bound: ReadonlyArray<readonly [string, KindOptions | undefined]> = BOUND) {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: bound.map(([id, options]) => ({ instance: installed(id), ...(options === undefined ? {} : { options }) })) }));
  host.use(workflow({ harnesses: bound.map(([id]) => id) }));
  await host.serve();
  hosts.push(host);
  const file = join(home.path, "script.ts");
  await mkdir(home.path, { recursive: true });
  await writeFile(file, lines.join("\n"));
  return await host.call(workflowCheck, { file });
}

const script = (call: string, harness = "claude-sonnet"): string[] => [
  "export default workflow({}, async () => {",
  `  await agent("go", { harness: ${JSON.stringify(harness)}, ${call} });`,
  "});",
];

test("the block of a kind with its own option is typed by that option", async () => {
  expect((await check(script("claude: { advisor: false }"))).ok).toBe(true);
  const wrongType = await check(script('claude: { advisor: "no" }'));
  expect(wrongType.ok).toBe(false);
  expect(wrongType.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect(wrongType.errors[0]?.message).toContain("Type 'string' is not assignable to type 'boolean | undefined'");
  const unknownField = await check(script("claude: { advisor: false, advisr: true }"));
  expect(unknownField.ok).toBe(false);
  expect(unknownField.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect(unknownField.errors[0]?.message).toContain("'advisr' does not exist");
}, 60_000);

test("the block of a kind with no option takes the empty block and nothing else, not a value that happens to be an object", async () => {
  for (const kind of ["codex", "mcode", "ncode", "pi", "zcode"]) {
    expect((await check(script(`${kind}: {}`, `${kind}-x`))).ok).toBe(true);
    const field = await check(script(`${kind}: { speed: "fast" }`, `${kind}-x`));
    expect(field.ok).toBe(false);
    expect(field.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
    expect(field.errors[0]?.message).toContain("Type 'string' is not assignable to type 'never'");
  }
  const scalar = await check(script("codex: 5", "codex-x"));
  expect(scalar.ok).toBe(false);
  expect(scalar.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect(scalar.errors[0]?.message).toContain("Type 'number' is not assignable to type 'Record<string, never>'");
}, 120_000);

test("the block of another kind is an error, and so is any block for a harness given without its kind's options or for no harness", async () => {
  const foreign = await check(script("codex: {}"));
  expect(foreign.ok).toBe(false);
  expect(foreign.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect(foreign.errors[0]?.message).toContain("Type '{}' is not assignable to type 'undefined'");
  const claudeOnCodex = await check(script("claude: { advisor: false }", "codex-x"));
  expect(claudeOnCodex.ok).toBe(false);
  expect(claudeOnCodex.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect((await check(script("claude: { advisor: false }", "bare"))).ok).toBe(false);
  // The same name, bound by the sessions module to one kind and then to another: the block follows the binding.
  expect((await check(script("claude: { advisor: false }", "same"), [["same", KIND_OPTIONS.claude]])).ok).toBe(true);
  const rebound = await check(script("claude: { advisor: false }", "same"), [["same", KIND_OPTIONS.codex]]);
  expect(rebound.ok).toBe(false);
  expect(rebound.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect((await check(script("codex: {}", "same"), [["same", KIND_OPTIONS.codex]])).ok).toBe(true);
  const none = await check(["export default workflow({}, async () => {", '  await agent("go", { claude: { advisor: false } });', "});"]);
  expect(none.ok).toBe(false);
  expect(none.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
}, 60_000);

test("a block that no kind declares is not an option of agent()", async () => {
  const report = await check(script("gemini: {}"));
  expect(report.ok).toBe(false);
  expect(report.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  expect(report.errors[0]?.message).toContain("'gemini' does not exist");
}, 60_000);

// The types of ScriptApi are written by hand, as the file has no import: they and the schemas the
// kinds declare must say the same, in both directions. A drift is an error of the type checker.
type Declared = NonNullable<Parameters<ScriptApi["agent"]>[1]>;
type Blocks = ReturnType<typeof OptionBlocks.parse>;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test("the blocks of ScriptApi say what the schemas of the kinds say", () => {
  const agree: Same<Pick<Declared, keyof Blocks>, Blocks> = true;
  expect(agree).toBe(true);
});

test("the sessions module serves each harness as an entity: harness.list names them, harness.get gives one with its block's schema", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: BOUND.map(([id, options]) => ({ instance: installed(id), ...(options === undefined ? {} : { options }) })) }));
  await host.serve();
  hosts.push(host);
  const { items } = await host.call(harnessList, {});
  expect(items.map((item): [string, string | undefined] => [item.name, item.block])).toEqual(BOUND.map(([id, options]) => [id, options?.block]));
  const claude = await host.call(harnessGet, { name: "claude-sonnet" });
  expect(claude).toMatchObject({ name: "claude-sonnet", kind: "test", block: "claude", machine: "machine-1" });
  expect(claude.options).toMatchObject({ type: "object", properties: { advisor: { type: "boolean" } } });
  const bare = await host.call(harnessGet, { name: "bare" });
  expect(bare.block).toBeUndefined();
  expect(bare.options).toBeUndefined();
  await expect(host.call(harnessGet, { name: "nope" })).rejects.toThrow(/not known/);
}, 30_000);
