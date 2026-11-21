// An `ask()` call starts its session through `session.start.<harness>`, so a script that names a harness `uses` does
// not list would pause at its first call. The check finds it first: a harness written in the call, held by a constant or
// chosen between two is an error, and one known only when the script runs is a warning.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { ActionDescription } from "@niwa-labs/core";
import { createNiwa, describe, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { sessionAgent, workflow, workflowCheck } from "../src/index.ts";

import { scriptChecker, scriptUses } from "../src/check.ts";

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

const actions = [
  described("session.start.codex-luna", sessionAgent("codex-luna").input),
  described("session.start.claude-work", sessionAgent("claude-work").input),
  described("task.create", z.object({ title: z.string() })),
];
const callable = actions.map((entry) => entry.name);

/** The check of a script with the given `uses`, over a host that serves two harnesses. */
async function report(uses: string, lines: readonly string[], file = "uses-probe.ts") {
  const text = [`export default workflow({ output: z.json(), uses: [${uses}] }, async () => {`, ...lines, "  return null;", "});"].join("\n");
  const checked = await scriptChecker()({ file: join(process.cwd(), file), text }, { actions, callable });
  return { errors: checked.errors, warnings: checked.warnings };
}

test("a harness written in the call that uses does not list is an error, and a listed one passes", async () => {
  const missing = await report('"task.create"', ['  await ask({ harness: "codex-luna" }, "go");']);
  expect(missing.errors.map((error) => error.code)).toEqual(["TS2769", "uses"]);
  expect(missing.errors[1]).toMatchObject({ line: 2 });
  expect(missing.errors[1]?.message).toContain('add "session.start.codex-luna"');
  expect(missing.warnings).toEqual([]);
  expect((await report('"task.create", "session.start.codex-luna"', ['  await ask({ harness: "codex-luna" }, "go");'])).errors).toEqual([]);
  expect((await report('"session.start.*"', ['  await ask({ harness: "codex-luna" }, "go");'])).errors).toEqual([]);
  // Another harness than the one listed.
  const other = await report('"session.start.claude-work"', ['  await ask({ harness: "codex-luna" }, "go");']);
  expect(other.errors.map((error) => error.code)).toEqual(["TS2769", "uses"]);
});

test("a harness held by a constant is found as the text is", async () => {
  const errors = (await report('"task.create"', ['  const harness = "codex-luna";', '  await ask({ harness }, "go");', '  const other = "claude-work";', '  await ask({ harness: other }, "go");'])).errors;
  expect(errors.filter((error) => error.code === "uses").map((error) => error.line)).toEqual([3, 5]);
  expect((await report('"session.start.codex-luna", "session.start.claude-work"', ['  const harness = "codex-luna";', '  await ask({ harness }, "go");'])).errors).toEqual([]);
});

test("a script that is not type checked is held to uses all the same, with an error that says what to add", async () => {
  const lines = ['  const harness = "codex-luna";', '  await ask({ harness }, "go");', '  await ask({ harness: "claude-work" }, "go");'];
  const { errors, warnings } = await report('"task.create"', lines, "uses-probe.js");
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatchObject({ line: 3, code: "uses" });
  expect(errors[0]?.message).toContain('add "session.start.codex-luna"');
  expect(errors[1]).toMatchObject({ line: 4, code: "uses" });
  expect(warnings).toEqual([]);
  expect((await report('"session.start.codex-luna", "session.start.claude-work"', lines, "uses-probe.js")).errors).toEqual([]);
});

test("a harness known only when the script runs is a warning that the call needs a matching uses entry", async () => {
  const lines = ["  const chosen: unknown = JSON.parse('{}');", '  await ask({ harness: chosen as any }, "go");'];
  const missing = await report('"task.create"', lines);
  expect(missing.errors).toEqual([]);
  expect(missing.warnings).toHaveLength(1);
  expect(missing.warnings[0]).toMatchObject({ line: 3, code: "uses" });
  expect(missing.warnings[0]?.message).toContain("session.start.*");
  // Every harness the host serves is listed: nothing is left that the call could name.
  expect((await report('"session.start.*"', lines)).warnings).toEqual([]);
  expect((await report('"session.start.codex-luna", "session.start.claude-work"', lines)).warnings).toEqual([]);
  // A harness that is text of any kind is the same, in a script of any kind.
  const text = await report('"session.start.codex-luna"', ["  let harness = 'codex-luna';", '  await ask({ harness }, "go");'], "uses-probe.js");
  expect(text.errors).toEqual([]);
  expect(text.warnings).toHaveLength(1);
  expect(text.warnings[0]).toMatchObject({ line: 3, code: "uses" });
});

test("a call that names no harness, or a host that serves none, has nothing to warn of", async () => {
  expect(await report('"task.create"', ['  await ask({}, "go");'])).toEqual({ errors: [], warnings: [] });
  const none = await scriptChecker()({ file: join(process.cwd(), "uses-probe.ts"), text: 'export default workflow({ output: z.json() }, async () => { await ask({ harness: "x" as string }, "go"); return null; });' }, { actions: [], callable: [] });
  expect(none.errors).toEqual([]);
  expect(none.warnings).toEqual([]);
});

test("workflow.check on a live host says so in its report", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(workflow({ harnesses: ["codex-luna", "claude-work"] }));
  await host.serve();
  hosts.push(host);
  await mkdir(home.path, { recursive: true });
  const check = async (name: string, uses: string, call: string) => {
    const path = join(home.path, name);
    await writeFile(path, ["export default workflow({ output: z.json(), uses: [" + uses + "] }, async () => {", `  await ask(${call}, "a");`, "  return null;", "});"].join("\n"));
    return host.call(workflowCheck, { file: path });
  };
  const missing = await check("missing.ts", '"workflow.guide"', '{ harness: "codex-luna" }');
  expect(missing.ok).toBe(false);
  expect(missing.errors.find((error) => error.code === "uses")).toMatchObject({ line: 2 });
  const listed = await check("listed.ts", '"session.start.codex-luna"', '{ harness: "codex-luna" }');
  expect(listed.ok).toBe(true);
  expect(listed.warnings).toBeUndefined();
  const dynamic = await check("dynamic.ts", '"session.start.codex-luna"', '{ harness: (JSON.parse("{}") as { h: string }).h }');
  expect(dynamic.errors.length).toBeGreaterThan(0);
  expect(dynamic.warnings?.[0]).toMatchObject({ line: 2, code: "uses" });
}, 60_000);

test("uses that a spread, a computed key or an accessor may decide is an error, not a script with no uses", async () => {
  const check = async (declaration: string) => {
    const text = `const base = { uses: ["*"] };\nconst key = "uses";\nexport default workflow(${declaration}, async () => null);`;
    const source = { file: join(process.cwd(), "uses-unsettled.ts"), text };
    const checked = await scriptChecker()(source, { actions, callable });
    return { codes: checked.errors.map((error) => error.code), uses: await scriptUses(source) };
  };
  for (const declaration of [
    "{ output: z.json(), ...base }",
    '{ output: z.json(), uses: ["task.create"], ...base }',
    '{ output: z.json(), [key]: ["*"] }',
    '{ output: z.json(), get uses() { return ["*"]; } }',
    '{ output: z.json(), uses: ["task.create"], get uses() { return ["*"]; } }',
    '{ output: z.json(), ...["*"] }',
  ]) {
    const found = await check(declaration);
    expect({ declaration, codes: found.codes, bad: "bad" in (found.uses ?? {}) }).toEqual({ declaration, codes: expect.arrayContaining(["uses"]), bad: true });
  }
  const written = await check('{ output: z.json(), uses: ["task.create"] }');
  expect(written).toEqual({ codes: [], uses: { masks: [expect.objectContaining({ mask: "task.create" })] } });
});
