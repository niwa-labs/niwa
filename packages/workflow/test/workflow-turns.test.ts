// `turns.first` and `turns.all`: group waits over the turn handles `session.send` returned, as one
// step with one deadline. The fake control side starts a turn per send and ends it only when the
// test says so, so:
//
//   1. the type checker takes a script that waits on a group and types each value by its handle's
//      schema, and refuses a field no branch of the value union has;
//   2. `first` wakes on the first settlement with the rest pending, `all` waits for every one, and
//      both answer `{ done, pending, timedOut }` keyed by input index, the values parsed;
//   3. a turn that settles while the group waits wakes it, and a failure settles its turn for the
//      group as a success does;
//   4. a refinement that lives only in the script's zod schema — the wire carried just the JSON
//      Schema — rejects that one handle as `invalid-answer`, and its siblings and the pending
//      handles of the same group are answered as they are.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { actionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, LifeEvent, SessionControl, SessionId } from "@niwa-labs/harness";
import { createNiwa, eventually, openBoxes, sessions, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { RunFinished, workflow, workflowCheck } from "../src/index.ts";
import type { RunStatus } from "../src/status.ts";

const HARNESS = harnessId("fake-harness");
const START = actionName("workflow.start");
const WAIT = actionName("workflow.wait");

/**
 * The fake control side: each send starts a turn that stays open until the test ends it. A turn is
 * ended by `settle`, the oldest open one first, with the answer given (or none: the turn fails).
 */
class FakeControl implements SessionControl {
  private counter = 0;
  private turn = 0;
  private open: Array<{ turn: number; native: string }> = [];
  private readonly streams = new Map<string, ReadableStreamDefaultController<LifeEvent>>();

  async close(id: SessionId): Promise<void> {
    this.streams.get(id.native)?.close();
    this.streams.delete(id.native);
  }

  async start(): Promise<{ session: SessionId }> {
    this.counter += 1;
    return { session: { harness: HARNESS, native: `session-${String(this.counter)}` as never } };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send(id: SessionId) {
    const turn = ++this.turn;
    this.open.push({ turn, native: id.native });
    this.streams.get(id.native)?.enqueue({ kind: "turn-started", turn });
    return { status: "started" as const, turn };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(): Promise<{ session: SessionId; value: T; at: never }> {
    throw new Error("this conversation is asked through sends");
  }

  /** End the oldest open turn: with the answer, completed, or failed when there is none. */
  settle(answer?: string): void {
    const next = this.open.shift();
    const stream = next === undefined ? undefined : this.streams.get(next.native);
    if (next === undefined || stream === undefined) return;
    if (answer === undefined) stream.enqueue({ kind: "turn-ended", turn: next.turn, outcome: "failed" });
    else stream.enqueue({ kind: "turn-ended", turn: next.turn, answer });
  }

  async *life(id: SessionId): AsyncIterable<LifeEvent> {
    const stream = new ReadableStream<LifeEvent>({ start: (controller) => { this.streams.set(id.native, controller); } });
    yield* stream;
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
    control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } },
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
  host.use(sessions({ harnesses: [{ instance, control }], sandbox: openBoxes() }));
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

const USES = ["session.start.fake-harness", "session.turn-send", "session.turn-wait", "session.turn-wait-many", "session.end"];

test("the type checker types a group wait by the handles and refuses a field no value has", async () => {
  const { host, home } = await served();
  const lines = (reading: string) => [
    "const Sum = z.object({ sum: z.number() });",
    "const Name = z.object({ name: z.string() });",
    "export default workflow({ output: z.json() }, async () => {",
    '  const one = session({ harness: "fake-harness", label: "one" });',
    '  const two = session({ harness: "fake-harness", label: "two" });',
    '  const a = await one.send("sum", { label: "a", schema: Sum });',
    '  const b = await two.send("name", { label: "b", schema: Name });',
    '  const raced = await turns.first([a, b], { timeout: "1m", label: "race" });',
    '  const rest = await turns.all([a, b], { timeout: "1m", label: "rest" });',
    "  await one.end();",
    "  await two.end();",
    `  return ${reading};`,
    "});",
  ];
  const good = await scriptIn(home, "turns-good.ts", lines(
    'raced.done.map((e) => e.result.status === "completed" ? ("sum" in e.result.value ? e.result.value.sum : e.result.value.name.length) : 0)',
  ));
  expect(await host.call(workflowCheck, { file: good })).toMatchObject({ ok: true, errors: [] });

  const bad = await scriptIn(home, "turns-bad.ts", lines(
    'raced.done[0]!.result.status === "completed" && "sum" in raced.done[0]!.result.value ? raced.done[0]!.result.value.missing : 0',
  ));
  const report = await host.call(workflowCheck, { file: bad });
  expect(report.ok).toBe(false);
  expect(report.errors[0]).toMatchObject({ code: "TS2339" });
}, 30_000);

test("turns.first wakes on the first settlement and turns.all waits for every one, the values parsed", async () => {
  const { host, home, control } = await served();
  const file = await scriptIn(home, "turns.ts", [
    "const Sum = z.object({ sum: z.number() });",
    "const Name = z.object({ name: z.string() });",
    `export default workflow({ uses: ${JSON.stringify(USES)}, output: z.json() }, async () => {`,
    '  const one = session({ harness: "fake-harness", label: "one" });',
    '  const two = session({ harness: "fake-harness", label: "two" });',
    '  const a = await one.send("sum", { label: "a", schema: Sum });',
    '  const b = await two.send("name", { label: "b", schema: Name });',
    '  const c = await two.send("later", { label: "c" });',
    '  const raced = await turns.first([a, b], { timeout: "1m", label: "race" });',
    '  const first = [raced.timedOut, raced.done.map((e) => [e.index, e.result.status]), raced.pending.map((e) => e.index)];',
    '  const rest = await turns.all([a, b], { timeout: "1m", label: "rest" });',
    '  const values = rest.done.map((e) => e.result.status === "completed" ? e.result.value : null);',
    '  const failed = await turns.first([c], { timeout: "1m", label: "failed" });',
    "  await one.end();",
    "  await two.end();",
    '  return { first, all: [rest.timedOut, rest.pending.map((e) => e.index), values], failed: failed.done[0]!.result.status };',
    "});",
  ]);
  expect(await host.call(workflowCheck, { file })).toMatchObject({ ok: true, errors: [] });
  const { run } = await host.call(START, { file }) as { run: string };
  // The turns are open: the group waits are out, and the turns settle under them.
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-started").length === 3, 20_000);
  control.settle('{"sum": 5}');
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-result").length === 1, 20_000);
  control.settle('{"name": "niwa"}');
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-result").length === 2, 20_000);
  // The last turn fails under its group wait: a failure settles it too.
  control.settle();
  const outcome = (await statusOf(host, run)).outcome;
  expect(outcome).toMatchObject({
    status: "done",
    result: {
      first: [false, [[0, "completed"]], [1]],
      all: [false, [], [{ sum: 5 }, { name: "niwa" }]],
      failed: "ended",
    },
  });
}, 30_000);

test("a local refinement that rejects one answer marks that handle invalid and keeps its siblings", async () => {
  const { host, home, control } = await served();
  const file = await scriptIn(home, "refine.ts", [
    // The refinement never reaches the wire: the host sees a JSON Schema that describes a number.
    "const Small = z.object({ value: z.number().refine((n) => n < 3) });",
    "const Name = z.object({ name: z.string() });",
    `export default workflow({ uses: ${JSON.stringify(USES)}, output: z.json() }, async () => {`,
    '  const one = session({ harness: "fake-harness", label: "one" });',
    '  const a = await one.send("a value under 3", { label: "a", schema: Small });',
    '  const b = await one.send("a name", { label: "b", schema: Name });',
    '  const c = await one.send("later", { label: "c" });',
    '  const raced = await turns.first([a, b, c], { timeout: "1m", label: "raced" });',
    '  const first = [raced.timedOut, raced.done.map((e) => [e.index, e.result.status]), raced.pending.map((e) => e.index)];',
    '  const rest = await turns.all([a, b], { timeout: "1m", label: "rest" });',
    '  const values = rest.done.map((e) => e.result.status === "completed" ? e.result.value : null);',
    "  await one.end();",
    '  return { first, all: [rest.timedOut, rest.pending.map((e) => e.index), values] };',
    "});",
  ]);
  expect(await host.call(workflowCheck, { file })).toMatchObject({ ok: true, errors: [] });
  const { run } = await host.call(START, { file }) as { run: string };
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-started").length === 3, 20_000);

  // The answer passes the JSON Schema the host holds, and fails the refinement the script holds:
  // the group wakes with that handle invalid-answer, its siblings still pending.
  control.settle('{"value": 5}');
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-result").length === 1, 20_000);

  // The valid sibling is answered beside it, not hidden by the failed parse.
  control.settle('{"name": "niwa"}');
  await eventually(async () => (await host.records.read()).filter((row) => row.type === "session.turn-result").length === 2, 20_000);
  control.settle("nothing to wait for");
  const outcome = (await statusOf(host, run)).outcome;
  expect(outcome).toMatchObject({
    status: "done",
    result: {
      first: [false, [[0, "invalid-answer"]], [1, 2]],
      all: [false, [], [null, { name: "niwa" }]],
    },
  });
}, 30_000);
