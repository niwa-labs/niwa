// The typing of `ask()` and `pipeline` in a script: the harness is one of the
// instances the host serves a `session.start.<harness>` action for, the model and the effort are literals where the
// adapter lists them, the options block is the one the sessions module binds the harness to and no other, and a pipeline of two to four stages hands each stage the typed value of the one before.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { ActionDescription, ActionName, JsonSchema } from "@niwa-labs/core";
import { NoOptions } from "@niwa-labs/harness";
import { createNiwa, describe, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { sessionAgent, workflow, workflowCheck } from "../src/index.ts";

import { scriptChecker } from "../src/check.ts";
import { scriptTyping } from "../src/script-types.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** An action as the host describes it, with the input given. */
function described(name: string, input: z.ZodType): ActionDescription {
  const one = describe({
    actions: [action(name, { description: `The action ${name}.`, input, output: z.object({}), recovery: "repeat", effect: "write", run: () => ({}) })],
    types: [],
  }).actions[0];
  if (one === undefined) throw new Error("no description");
  return one;
}

// The agent actions as the workflow module serves them, so the typing is made from the schemas a host really describes.
const catalogue = [
  described("session.start.codex", sessionAgent("codex", { models: ["gpt-5", "gpt-5-mini"], efforts: ["low", "high"] }).input),
  described("session.start.mcode-work", sessionAgent("mcode-work").input),
  described("session.start.claude-work", sessionAgent("claude-work").input),
  described("session.start.bare", sessionAgent("bare").input),
  described("flow.wf-a3f9c2", z.object({ n: z.number() })),
];
const names = catalogue.map((entry) => entry.name);
// The blocks as the sessions module binds the harnesses (`harness.list`); `bare` is bound to none.
const schemaOf = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
const blocks = new Map([
  ["codex", { block: "codex", schema: schemaOf(NoOptions) }],
  ["mcode-work", { block: "mcode", schema: schemaOf(NoOptions) }],
  ["claude-work", { block: "claude", schema: schemaOf(z.strictObject({ advisor: z.boolean().optional() })) }],
] as const);
const file = join(process.cwd(), "agent-typing-probe.ts");

async function errorsOf(lines: readonly string[], actions = catalogue, callable: readonly ActionName[] = names) {
  const text = ["export default workflow({ output: z.json() }, async () => {", ...lines, "  return null;", "});"].join("\n");
  return (await scriptChecker()({ file, text }, { actions, callable, blocks })).errors;
}

test("a harness the host serves is accepted, with the model and the effort it lists", async () => {
  expect(
    await errorsOf([
      '  await ask({ harness: "codex", model: "gpt-5", effort: "high" }, "a");',
      '  await ask({ harness: "mcode-work", model: "any-model", effort: "any-effort", mode: "ask", cwd: "/tmp" }, "b");',
      '  await ask({ label: "no harness" }, "c");',
      '  await ask({}, "d");',
    ]),
  ).toEqual([]);
});

test("an unknown harness is an error of the check", async () => {
  const errors = await errorsOf(['  await ask({ harness: "nope" }, "a");']);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ line: 2, code: "TS2769" });
});

test("a model or an effort outside the list of its adapter is an error, and another harness is not held to it", async () => {
  const model = await errorsOf(['  await ask({ harness: "codex", model: "gpt-9" }, "a");']);
  expect(model).toHaveLength(1);
  expect(model[0]).toMatchObject({ line: 2 });
  const effort = await errorsOf(['  await ask({ harness: "codex", effort: "max" }, "a");']);
  expect(effort).toHaveLength(1);
  expect(effort[0]).toMatchObject({ line: 2 });
  expect(await errorsOf(['  await ask({ harness: "mcode-work", model: "gpt-9", effort: "max" }, "a");'])).toEqual([]);
});

test("the typed answer of a schema still comes with a harness", async () => {
  expect(
    await errorsOf([
      '  const review = await ask({ harness: "codex", model: "gpt-5", schema: z.object({ ok: z.boolean() }) }, "a");',
      "  const ok: boolean = review.ok;",
      "  const text: string = (await ask({ harness: \"mcode-work\" }, \"b\")).answer;",
      "  void ok; void text;",
    ]),
  ).toEqual([]);
  const wrong = await errorsOf(['  const review = await ask({ harness: "codex", schema: z.object({ ok: z.boolean() }) }, "a");', "  const n: number = review.ok;"]);
  expect(wrong).toHaveLength(1);
  expect(wrong[0]).toMatchObject({ line: 3, code: "TS2322" });
});

test("the harnesses are the ones the caller may call, and a host that serves none has none to check", async () => {
  const typing = scriptTyping(catalogue, names.filter((name) => name === "session.start.mcode-work")).declarations;
  expect(typing).toContain('"mcode-work"');
  expect(typing).not.toContain('harness: "codex"');
  expect(await errorsOf(['  await ask({ harness: "whatever", model: "m" }, "a");'], [], [])).toEqual([]);
});

test("the options block follows the harness: its own kind's block is typed, another kind's block is an error", async () => {
  expect(
    await errorsOf([
      '  await ask({ harness: "claude-work", claude: { advisor: false } }, "a");',
      '  await ask({ harness: "codex", model: "gpt-5", codex: {} }, "b");',
      '  await ask({ harness: "mcode-work", mcode: {} }, "c");',
    ]),
  ).toEqual([]);
  // The block of another kind, on a harness of each kind.
  for (const call of [
    '{ harness: "codex", claude: { advisor: false } }',
    '{ harness: "claude-work", codex: {} }',
    '{ harness: "mcode-work", claude: {} }',
  ]) {
    const errors = await errorsOf([`  await ask(${call}, "a");`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  }
  // With a schema the call has more overloads to fail, and each says where: the call is refused, at that line.
  const schemed = await errorsOf(['  await ask({ harness: "codex", model: "gpt-5", schema: z.object({ ok: z.boolean() }), claude: { advisor: false } }, "a");']);
  expect(schemed.length).toBeGreaterThan(0);
  for (const error of schemed) expect(error).toMatchObject({ line: 2, code: "TS2769" });
  // A field the own block does not have, or a value of the wrong type.
  expect(await errorsOf(['  await ask({ harness: "claude-work", claude: { advisor: "no" } }, "a");'])).toHaveLength(1);
  expect(await errorsOf(['  await ask({ harness: "claude-work", claude: { speed: 1 } }, "a");'])).toHaveLength(1);
  // A harness given without its kind's options, and a call that names no harness, take no block.
  expect(await errorsOf(['  await ask({ harness: "bare", claude: { advisor: false } }, "a");'])).toHaveLength(1);
  expect(await errorsOf(['  await ask({ codex: {} }, "a");'])).toHaveLength(1);
  // An unknown harness is an error, with a block or without.
  expect(await errorsOf(['  await ask({ harness: "nope", claude: { advisor: false } }, "a");'])).toHaveLength(1);
});

test("a registered workflow is called as niwa.flow[id], typed by its literal id", async () => {
  expect(await errorsOf(['  const out = await niwa.flow["wf-a3f9c2"]({ n: 1 });', "  void out;"])).toEqual([]);
  const unknown = await errorsOf(['  await niwa.flow["wf-000000"]({ n: 1 });']);
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toMatchObject({ line: 2 });
  const input = await errorsOf(['  await niwa.flow["wf-a3f9c2"]({ n: "one" });']);
  expect(input).toHaveLength(1);
  expect(input[0]).toMatchObject({ line: 2, code: "TS2322" });
});

test("a pipeline hands each stage the typed value of the one before", async () => {
  expect(
    await errorsOf([
      '  const [first, second, third] = await pipeline([',
      '    () => ask({}, "one"),',
      '    (previous) => ask({}, "two " + previous.answer),',
      "    async (previous) => ({ words: previous.answer.split(\" \").length }),",
      "  ]);",
      "  const a: string = first.answer;",
      "  const b: string = second.answer;",
      "  const c: number = third.words;",
      "  void a; void b; void c;",
      "  const [x, y, z4, w] = await pipeline([() => 1, (n) => n + 1, (n) => String(n), (s) => s.length]);",
      "  const sum: number = x + y + w;",
      "  const s: string = z4;",
      "  void sum; void s;",
    ]),
  ).toEqual([]);
});

test("a stage that misuses the value before it is an error, and so is a pipeline of one or five stages", async () => {
  const misuse = await errorsOf(['  await pipeline([() => ask({}, "one"), (previous) => previous.nothing]);']);
  expect(misuse).toHaveLength(1);
  expect(misuse[0]).toMatchObject({ line: 2, code: "TS2339" });
  const wrongType = await errorsOf(["  await pipeline([() => 1, (n) => n.toUpperCase()]);"]);
  expect(wrongType).toHaveLength(1);
  expect(wrongType[0]).toMatchObject({ line: 2, code: "TS2339" });
  expect((await errorsOf(["  await pipeline([() => 1]);"])).length).toBeGreaterThan(0);
  expect((await errorsOf(["  await pipeline([() => 1, (n) => n, (n) => n, (n) => n, (n) => n]);"])).length).toBeGreaterThan(0);
});

test("workflow.check on a live host holds a script to the harnesses and the lists of the plugin", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(workflow({ harnesses: [{ id: "codex", models: ["gpt-5"], efforts: ["low", "high"] }, "mcode-work"] }));
  await host.serve();
  hosts.push(host);
  await mkdir(home.path, { recursive: true });
  const check = async (name: string, call: string) => {
    const path = join(home.path, name);
    await writeFile(path, ["export default workflow({ output: z.json() }, async () => {", `  await ask(${call}, "a");`, "  return null;", "});"].join("\n"));
    return host.call(workflowCheck, { file: path });
  };
  expect((await check("ok.ts", '{ harness: "codex", model: "gpt-5", effort: "low" }')).ok).toBe(true);
  expect((await check("ok2.ts", '{ harness: "mcode-work", model: "anything" }')).ok).toBe(true);
  const unknown = await check("unknown.ts", '{ harness: "claude-haiku" }');
  expect(unknown.ok).toBe(false);
  expect(unknown.errors[0]).toMatchObject({ line: 2, code: "TS2769" });
  const effort = await check("effort.ts", '{ harness: "codex", effort: "max" }');
  expect(effort.ok).toBe(false);
  expect(effort.errors[0]).toMatchObject({ line: 2 });
}, 60_000);

test("the agent action of a harness with listed models refuses another model, and one with none takes any", () => {
  const listed = sessionAgent("codex", { models: ["gpt-5"], efforts: ["low"] });
  expect(listed.input.safeParse({ prompt: "x", model: "gpt-5", effort: "low" }).success).toBe(true);
  expect(listed.input.safeParse({ prompt: "x", model: "gpt-9" }).success).toBe(false);
  expect(listed.input.safeParse({ prompt: "x", effort: "max" }).success).toBe(false);
  const open = sessionAgent("mcode-work");
  expect(open.input.safeParse({ prompt: "x", prompts: "typo" }).success).toBe(false);
  expect(open.input.safeParse({ prompt: "x", model: "gpt-9", effort: "max" }).success).toBe(true);
  expect(open.input.safeParse({ prompt: "x", model: "" }).success).toBe(false);
});

test("the agent action takes a block as an object, left to its kind to check, and names a field it does not have", () => {
  const claude = sessionAgent("claude-work");
  expect(claude.input.safeParse({ prompt: "x", claude: { advisor: false } }).success).toBe(true);
  // What is in a block, and which block the harness takes, are the sessions module's to check when the call runs.
  expect(claude.input.safeParse({ prompt: "x", acme: { speed: 1 } }).success).toBe(true);
  expect(claude.input.safeParse({ prompt: "x", codex: 5 }).success).toBe(false);
  const typo = claude.input.safeParse({ prompt: "x", modle: "m" });
  expect(typo.error?.issues[0]?.message).toBe('the agent call of the harness "claude-work" has no field "modle"');
});

test("ask({ worktree }) is typed: the answer carries the worktree it left, with or without a schema", async () => {
  expect(
    await errorsOf([
      '  const plain = await ask({ harness: "codex", worktree: true }, "a");',
      "  const branch: string | undefined = plain.worktree?.branch;",
      "  const changed: boolean | undefined = plain.worktree?.changed;",
      '  const typed = await ask({ harness: "claude-work", worktree: { repo: "/tmp/repo", base: "main", description: "a try" }, schema: z.object({ ok: z.boolean() }) }, "b");',
      "  const ok: boolean = typed.ok;",
      "  const path: string | undefined = typed.worktree?.path;",
    ]),
  ).toEqual([]);
  const wrong = await errorsOf(['  await ask({ harness: "codex", worktree: { branch: "x" } }, "a");']);
  expect(wrong).toHaveLength(1);
  const absent = await errorsOf(['  const plain = await ask({ harness: "codex" }, "a");', "  plain.worktree;"]);
  expect(absent).toHaveLength(1);
});
