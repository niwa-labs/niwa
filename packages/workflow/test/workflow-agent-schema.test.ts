// `z` as a global of a script and `ask({ schema }, prompt)`.
//
// A script describes the answer it wants with zod; the call gives the answer parsed and typed.
// The checks run against a fake control side that records what it was asked, and:
//
//   1. the type checker accepts a typed script and refuses a misuse of the typed answer;
//   2. the schema reaches the session as JSON Schema, and the call gives the parsed value;
//   3. an answer that does not pass the schema is never returned: the step fails and the run pauses;
//   4. a replay gives the recorded value without asking again; an agent call is its prompt and harness, so another schema
//      takes the recorded answer, and another prompt asks again.

import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { AccessGranted, CORE_TYPES, actionName, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, LifeEvent, SessionControl, SessionId, StartOptions } from "@niwa-labs/harness";
import { onSpawn, spawnAgent, useSandbox } from "@niwa-labs/sandbox";
import { SessionBoxManifest, SessionMarked, SessionStarted, SessionStartReserved, sessionStart } from "@niwa-labs/sessions/records";
import { createNiwa, sessions, eventually, openBoxes, tempHome, unconfined } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { RunFinished, workflow, workflowCheck, workflowRegister, workflowStart } from "../src/index.ts";
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
  private turn = 0;
  turnAnswers?: string[];
  private readonly streams = new Map<string, ReadableStreamDefaultController<LifeEvent>>();
  readonly closed = new Set<string>();
  keepAlive = false;
  private readonly untilClosed = new Map<string, () => void>();
  beforeAsk?: () => Promise<void>;
  beforeStart?: (options: StartOptions) => Promise<void>;

  async close(id: SessionId): Promise<void> {
    this.closed.add(id.native);
    this.streams.get(id.native)?.close();
    this.streams.delete(id.native);
    this.untilClosed.get(id.native)?.();
  }

  async start(options: StartOptions): Promise<{ session: SessionId }> {
    await this.beforeStart?.(options);
    this.counter += 1;
    return { session: { harness: HARNESS, native: `session-${String(this.counter)}` as never } };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send(id: SessionId) {
    const turn = ++this.turn;
    const stream = this.streams.get(id.native);
    if (stream !== undefined) {
      stream.enqueue({ kind: "turn-started", turn });
      stream.enqueue({ kind: "turn-ended", turn, answer: this.turnAnswers?.shift() });
    }
    return { status: "started" as const, turn };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(
    id: SessionId,
    options: { prompt: { sections: Array<{ text: string }> }; schema: z.ZodType },
  ): Promise<{ session: SessionId; value: T; at: never }> {
    await this.beforeAsk?.();
    if (this.closed.has(id.native)) throw new Error("this conversation has closed");
    this.asked.push({
      prompt: options.prompt.sections.map((section) => section.text).join("\n\n"),
      schema: z.toJSONSchema(options.schema, { io: "input" }),
    });
    return { session: id, value: this.reply as T, at: 0 as never };
  }

  async *life(id: SessionId): AsyncIterable<LifeEvent> {
    if (this.turnAnswers !== undefined) {
      const stream = new ReadableStream<LifeEvent>({ start: (controller) => { this.streams.set(id.native, controller); } });
      yield* stream;
      return;
    }
    if (this.keepAlive && !this.closed.has(id.native)) await new Promise<void>(resolve => this.untilClosed.set(id.native, resolve));
  }

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
    control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: true, effort: ["low"], modes: ["auto"] }, tools: { niwaOnly: true, allow: false } },
  },
};

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 30_000);

async function served(options: { openBox?: boolean } = {}): Promise<{ host: Host; home: string; control: FakeControl }> {
  const home = await tempHome();
  homes.push(home);
  const control = new FakeControl();
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: [{ instance, control }], ...(options.openBox ? { sandbox: openBoxes() } : {}) }));
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

test("child session and standalone ask require both plain workflow isolation and the plain launch grant", async () => {
  const restore = useSandbox("srt", unconfined());
  const launches: Array<string | undefined> = [];
  const unlisten = onSpawn((event) => { if (event.harness === HARNESS) launches.push(event.sandbox); });
  try {
    const { host, home, control } = await served({ openBox: true });
    control.reply = { answer: "answer" };
    const asked: StartOptions[] = [];
    control.beforeStart = async (options) => {
      asked.push(options);
      const child = await spawnAgent({
        harness: HARNESS,
        program: "/bin/sh",
        args: ["-c", "exit 0"],
        cwd: options.cwd,
        env: options.env,
        box: options.box,
      });
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    };
    const script = (name: string, rule: boolean, plain: boolean) => scriptIn(home, `${name}.ts`, [
      `export default workflow({ description: "Try both session launch entry points", uses: ["session.start.fake-harness", "session.ask", "session.end"${rule ? ', "box.plain"' : ""}], output: z.json() }, async () => {`,
      `  const options = { harness: "fake-harness", model: "example", effort: "low", mode: "auto", tools: "niwa-only"${plain ? ", box: false" : ""} } as const;`,
      '  const conversation = async () => { const s = await session(options); await s.end(); return "closed"; };',
      '  const once = async () => (await ask(options, "one question")).answer;',
      '  const attempt = async (work: () => Promise<string>) => { try { return await work(); } catch (error) { return String(error); } };',
      '  return [await attempt(conversation), await attempt(once)];',
      '});',
    ]);

    const plain = await host.call(workflowStart, { file: await script("plain", true, true), box: false, wait: true, timeoutMs: 20_000 });
    expect(plain.outcome).toEqual({ status: "done", result: ["closed", "answer"] });
    expect(launches).toEqual([undefined, undefined]);
    for (const options of asked) {
      expect(options).toMatchObject({ model: "example", effort: "low", mode: "auto", tools: "niwa-only" });
      expect(options.box).toBeUndefined();
    }
    const boxed = await host.call(workflowStart, { file: await script("boxed", true, true), box: true, wait: true, timeoutMs: 20_000 });
    expect(boxed.outcome).toEqual({ status: "done", result: Array(2).fill(expect.stringContaining("PauseSignal")) });
    const denied = await host.call(workflowStart, { file: await script("denied", false, true), wait: true, timeoutMs: 20_000 });
    expect(denied.outcome).toEqual({ status: "done", result: Array(2).fill(expect.stringContaining("PauseSignal")) });
    const { id } = await host.call(workflowRegister, { file: await script("nested", true, true) });
    const parent = await scriptIn(home, "parent.ts", [
      "export default workflow({ output: z.json() }, async () => {",
      `  return await niwa.flow["${id}"]({});`,
      "});",
    ]);
    const nested = await host.call(workflowStart, { file: parent, box: true, wait: true, timeoutMs: 20_000 });
    expect(nested.outcome).toEqual({ status: "done", result: Array(2).fill(expect.stringContaining("PauseSignal")) });
    const refusals = (await host.records.read()).filter((row) => row.type === CORE_TYPES.stepOutcome)
      .map((row) => row.data as { outcome: { error?: string; effectPossible?: boolean } });
    const isolationRefusals = refusals.filter(({ outcome }) => outcome.error?.includes("requires a plain workflow"));
    const grantRefusals = refusals.filter(({ outcome }) => outcome.error?.includes("requires box.plain"));
    expect(isolationRefusals).toHaveLength(4);
    expect(grantRefusals).toHaveLength(2);
    expect([...isolationRefusals, ...grantRefusals].every(({ outcome }) => outcome.effectPossible === false)).toBe(true);
    await expect(host.call(sessionStart, { harness: HARNESS, prompt: "", box: false })).rejects.toThrow(/plain workflow/);
    expect(asked).toHaveLength(2);
    expect(launches).toHaveLength(2);

    const defaults = await host.call(workflowStart, { file: await script("defaults", false, false), wait: true, timeoutMs: 20_000 });
    expect(defaults.outcome).toEqual({ status: "done", result: ["closed", "answer"] });
    expect(launches).toEqual([undefined, undefined, "srt", "srt"]);
    const started = (await host.records.read({ types: [SessionStarted] })).map((row) => SessionStarted.schema.parse(row.data));
    expect(started.map(({ run, box }) => ({ run, box }))).toEqual([
      { run: plain.run, box: false }, { run: plain.run, box: false },
      { run: defaults.run, box: undefined }, { run: defaults.run, box: undefined },
    ]);
    expect(await host.records.read({ types: [SessionStartReserved] })).toHaveLength(4);
    const marks = (await host.records.read({ types: [SessionMarked] })).map((row) => SessionMarked.schema.parse(row.data));
    const grants = (await host.records.read({ types: [AccessGranted] })).map((row) => AccessGranted.schema.parse(row.data));
    const plainMarks = marks.filter(({ session }) => started.some((row) => row.session === session && row.run === plain.run));
    for (const { mark } of plainMarks) {
      const issued = grants.find(({ principal }) => principal.kind === "session" && principal.id === mark);
      expect(issued?.parent?.principal).toMatchObject({ kind: "run", id: plain.run });
    }
    const manifests = (await host.records.read({ types: [SessionBoxManifest] })).map((row) => SessionBoxManifest.schema.parse(row.data));
    expect(manifests.map(({ mark, sandbox }) => ({ mark, sandbox }))).toEqual(
      marks.filter(({ session }) => started.some((row) => row.session === session && row.run === defaults.run))
        .map(({ mark }) => ({ mark, sandbox: "srt" })),
    );
    expect(manifests).toHaveLength(2);

    const plainNested = await host.call(workflowStart, { file: parent, box: false, wait: true, timeoutMs: 20_000 });
    expect(plainNested.outcome).toEqual({ status: "done", result: ["closed", "answer"] });
    expect(launches.slice(-2)).toEqual([undefined, undefined]);
  } finally {
    unlisten();
    restore();
  }
}, 60_000);

const REVIEW = [
  'const Review = z.object({ verdict: z.enum(["approve", "changes"]), notes: z.array(z.string()), tag: z.string().default("none") });',
  "type Review = z.infer<typeof Review>;",
];

test("the type checker takes a typed script, and refuses a field the schema does not have", async () => {
  const { host, home } = await served();
  const typed = await scriptIn(home, "typed.ts", [
    ...REVIEW,
    "export default workflow({ output: z.json() }, async () => {",
    '  const review: Review = await ask({ harness: "fake-harness", schema: Review }, "Review it");',
    "  const first: string | undefined = review.notes[0];",
    "  const answer: { answer: string } = await ask({ harness: \"fake-harness\" }, \"free text\");",
    "  return { verdict: review.verdict, tag: review.tag, first, text: answer.answer };",
    "});",
  ]);
  expect(await host.call(workflowCheck, { file: typed })).toMatchObject({ ok: true, errors: [] });

  const wrong = await scriptIn(home, "wrong.ts", [
    ...REVIEW,
    "export default workflow({ output: z.json() }, async () => {",
    '  const review = await ask({ harness: "fake-harness", schema: Review }, "Review it");',
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
    '  const answer = await ask({ harness: "fake-harness" }, "free text");',
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
    '  const review = await ask({ harness: "fake-harness", schema: Review, label: "review" }, "Review the diff");',
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
    '  const review = await ask({ harness: "fake-harness", schema: Review }, "Review the diff");',
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
    '  const when = await ask({ harness: "fake-harness", schema: z.object({ at: z.date() }) }, "When?");',
    "  return when;",
    "});",
  ]);
  const runUnsayable = ((await host.call(START, { file })) as { run: string }).run;
  const status = await statusOf(host, runUnsayable);
  expect(status.state).toBe("paused");
  expect(JSON.stringify((await host.records.read()).map((row) => row.data))).toContain("Date cannot be represented");
  expect(control.asked).toHaveLength(0);
}, 30_000);

test("a replay gives the recorded value without asking again: another schema takes it, another prompt asks again", async () => {
  const { host, home, control } = await served();
  control.reply = { verdict: "changes", notes: ["x"] };
  const lines = (schema: string) => [
    `const Review = ${schema};`,
    "export default workflow({ output: z.json() }, async () => {",
    '  return await ask({ harness: "fake-harness", schema: Review, label: "review" }, "Review the diff");',
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

  // An agent call is its prompt and its harness: with another schema it is the same call, and its recorded answer is taken.
  await writeFile(file, lines('z.object({ verdict: z.string(), notes: z.array(z.string()), more: z.number().optional() })').join("\n"));
  await host.call(RESUME, { run: runReplay });
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "workflow.run.finished").length === 3, 20_000, "the revision should finish");
  const taken = (await host.records.read()).filter((row) => row.type === "workflow.run.finished");
  expect(taken[2]?.data).toMatchObject({ outcome: { result: { verdict: "changes", notes: ["x"] } } });
  expect(control.asked).toHaveLength(1);
  expect((await host.records.read()).filter((row) => row.type === "workflow.step.reused").map((row) => (row.data as { key: string }).key)).toEqual([
    "label:review",
    "label:review",
  ]);

  // Another prompt is another call: the session is asked.
  await writeFile(file, lines('z.object({ verdict: z.string(), notes: z.array(z.string()) })').join("\n").replace("Review the diff", "Review the whole diff"));
  await host.call(RESUME, { run: runReplay });
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "workflow.run.finished").length === 4, 20_000, "the changed prompt should run");
  expect(control.asked).toHaveLength(2);
  expect(control.asked[1]?.prompt).toContain("Review the whole diff");
}, 30_000);

test("a session handle replays each labeled turn and preserves the conversation", async () => {
  const { host, home, control } = await served();
  control.reply = { answer: "saved" };
  const file = await scriptIn(home, "conversation.js", [
    'export default workflow({ uses: ["session.start.fake-harness", "session.ask", "session.end"], output: z.json() }, async () => {',
    '  const conversation = session({ harness: "fake-harness", label: "conversation" });',
    '  const first = await conversation.ask("first", { label: "first" });',
    '  const next = await conversation.ask({ sections: [{ id: "followup", tier: "stable", text: "second" }] }, { label: "second", schema: z.object({ answer: z.string().transform(s => s.toUpperCase()) }) });',
    '  const { address } = await conversation;',
    '  await conversation.end({ label: "close" });',
    '  return { first, next, address };',
    '});',
  ]);
  const { run } = await host.call(START, { file, wait: true, timeoutMs: 20_000 }) as { run: string };
  const status = await statusOf(host, run);
  expect(status.outcome).toMatchObject({ status: "done", result: { first: { answer: "saved" }, next: { answer: "SAVED" }, address: { harness: HARNESS, id: "session-1" } } });
  await host.call(RESUME, { run });
  await eventually(async () => (await host.records.read()).filter(row => row.type === "workflow.run.finished").length === 2);
  const rows = await host.records.read();
  expect(rows.filter(row => row.type === "session.started")).toHaveLength(1);
  expect(rows.filter(row => row.type === "session.ended")).toHaveLength(1);
  expect(control.asked.map(turn => turn.prompt)).toEqual(["first", "second"]);
  expect(rows.filter(row => row.type === "workflow.step.reused").map(row => (row.data as { key: string }).key)).toEqual(["label:conversation", "label:first", "label:second", "label:close"]);
}, 30_000);

test("a recomputed conversation gets fresh authority after restart and ignores a late finish from its first execution", async () => {
  const { host: first, home, control } = await served();
  control.keepAlive = true;
  control.reply = "ok";
  const file = await scriptIn(home, "execution.js", [
    'export default workflow({ uses: ["session.start.fake-harness", "session.ask", "session.end"], output: z.json() }, async () => {',
    '  const conversation = session({ harness: "fake-harness", label: "open" });',
    '  return await conversation.ask("next", { label: "turn", schema: z.string() });',
    '});',
  ]);
  const { run } = await first.call(START, { file, wait: true }) as { run: string };
  await eventually(async () => control.closed.has("session-1") && (await first.records.read()).some(row =>
    row.type === "niwa.access.closed" && (row.data as { principal: { id: string } }).principal.id === run));
  const invocationEnded = async (target: Host) => {
    const rows = await target.records.read();
    const actor = rows.filter(row => row.type === "workflow.run.started").at(-1)?.actor;
    return actor?.kind === "handler" && rows.some(row => row.type === "niwa.invocation.state" &&
      (row.data as { invocation: string; state: string }).invocation === actor.invocation && (row.data as { state: string }).state === "done");
  };
  await eventually(() => invocationEnded(first));
  const finished = (await first.records.read()).find(row => row.type === RunFinished.name)!;
  await first.close();
  hosts.splice(hosts.indexOf(first), 1);
  const host = createNiwa({ home });
  host.use(sessions({ harnesses: [{ instance, control }] }), workflow({ harnesses: [HARNESS] }));
  await host.serve();
  hosts.push(host);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let asking = false;
  control.beforeAsk = async () => { asking = true; await gate; };
  const attempts = await Promise.allSettled([host.call(RESUME, { run, from: "label:open" }), host.call(RESUME, { run, from: "label:open" })]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  await eventually(() => asking);
  await host.emit(RunFinished, RunFinished.schema.parse(finished.data));
  expect((await host.call(actionName("workflow.inspect"), { run }) as { status: RunStatus }).status.state).toBe("running");
  release();
  expect((await statusOf(host, run)).outcome).toEqual({ status: "done", result: "ok" });
  await eventually(() => control.closed.has("session-2"));
  await eventually(async () => {
    const grants = (await host.records.read()).filter(row => row.type === "niwa.access.closed")
      .map(row => (row.data as { principal: { kind: string; id: string } }).principal).filter(p => p.kind === "run");
    return new Set(grants.map(p => p.id)).size === 2;
  });

  await eventually(() => invocationEnded(host));
  await host.call(RESUME, { run, from: "label:turn" });
  await eventually(async () => (await host.records.read()).some(row =>
    JSON.stringify(row.data).includes("recompute from the step that opened the conversation")));
  expect(control.asked).toHaveLength(2);
  const expanded = (await readFile(file, "utf8")).replace('"session.end"', '"session.end", "niwa.records.read"');
  await writeFile(file, expanded);
  await expect(host.call(actionName("workflow.revise"), { run, file })).rejects.toThrow("niwa.records.read");
  expect(control.asked).toHaveLength(2);
}, 30_000);

test("concurrent first turns share a session and another handle opens its own", async () => {
  const { host, home, control } = await served();
  control.reply = { answer: "saved" };
  const file = await scriptIn(home, "handles.js", [
    'export default workflow({ uses: ["session.start.fake-harness", "session.ask", "session.end"], output: z.json() }, async () => {',
    '  await session({ harness: "fake-harness" }).end();',
    '  const a = session({ harness: "fake-harness", label: "a" });',
    '  const b = session({ harness: "fake-harness", label: "b" });',
    '  const [first, second, opened, other] = await Promise.all([a.ask("one"), a.ask("two"), a, b]);',
    '  await Promise.all([opened.end(), opened.end()]);',
    '  try { await opened.ask("closed"); } catch (error) { return [opened.id, other.id, error.message]; }',
    '  throw new Error("asked a closed session");',
    '});',
  ]);
  const { run } = await host.call(START, { file, wait: true, timeoutMs: 20_000 }) as { run: string };
  const outcome = (await statusOf(host, run)).outcome;
  expect(outcome).toMatchObject({ status: "done", result: [expect.any(String), expect.any(String), "this workflow session has ended"] });
  await host.call(RESUME, { run });
  await eventually(async () => (await host.records.read()).filter(row => row.type === "workflow.run.finished").length === 2);
  const rows = await host.records.read();
  const sessions = rows.filter(row => row.type === "session.started").map(row => (row.data as { id: string }).id);
  expect(new Set(sessions).size).toBe(2);
  expect(sessions).toHaveLength(2);
  const results = rows.filter(row => row.type === "workflow.run.finished").map(row => (row.data as { outcome: { result: string[] } }).outcome.result);
  expect(results[0]?.slice(0, 2).sort()).toEqual([...sessions].sort());
  expect(results[1]).toEqual(results[0]);
  expect(control.asked.map(turn => turn.prompt)).toEqual(["one", "two"]);
}, 30_000);

test("session.send infers the type of its turn wait and parses the exact answer on replay", async () => {
  const { host, home, control } = await served({ openBox: true });
  control.turnAnswers = ["plain", '{"answer":"second"}'];
  const file = await scriptIn(home, "tracked-conversation.ts", [
    'export default workflow({ uses: ["session.start.fake-harness", "session.turn-send", "session.turn-wait", "session.end"], output: z.json() }, async () => {',
    '  const conversation = session({ harness: "fake-harness", label: "conversation" });',
    '  const [first, second] = await Promise.all([',
    '    conversation.send("first", { label: "a".repeat(210) }),',
    '    conversation.send("second", { label: "send-second", schema: z.object({ answer: z.string().transform(s => s.length) }) }),',
    '  ]);',
    '  const text: string = await first.wait({ label: "wait-first" });',
    '  const parsed: { answer: number } = await second.wait({ label: "wait-second" });',
    '  await conversation.end({ label: "end" });',
    '  return { text, count: parsed.answer, firstTurn: first.turn ?? null, secondTurn: second.turn ?? null };',
    '});',
  ]);
  expect(await host.call(workflowCheck, { file })).toMatchObject({ ok: true, errors: [] });
  const { run } = await host.call(START, { file, wait: true, timeoutMs: 20_000 }) as { run: string };
  const result = { text: "plain", count: 6, firstTurn: 1, secondTurn: 2 };
  expect((await statusOf(host, run)).outcome).toMatchObject({ status: "done", result });
  await host.call(RESUME, { run });
  await eventually(async () => (await host.records.read()).filter(row => row.type === "workflow.run.finished").length === 2);
  expect((await statusOf(host, run)).outcome).toMatchObject({ status: "done", result });
  const settlements = (await host.records.read()).filter(row => row.type === "session.input.settled");
  expect(settlements).toHaveLength(2);
  expect(settlements.some(row => (row.data as { operation: string }).operation.length > 200)).toBe(true);
}, 30_000);

test("the workflow type checker requires narrowing an answer from a conditional schema", async () => {
  const { host, home } = await served();
  const source = [
    'export default workflow({ output: z.json() }, async () => {',
    '  const conversation = session({ harness: "fake-harness" });',
    '  const flag = Math.random() > 0.5;',
    '  const opts = { label: "probe", schema: flag ? z.number() : undefined };',
    '  const result = await (await conversation.send("value", opts)).wait();',
  ];
  const good = await scriptIn(home, "conditional-schema.ts", [
    ...source,
    '  return typeof result === "string" ? result.toUpperCase() : result.toFixed();',
    '});',
  ]);
  expect(await host.call(workflowCheck, { file: good })).toMatchObject({ ok: true, errors: [] });
  const bad = await scriptIn(home, "conditional-schema-wrong.ts", [
    ...source,
    '  return result.toUpperCase();',
    '});',
  ]);
  expect(await host.call(workflowCheck, { file: bad })).toMatchObject({ ok: false, errors: [{ code: "TS2339", line: 6 }] });
}, 30_000);
