// `z` as a global of a script and `agent(prompt, { schema })`.
//
// A script describes the answer it wants with zod; the call gives the answer parsed and typed.
// The checks run against a fake control side that records what it was asked, and:
//
//   1. the type checker accepts a typed script and refuses a misuse of the typed answer;
//   2. the schema reaches the session as JSON Schema, and the call gives the parsed value;
//   3. an answer that does not pass the schema is never returned: the step fails and the run pauses;
//   4. a replay gives the recorded value without asking again, and another schema is shown, not rerun.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { actionName, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId } from "@niwa-labs/harness";
import { createNiwa, sessions, eventually, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck } from "../src/index.ts";
import type { RunStatus } from "../src/status.ts";

const HARNESS = harnessId("fake-harness");
const START = actionName("workflow.start");
const WAIT = actionName("workflow.wait");
const RESUME = actionName("workflow.resume");

/** What the fake control side was asked: the question and the JSON Schema its answer must pass. */
interface Asked {
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
}

/** The fake control side: it records the questions and answers with what the test says. */
class FakeControl implements SessionControl {
  readonly asked: Asked[] = [];
  /** What the session answers next. */
  reply: unknown = undefined;
  private counter = 0;

  async start(): Promise<{ session: SessionId }> {
    this.counter += 1;
    return { session: { harness: HARNESS, native: `session-${String(this.counter)}` as never } };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(
    id: SessionId,
    options: { prompt: { sections: Array<{ text: string }> }; schema: z.ZodType },
  ): Promise<{ session: SessionId; value: T; at: never }> {
    this.asked.push({
      prompt: options.prompt.sections.map((section) => section.text).join("\n\n"),
      schema: z.toJSONSchema(options.schema, { io: "input" }),
    });
    return { session: id, value: this.reply as T, at: 0 as never };
  }

  async *life(): AsyncIterable<never> {}

  async state(): Promise<"running" | "idle" | "unknown"> {
    return "unknown";
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: "fake-kind" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    reading: { list: true, read: true, watch: false },
    control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: true, effort: ["low"], modes: ["auto"] } },
  },
};

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 30_000);

async function served(): Promise<{ host: Host; home: string; control: FakeControl }> {
  const home = await tempHome();
  homes.push(home);
  const control = new FakeControl();
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: [{ instance, control }] }));
  host.use(workflow({ harnesses: [HARNESS] }));
  await host.serve();
  hosts.push(host);
  return { host, home: home.path, control };
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, lines.join("\n"));
  return file;
}

const statusOf = async (host: Host, run: string): Promise<RunStatus> =>
  (await host.call(WAIT, { run, timeoutMs: 20_000 })) as RunStatus;

const REVIEW = [
  'const Review = z.object({ verdict: z.enum(["approve", "changes"]), notes: z.array(z.string()), tag: z.string().default("none") });',
  "type Review = z.infer<typeof Review>;",
];

test("the type checker takes a typed script, and refuses a field the schema does not have", async () => {
  const { host, home } = await served();
  const typed = await scriptIn(home, "typed.ts", [
    ...REVIEW,
    "export default workflow({ output: z.json() }, async () => {",
    '  const review: Review = await agent("Review it", { harness: "fake-harness", schema: Review });',
    "  const first: string | undefined = review.notes[0];",
    "  const answer: { answer: string } = await agent(\"free text\", { harness: \"fake-harness\" });",
    "  return { verdict: review.verdict, tag: review.tag, first, text: answer.answer };",
    "});",
  ]);
  expect(await host.call(workflowCheck, { file: typed })).toMatchObject({ ok: true, errors: [] });

  const wrong = await scriptIn(home, "wrong.ts", [
    ...REVIEW,
    "export default workflow({ output: z.json() }, async () => {",
    '  const review = await agent("Review it", { harness: "fake-harness", schema: Review });',
    "  return review.missing;",
    "});",
  ]);
  const report = await host.call(workflowCheck, { file: wrong });
  expect(report.ok).toBe(false);
  expect(report.errors[0]).toMatchObject({ code: "TS2339", line: 5 });
  expect(report.errors[0]?.message).toContain("missing");

  // The text answer is `{ answer }` and nothing else.
  const text = await scriptIn(home, "text.ts", [
    "export default workflow({ output: z.json() }, async () => {",
    '  const answer = await agent("free text", { harness: "fake-harness" });',
    "  return answer.verdict;",
    "});",
  ]);
  expect((await host.call(workflowCheck, { file: text })).errors[0]).toMatchObject({ code: "TS2339" });
}, 30_000);

test("the schema reaches the session as JSON Schema, and the call gives the parsed typed value", async () => {
  const { host, home, control } = await served();
  control.reply = { verdict: "approve", notes: ["a", "b"] };
  const file = await scriptIn(home, "review.js", [
    ...REVIEW.slice(0, 1),
    "export default workflow({ output: z.json() }, async () => {",
    '  const review = await agent("Review the diff", { harness: "fake-harness", schema: Review, label: "review" });',
    "  return review;",
    "});",
  ]);
  const started = (await host.call(START, { file, wait: true, timeoutMs: 20_000 })) as RunStatus;
  // The default of the schema is applied in the script: the answer had no `tag`.
  expect(started).toMatchObject({ state: "finished", outcome: { result: { verdict: "approve", notes: ["a", "b"], tag: "none" } } });

  expect(control.asked).toHaveLength(1);
  expect(control.asked[0]?.prompt).toContain("Review the diff");
  expect(control.asked[0]?.schema).toMatchObject({
    type: "object",
    properties: { verdict: { type: "string", enum: ["approve", "changes"] }, notes: { type: "array", items: { type: "string" } } },
    required: ["verdict", "notes"],
  });

  // The schema is recorded with the step, as part of its input.
  const records = await host.records.read();
  const intent = records.find((row: StoredRecord) => {
    const data = row.data as { action?: string; key?: string };
    return data.action === "session.start.fake-harness" && data.key === "label:review";
  });
  const Review = z.object({ verdict: z.enum(["approve", "changes"]), notes: z.array(z.string()), tag: z.string().default("none") });
  expect((intent?.data as { input: { schema: unknown } }).input.schema).toEqual(z.toJSONSchema(Review, { io: "input" }));
}, 30_000);

test("an answer that does not pass the schema is not returned: the step fails and the run pauses", async () => {
  const { host, home, control } = await served();
  control.reply = { verdict: "maybe", notes: [] };
  const file = await scriptIn(home, "invalid.js", [
    ...REVIEW.slice(0, 1),
    "export default workflow({ output: z.json() }, async () => {",
    '  const review = await agent("Review the diff", { harness: "fake-harness", schema: Review });',
    '  return { reached: true, review };',
    "});",
  ]);
  const runInvalid = ((await host.call(START, { file })) as { run: string }).run;
  const paused = await statusOf(host, runInvalid);
  expect(paused.state).toBe("paused");
  // The refusal is what the failed step says, in the journal.
  const records = await host.records.read();
  expect(JSON.stringify(records.map((row) => row.data))).toContain("does not pass its schema");
  expect(control.asked).toHaveLength(1);
}, 30_000);

test("a schema that JSON Schema cannot say fails in the script, before anything is asked", async () => {
  const { host, home, control } = await served();
  const file = await scriptIn(home, "unsayable.js", [
    "export default workflow({ output: z.json() }, async () => {",
    '  const when = await agent("When?", { harness: "fake-harness", schema: z.object({ at: z.date() }) });',
    "  return when;",
    "});",
  ]);
  const runUnsayable = ((await host.call(START, { file })) as { run: string }).run;
  const status = await statusOf(host, runUnsayable);
  expect(status.state).toBe("paused");
  expect(JSON.stringify((await host.records.read()).map((row) => row.data))).toContain("Date cannot be represented");
  expect(control.asked).toHaveLength(0);
}, 30_000);

test("a replay gives the recorded value without asking again, and another schema is shown, not rerun", async () => {
  const { host, home, control } = await served();
  control.reply = { verdict: "changes", notes: ["x"] };
  const lines = (schema: string) => [
    `const Review = ${schema};`,
    "export default workflow({ output: z.json() }, async () => {",
    '  return await agent("Review the diff", { harness: "fake-harness", schema: Review, label: "review" });',
    "});",
  ];
  const file = await scriptIn(home, "replay.js", lines('z.object({ verdict: z.enum(["approve", "changes"]), notes: z.array(z.string()) })'));
  const runReplay = ((await host.call(START, { file, wait: true, timeoutMs: 20_000 })) as { run: string }).run;
  expect(control.asked).toHaveLength(1);

  // The session would now answer otherwise; the replay does not ask it.
  control.reply = { verdict: "approve", notes: [] };
  await host.call(RESUME, { run: runReplay });
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "workflow.run.finished").length === 2, 20_000, "the replay should finish");
  const finished = (await host.records.read()).filter((row) => row.type === "workflow.run.finished");
  expect(finished[1]?.data).toMatchObject({ outcome: { result: { verdict: "changes", notes: ["x"] } } });
  expect(control.asked).toHaveLength(1);

  // The same call with another schema is another input: it is shown, not asked.
  await writeFile(file, lines('z.object({ verdict: z.string(), notes: z.array(z.string()), more: z.number().optional() })').join("\n"));
  await host.call(RESUME, { run: runReplay });
  await eventually(
    async () => (await host.records.read()).some((row) => row.type === "workflow.run.paused"),
    20_000,
    "the changed schema should be shown",
  );
  const paused = (await host.records.read()).filter((row) => row.type === "workflow.run.paused");
  expect(JSON.stringify(paused.map((row) => row.data))).toContain("label:review");
  expect(control.asked).toHaveLength(1);
}, 30_000);
