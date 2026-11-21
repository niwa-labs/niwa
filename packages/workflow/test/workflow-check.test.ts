// A script is type-checked against the typing generated
// from what the host describes, a call outside `uses` is an error with a place in the file,
// `workflow.start` does not run a script that fails the check, and `workflow.guide` shows a caller
// only the actions it may call. The hash of the script is what tells a replay from a revision.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { action, actionName, grant, principalOf, seq, owner } from "@niwa-labs/core";
import type { ActionDescription, StoredRecord } from "@niwa-labs/core";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connect, createNiwa, describe, messages, requests, tasks, timers, eventually, tempDir, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowGuide, workflowResume, workflowStart } from "../src/index.ts";

import { scriptChecker } from "../src/check.ts";
import { scriptTyping } from "../src/script-types.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const bind: CallerBinding = (caller) =>
  caller.kind === "handler" && caller.handler.startsWith("workflow/") ? owner : undefined;

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), messages({ bind }), tasks({ messages: { bind } }));
  host.use(workflow({ harnesses: ["codex", "mcode-work"] }));
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  const file = join(home, name);
  await mkdir(home, { recursive: true });
  await writeFile(file, lines.join("\n"));
  return file;
}

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("the typing generated from the live host has no error of its own", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "empty.ts", ["export default workflow({ output: z.number() }, async () => {", "  return 1;", "});"]);
  const report = await host.call(workflowCheck, { file });
  expect(report).toEqual({ file, ok: true, errors: [], note: "described, the script was not run", output: { type: "number" }, contract: expect.any(String) });
}, 30_000);

test("a wrapper is typed by the schema of its action", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "typed.ts", [
    "export default workflow({}, async () => {",
    '  await niwa.task.create({ nonsense: 1 });',
    "});",
  ]);
  const report = await host.call(workflowCheck, { file });
  expect(report.ok).toBe(false);
  expect(report.errors[0]).toMatchObject({ file, line: 2, code: "TS2353" });
}, 30_000);

test("W2b: a call outside uses is an error with its place, and the script function is not run", async () => {
  const { host, home } = await served();
  const marker = join(home, "ran");
  const file = await scriptIn(home, "outside.ts", [
    'export default workflow({ uses: ["task.*"] }, async () => {',
    `  await Bun.write(${JSON.stringify(marker)}, "ran");`,
    '  await niwa.request.ask({ question: "x" });',
    '  await call("request.ask", {});',
    '});',
  ]);
  const report = await host.call(workflowCheck, { file });
  expect(report.note).toBe("described, the script was not run");
  expect(report.ok).toBe(false);
  expect(report.errors.map((error) => [error.file, error.line, error.column, error.code])).toEqual([
    [file, 3, 14, "TS2339"],
    [file, 4, 14, "TS2345"],
  ]);
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("a call inside uses passes, by name and as a wrapper", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "inside.ts", [
    'export default workflow({ uses: ["task.create", "request.*"] }, async () => {',
    "  await niwa.request.open({});",
    '  await call("request.open", {});',
    '});',
  ]);
  expect((await host.call(workflowCheck, { file })).errors).toEqual([]);
}, 30_000);

test("a mask that names no action is an error at its place", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "mask.ts", [
    'export default workflow({ uses: ["task.*", "nothing.*"] }, async () => {});',
  ]);
  const report = await host.call(workflowCheck, { file });
  expect(report.errors).toEqual([
    { file, line: 1, column: 44, code: "uses", message: 'uses "nothing.*" names no action the caller may call' },
  ]);
}, 30_000);

test("a script with no uses may call any action the caller may call; a JS script is read for its syntax", async () => {
  const { host, home } = await served();
  const open = await scriptIn(home, "open.ts", ["export default workflow({}, async () => {", '  await niwa.request.open({});', "});"]);
  expect((await host.call(workflowCheck, { file: open })).ok).toBe(true);
  const js = await scriptIn(home, "plain.js", ["export default workflow({ output: z.boolean() }, async () => {", "  return await Bun.file('x').exists();", "});"]);
  expect((await host.call(workflowCheck, { file: js })).ok).toBe(true);
  const checked = await scriptIn(home, "checked.js", [
    "// @ts-check",
    "export default workflow({}, async () => {",
    '  await niwa.request.open({ nonsense: 1 });',
    "});",
  ]);
  expect((await host.call(workflowCheck, { file: checked })).errors[0]).toMatchObject({ line: 3, code: "TS2353" });
  const broken = await scriptIn(home, "broken.js", ["export default workflow({}, async () => {"]);
  expect((await host.call(workflowCheck, { file: broken })).ok).toBe(false);
}, 30_000);

test("W2b: workflow.start refuses a script that fails its check, with the errors, and writes no run", async () => {
  const { host, home } = await served();
  const bad = await scriptIn(home, "bad.ts", [
    'export default workflow({ uses: ["task.*"] }, async () => {',
    '  await niwa.request.open({});',
    '});',
  ]);
  const refused = await host.call(workflowStart, { file: bad }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain(`${bad}:2:`);
  expect((refused as Error).message).toContain("the script was not run");
  expect(ofType(await host.records.read(seq(0)), "workflow.run.requested")).toHaveLength(0);

  const good = await scriptIn(home, "good.ts", ["export default workflow({ output: z.number() }, async () => {", "  return 1;", "});"]);
  await host.call(workflowStart, { file: good });
  await eventually(async () => ofType(await host.records.read(seq(0)), "workflow.run.finished").length === 1, 20_000);
}, 30_000);

test("the hash of the script is pinned at the start and decides what a resume is", async () => {
  const { host, home } = await served();
  const text = "export default workflow({ output: z.number() }, async () => {\n  return 1;\n});\n";
  const file = await scriptIn(home, "pinned.ts", [text.trimEnd()]);
  await writeFile(file, text);
  const { run } = await host.call(workflowStart, { file });
  const finished = async (count: number): Promise<boolean> =>
    ofType(await host.records.read(seq(0)), "workflow.run.finished").length === count;
  await eventually(() => finished(1), 20_000);
  const records = await host.records.read(seq(0));
  expect(ofType(records, "workflow.run.requested")[0]?.data).toMatchObject({ hash: sha256(text) });
  expect(ofType(records, "workflow.run.started")[0]?.data).toMatchObject({ hash: sha256(text) });

  // The same bytes saved again: a replay, not a revision.
  await writeFile(file, text);
  const replay = await host.call(workflowResume, { run });
  expect(replay).toEqual({ run, finished: false });
  await eventually(async () => ofType(await host.records.read(seq(0)), "workflow.run.started").length === 2, 20_000);
  await eventually(() => finished(2), 20_000);

  // One byte changed: a revision.
  await writeFile(file, `${text}// edited\n`);
  const revised = await host.call(workflowResume, { run });
  expect(revised.revision).toBeDefined();
  await eventually(async () => ofType(await host.records.read(seq(0)), "workflow.run.started").length === 3, 20_000);
  const starts = ofType(await host.records.read(seq(0)), "workflow.run.started");
  expect(starts[2]?.data).toMatchObject({ hash: sha256(`${text}// edited\n`) });
}, 30_000);

/** What the guide says its actions are, and what the declarations expose of them. */
const declared = (declarations: string): string[] =>
  [...declarations.matchAll(/^ {2}"([^"]+)": \{ input: /gm)].map((match) => match[1] ?? "");

test("W2c: the guide lists the actions the caller may call, and the declarations match the list", async () => {
  const { host, home } = await served();
  const everything = await host.call(workflowGuide, {});
  const names = everything.actions.map((entry) => entry.name);
  expect(names).toContain("task.create");
  expect(names).toContain("workflow.guide");
  expect(declared(everything.declarations).sort()).toEqual([...names].sort());
  expect(everything.guide).toContain("uses");
  expect(everything.actions.find((entry) => entry.name === "task.create")?.description.length).toBeGreaterThan(0);

  const session = await connect({
    home,
    id: "session:narrow",
    token: host.issueToken(principalOf("session", "narrow"), {
      grant: grant(["workflow.guide", "workflow.check", "task.create"]),
    }),
  });
  try {
    const narrow = await session.call(actionName("workflow.guide"), {});
    const seen = (narrow as { actions: Array<{ name: string }>; declarations: string }).actions.map((entry) => entry.name);
    expect(seen.sort()).toEqual(["task.create", "workflow.check", "workflow.guide"]);
    expect(declared((narrow as { declarations: string }).declarations).sort()).toEqual(seen);

    // A call of an action the caller may not call is a type error for it, even with no uses.
    const file = await scriptIn(home, "narrow.ts", ["export default workflow({}, async () => {", '  await niwa.request.open({});', "});"]);
    const report = (await session.call(actionName("workflow.check"), { file })) as { ok: boolean; errors: Array<{ line: number }> };
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.line).toBe(2);
  } finally {
    await session.close();
  }
}, 30_000);

test("the typing handles what the schemas of niwa hold: references, records, enums, a node that is an action and a group", async () => {
  type Tree = { name: string; children: Tree[] };
  const Tree: z.ZodType<Tree> = z.lazy(() => z.object({ name: z.string(), children: z.array(Tree) }));
  const described = (name: string, input: z.ZodType, output: z.ZodType): ActionDescription => {
    const [one] = describe({
      actions: [action(name, { description: `The action ${name}.`, input, output, recovery: "repeat", run: () => ({}) })],
      types: [],
    }).actions;
    if (one === undefined) throw new Error("no description");
    return one;
  };
  const catalogue = [
    described("tree.grow", z.object({ tree: Tree, kind: z.enum(["a", "b"]), tags: z.record(z.string(), z.number()), pair: z.tuple([z.string(), z.number()]) }), z.object({ id: z.string().nullable(), any: z.unknown() })),
    described("session.start", z.object({ prompt: z.string() }), z.object({ session: z.string() })),
    described("session.start.codex", z.object({ prompt: z.string(), model: z.string().optional() }), z.object({ session: z.string() })),
    described("agent.search-old", z.object({}), z.object({})),
  ];
  const names = catalogue.map((entry) => entry.name);
  const check = scriptChecker();
  const file = join(process.cwd(), "typing-probe.ts");
  const ok = [
    "export default workflow({ output: z.json() }, async () => {",
    '  const grown = await niwa.tree.grow({ tree: { name: "a", children: [{ name: "b", children: [] }] }, kind: "a", tags: { x: 1 }, pair: ["x", 1] });',
    "  const id: string | null = grown.id;",
    '  const one = await niwa.session.start({ prompt: "x" });',
    '  const two = await niwa.session.start.codex({ prompt: "x", model: "m" });',
    '  const three = await niwa.agent["search-old"]({});',
    '  await call("session.start.codex", { prompt: "x" });',
    "  return [id, one.session, two.session, three];",
    "});",
  ].join("\n");
  expect((await check({ file, text: ok }, { actions: catalogue, callable: names })).errors).toEqual([]);
  const wrong = ok.replace('kind: "a"', 'kind: "c"');
  const failed = await check({ file, text: wrong }, { actions: catalogue, callable: names });
  expect(failed.errors).toHaveLength(1);
  expect(failed.errors[0]).toMatchObject({ line: 2, code: "TS2322" });
  // Without `session.start.codex` among the callable names the wrapper is gone, the group stays.
  const narrowed = scriptTyping(catalogue, names.filter((name) => name !== "session.start.codex")).declarations;
  // The block of the kind `codex` in the options of `agent()` is not that wrapper: it is `"codex"?`, not `"codex": {`.
  expect(narrowed).not.toContain('"codex": {');
  expect(narrowed).toContain('"session": {');
}, 30_000);

test("an answer kept for a script is not given to the same text in another file", async () => {
  const check = scriptChecker();
  const text = 'export default workflow({ output: z.json() }, async () => { return missing; });';
  const dir = process.cwd();
  const typed = await check({ file: join(dir, "same.ts"), text }, { actions: [], callable: [] });
  const plain = await check({ file: join(dir, "same.js"), text }, { actions: [], callable: [] });
  expect(typed.ok).toBe(false);
  expect(plain.ok).toBe(true);
  expect(plain.file).toBe(join(dir, "same.js"));
}, 30_000);

test("the packages the checker reads are parsed once, and the files of a script's own folder are read at every check", async () => {
  const check = scriptChecker();
  const dir = await tempDir("check-import");
  const file = join(dir, "script.ts");
  const text = 'import { value } from "./value.ts"; export default workflow({ output: z.number() }, async () => { return value; });';
  await writeFile(join(dir, "value.ts"), "export const value: number = 1;");
  expect((await check({ file, text }, { actions: [], callable: [] })).ok).toBe(true);
  // The imported file is edited, the script is not: another checker keeps no answer, and it must read the new text of the file.
  await writeFile(join(dir, "value.ts"), 'export const value: string = "one";');
  const again = await scriptChecker()({ file, text }, { actions: [], callable: [] });
  expect(again.ok).toBe(false);
}, 30_000);
