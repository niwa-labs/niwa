// One Question and one Answer for the whole system.
//
// The checks:
//   1. the records of the requests module hold a question and an answer in the one format;
//   2. an answer that does not fit the kind of its question is refused, and the request stays open;
//   3. a request is self-describing: its record alone says what was asked and what may be answered;
//   4. a rule that asks puts a permission question whose subject holds the input of the call as JSON;
//   5. a script asks with ask.choice, ask.multi, ask.confirm, ask.text and ask.form, and gets a
//      typed value; the type checker holds the script to those types.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { AnswerSchema, QuestionSchema, answerMismatch, seq, owner } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { QuestionName, REQUEST_ANSWER, RequestAnswered, RequestCreated } from "@niwa-labs/requests/records";
import { createNiwa, requests, eventually, tempHome, connectAsOwner, opt, pick, timers, requestIdOf } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowStart } from "../src/index.ts";


const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

const recordsOf = (host: Host, type: string): Promise<StoredRecord[]> =>
  host.records.read(seq(0)).then((all) => all.filter((row) => row.type === type));

/** One question of every kind, as a request records it. */
const KINDS = {
  choice: { kind: "choice", title: "Pick one", options: [opt("a"), opt("b")] },
  multi: { kind: "multi", title: "Pick some", options: [opt("a"), opt("b"), opt("c")] },
  confirm: { kind: "confirm", title: "Sure?", options: [opt("yes"), opt("no")] },
  text: { kind: "text", title: "Say something" },
  form: {
    kind: "form",
    title: "Fill it",
    schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
  },
  permission: {
    kind: "permission",
    title: "May it?",
    options: [
      { id: "ok", label: "Allow", flavor: "allow_once" },
      { id: "no", label: "Refuse", flavor: "reject_once" },
    ],
    subject: { who: "client:x", action: "task.create", rule: "task.create", input: { title: "t", tags: ["a"] } },
  },
} as const;

test("a question of every kind is read back whole, and what is not a question is refused", () => {
  for (const question of Object.values(KINDS)) {
    expect(QuestionSchema.parse(question)).toMatchObject({ kind: question.kind, title: question.title });
  }
  expect(QuestionSchema.safeParse({ kind: "choice", title: "no options", options: [] }).success).toBe(false);
  expect(QuestionSchema.safeParse({ kind: "form", title: "no schema" }).success).toBe(false);
  expect(QuestionSchema.safeParse({ kind: "riddle", title: "?" }).success).toBe(false);
  expect(QuestionSchema.safeParse({ kind: "text" }).success).toBe(false);

  expect(AnswerSchema.safeParse({ ids: ["a"] }).success).toBe(true);
  expect(AnswerSchema.safeParse({ text: "x" }).success).toBe(true);
  expect(AnswerSchema.safeParse({ form: { n: 1 } }).success).toBe(true);
  expect(AnswerSchema.safeParse({ cancelled: true }).success).toBe(true);
  expect(AnswerSchema.safeParse("main").success).toBe(false);
  expect(AnswerSchema.safeParse({ ids: ["a"], text: "x" }).success).toBe(false);
});

test("the answer must fit the kind of its question", () => {
  const q = (kind: keyof typeof KINDS) => QuestionSchema.parse(KINDS[kind]);
  // choice, confirm and permission take exactly one known id.
  expect(answerMismatch(q("choice"), pick("a"))).toBeUndefined();
  expect(answerMismatch(q("choice"), pick("a", "b"))).toBeDefined();
  expect(answerMismatch(q("choice"), pick("zzz"))).toBeDefined();
  expect(answerMismatch(q("choice"), { text: "a" })).toBeDefined();
  expect(answerMismatch(q("confirm"), pick("yes"))).toBeUndefined();
  expect(answerMismatch(q("permission"), pick("ok"))).toBeUndefined();
  expect(answerMismatch(q("permission"), { text: "ok" })).toBeDefined();
  // multi takes any number of known ids.
  expect(answerMismatch(q("multi"), pick("a", "c"))).toBeUndefined();
  expect(answerMismatch(q("multi"), pick())).toBeUndefined();
  expect(answerMismatch(q("multi"), pick("a", "q"))).toBeDefined();
  // text takes a text, form a value that passes its schema.
  expect(answerMismatch(q("text"), { text: "hi" })).toBeUndefined();
  expect(answerMismatch(q("text"), pick("a"))).toBeDefined();
  expect(answerMismatch(q("form"), { form: { n: 3 } })).toBeUndefined();
  expect(answerMismatch(q("form"), { form: { n: "three" } })).toBeDefined();
  expect(answerMismatch(q("form"), { text: "x" })).toBeDefined();
  // Nothing is answered by cancelling: that is what request.cancel is for.
  for (const kind of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
    expect(answerMismatch(q(kind), { cancelled: true })).toBeDefined();
  }
  // A free text is taken only where the question allows another answer.
  const open = QuestionSchema.parse({ ...KINDS.choice, allowOther: true });
  expect(answerMismatch(open, { text: "c" })).toBeUndefined();
});

test("a request records its question whole, and an answer of the wrong kind is refused and leaves it open", async () => {
  const { host, home } = await served();
  const client = await connectAsOwner(home);
  try {
    for (const [name, question] of Object.entries(KINDS)) {
      await host.emit(RequestCreated, {
        id: requestIdOf(name),
        to: owner,
        question: QuestionName.parse(`format.${name}`),
        input: QuestionSchema.parse(question),
      });
    }
    // The record alone says what was asked: no process that asked is needed to draw it.
    const created = (await recordsOf(host, RequestCreated.name)).map((row) => RequestCreated.schema.parse(row.data));
    expect(created.map((data) => String(data.input.kind))).toEqual(Object.keys(KINDS));
    expect(created.find((data) => data.input.kind === "permission")?.input).toMatchObject({
      subject: { input: { title: "t", tags: ["a"] } },
    });

    const wrong: Record<string, unknown> = {
      choice: { text: "a" },
      multi: pick("zzz"),
      confirm: pick("maybe"),
      text: pick("a"),
      form: { form: { n: "three" } },
      permission: { cancelled: true },
    };
    for (const [name, answer] of Object.entries(wrong)) {
      await expect(client.call(REQUEST_ANSWER, { id: requestIdOf(name), answer })).rejects.toThrow("not valid");
    }
    expect(await recordsOf(host, RequestAnswered.name)).toHaveLength(0);

    const right: Record<string, unknown> = {
      choice: pick("b"),
      multi: pick("a", "c"),
      confirm: pick("yes"),
      text: { text: "hello" },
      form: { form: { n: 7 } },
      permission: pick("ok"),
    };
    for (const [name, answer] of Object.entries(right)) {
      expect(await client.call(REQUEST_ANSWER, { id: requestIdOf(name), answer })).toMatchObject({ accepted: true });
    }
    const answered = (await recordsOf(host, RequestAnswered.name)).map((row) => RequestAnswered.schema.parse(row.data));
    expect(answered).toHaveLength(6);
    expect(answered.find((data) => data.id === requestIdOf("text"))?.answer).toEqual({ text: "hello" });
  } finally {
    await client.close();
  }
});

test("a request is not written with a question or an answer that is not in the format", () => {
  const bad = requestIdOf("bad");
  const created = { id: bad, to: owner, question: "format.bad" };
  expect(RequestCreated.schema.safeParse({ ...created, input: { release: "1.0" } }).success).toBe(false);
  expect(RequestCreated.schema.safeParse({ ...created, input: KINDS.text }).success).toBe(true);
  expect(RequestAnswered.schema.safeParse({ id: bad, answer: "main" }).success).toBe(false);
  expect(RequestAnswered.schema.safeParse({ id: bad, answer: { ids: ["main"] } }).success).toBe(true);
});

// --- scripts ---------------------------------------------------------------------------------

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, lines.join("\n"));
  return file;
}

test("each ask.<kind> of a script puts its own question and gives a typed value", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "asks.js", [
    "export default workflow({ output: z.json() }, async () => {",
    '  const choice = await ask.choice("Pick one", ["a", { id: "b", label: "Bee" }]);',
    '  const multi = await ask.multi("Pick some", ["x", "y", "z"]);',
    '  const confirm = await ask.confirm("Sure?");',
    '  const text = await ask.text("Say something");',
    '  const form = await ask.form("Fill it", z.object({ n: z.number(), tag: z.string().default("none") }));',
    "  return { choice, multi, confirm, text, form };",
    "});",
  ]);
  const client = await connectAsOwner(home);
  try {
    const started = await host.call(workflowStart, { file });

    const next = async (count: number): Promise<RequestIn> => {
      await eventually(async () => (await recordsOf(host, RequestCreated.name)).length === count, 20_000, `the ask ${String(count)} should be put`);
      const row = (await recordsOf(host, RequestCreated.name))[count - 1];
      return RequestCreated.schema.parse(row?.data);
    };
    type RequestIn = z.output<typeof RequestCreated.schema>;

    const choice = await next(1);
    expect(choice.input).toMatchObject({ kind: "choice", title: "Pick one", options: [{ id: "a", label: "a" }, { id: "b", label: "Bee" }] });
    await client.call(REQUEST_ANSWER, { id: choice.id, answer: pick("b") });

    const multi = await next(2);
    expect(multi.input.kind).toBe("multi");
    // An id the question does not have is refused, and the ask stays open.
    await expect(client.call(REQUEST_ANSWER, { id: multi.id, answer: pick("x", "nope") })).rejects.toThrow("not valid");
    await client.call(REQUEST_ANSWER, { id: multi.id, answer: pick("x", "z") });

    const confirm = await next(3);
    expect(confirm.input).toMatchObject({ kind: "confirm", options: [{ id: "yes" }, { id: "no" }] });
    await client.call(REQUEST_ANSWER, { id: confirm.id, answer: pick("yes") });

    const text = await next(4);
    expect(text.input.kind).toBe("text");
    await client.call(REQUEST_ANSWER, { id: text.id, answer: { text: "hello" } });

    const form = await next(5);
    // The form carries the JSON Schema of what the script wants, so a surface can draw it.
    expect(form.input).toMatchObject({ kind: "form", schema: { type: "object", required: ["n"] } });
    await expect(client.call(REQUEST_ANSWER, { id: form.id, answer: { form: { n: "seven" } } })).rejects.toThrow("not valid");
    await client.call(REQUEST_ANSWER, { id: form.id, answer: { form: { n: 7 } } });

    await eventually(async () => (await recordsOf(host, "workflow.run.finished")).length === 1, 20_000, "the run should finish");
    const finished = z.object({ outcome: z.object({ status: z.literal("done"), result: z.unknown() }) }).parse((await recordsOf(host, "workflow.run.finished"))[0]?.data);
    // The value is the id, the ids, a boolean, a string and what the zod schema parsed (its default included).
    expect(finished.outcome.result).toEqual({
      choice: "b",
      multi: ["x", "z"],
      confirm: true,
      text: "hello",
      form: { n: 7, tag: "none" },
    });
    expect(started.run).toBeDefined();
  } finally {
    await client.close();
  }
}, 60_000);

test("the type checker holds a script to the types of ask.<kind>", async () => {
  const { host, home } = await served();
  const typed = await scriptIn(home, "typed.ts", [
    'const Form = z.object({ n: z.number() });',
    "export default workflow({ output: z.json() }, async () => {",
    '  const choice: "a" | "b" = await ask.choice("Pick", ["a", "b"]);',
    '  const named: "x" | "y" = await ask.choice("Pick", [{ id: "x", label: "X" }, "y"]);',
    '  const multi: Array<"a" | "b"> = await ask.multi("Pick", ["a", "b"]);',
    '  const confirm: boolean = await ask.confirm("Sure?", { timeout: "1m", label: "sure" });',
    '  const text: string = await ask.text("Say");',
    '  const form: { n: number } = await ask.form("Fill", Form);',
    "  return { choice, named, multi, confirm, text, form };",
    "});",
  ]);
  expect(await host.call(workflowCheck, { file: typed })).toMatchObject({ ok: true, errors: [] });

  const wrong = await scriptIn(home, "wrong.ts", [
    "export default workflow({ output: z.json() }, async () => {",
    '  const choice: "c" = await ask.choice("Pick", ["a", "b"]);',
    '  const confirm: string = await ask.confirm("Sure?");',
    "  return { choice, confirm };",
    "});",
  ]);
  const report = await host.call(workflowCheck, { file: wrong });
  expect(report.ok).toBe(false);
  expect(report.errors.map((error) => error.line)).toEqual([2, 3]);

  // A question with a JSON Schema written by hand is not accepted.
  const old = await scriptIn(home, "old.ts", [
    "export default workflow({ output: z.json() }, async () => {",
    '  return await ask("Go on?", { type: "boolean" });',
    "});",
  ]);
  expect((await host.call(workflowCheck, { file: old })).ok).toBe(false);
});
