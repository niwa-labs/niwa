/**
 * What the SDK control side holds a session to: its servers, its launch values, its turns, and who
 * writes the session. No process runs; the query is scripted.
 */

import { expect, test } from "bun:test";
import { z } from "zod";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import type { LifeEvent, McpServerSpec, SessionId } from "@niwa-labs/harness";

import { ClaudeSdkControl } from "../../src/sdk/control.ts";
import { scriptedQuery } from "./scripted.ts";

const HARNESS = harnessId("claude-sdk-scripted");

const NIWA: McpServerSpec = { name: "niwa", command: "/bin/niwa", args: ["mcp", "--home", "/h"], env: { NIWA_ID: "tok" } };

/** The turn signs of a session, as they are written. */
function turnsOf(events: readonly LifeEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "turn-started" || event.kind === "turn-ended" ? [`${event.kind}:${event.turn}`] : []));
}

/** Collects the events of a session in the background. */
function watch(control: ClaudeSdkControl, id: SessionId): LifeEvent[] {
  const seen: LifeEvent[] = [];
  void (async () => {
    for await (const event of control.life(id)) seen.push(event);
  })().catch(() => {});
  return seen;
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !done(); waited += 5) {
    if (waited > 3_000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test("the servers of a session reach the SDK by name, and a session held to a set of tools gets no other server", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    await control.start({ prompt: promptFromText("one"), servers: [NIWA], tools: "niwa-only" });
    expect(fake.served[0]?.options.mcpServers).toEqual({
      niwa: { type: "stdio", command: "/bin/niwa", args: ["mcp", "--home", "/h"], env: { NIWA_ID: "tok" } },
    });
    expect(fake.served[0]?.options.strictMcpConfig).toBe(true);

    await control.start({ prompt: promptFromText("two"), servers: [NIWA], tools: { allow: ["Read"] } });
    expect(fake.served[1]?.options).toMatchObject({ tools: ["Read"], strictMcpConfig: true });

    // A session with all of its tools is not cut off from the owner's own servers.
    await control.start({ prompt: promptFromText("three") });
    expect(fake.served[2]?.options.strictMcpConfig).toBeUndefined();
    expect(fake.served[2]?.options.mcpServers).toBeUndefined();
  } finally {
    await control.dispose();
  }
});

test("close ends the query of one session, as the contract's release", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    await control.close(id);
    expect(await control.state(id)).toBe("unknown");
  } finally {
    await control.dispose();
  }
});

test("a question and a process launched again keep the servers of the session", async () => {
  const fake = scriptedQuery();
  const started = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  const again = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const { session: id } = await started.start({ prompt: promptFromText("one"), servers: [NIWA], tools: "niwa-only" });
    await started.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.served.at(-1)?.options).toMatchObject({ resume: id.native, strictMcpConfig: true });
    expect(Object.keys(fake.served.at(-1)?.options.mcpServers ?? {})).toEqual(["niwa"]);

    await started.dispose();
    await again.resume(id, { servers: [NIWA], tools: "niwa-only" });
    expect(Object.keys(fake.served.at(-1)?.options.mcpServers ?? {})).toEqual(["niwa"]);
    await again.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(Object.keys(fake.served.at(-1)?.options.mcpServers ?? {})).toEqual(["niwa"]);
  } finally {
    await started.dispose();
    await again.dispose();
  }
});

test("a question runs in the directory, with the effort and the tool switches the session was started with", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const { session: id } = await control.start({
      prompt: promptFromText("one"),
      cwd: "/work/project",
      effort: "high",
      visible: { actions: [], disabledTools: ["Write"] },
    });
    await control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.served.at(-1)?.options).toMatchObject({ cwd: "/work/project", effort: "high", disallowedTools: ["Write"], resume: id.native });
  } finally {
    await control.dispose();
  }
});

test("a process launched again is run in the directory it is given, else in the one the session had", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one"), cwd: "/work/project", effort: "low" });
    // The query ended: the next resume launches it again.
    fake.served[0]?.options.abortController?.abort();
    await until(async () => (await control.state(id)) === "unknown", "the query to end").catch(() => {});
    await control.dispose();
    const again = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
    try {
      await again.resume(id, { cwd: "/elsewhere" });
      expect(fake.served.at(-1)?.options.cwd).toBe("/elsewhere");
    } finally {
      await again.dispose();
    }
  } finally {
    await control.dispose();
  }
});

test("messages that are queued are written one at a time, each a turn of its own, though the program merges what reaches it together", async () => {
  const fake = scriptedQuery({ mergeWindowMs: 40 });
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const block = fake.hold();
    const { session: id, first } = await control.start({ prompt: promptFromText("one") });
    const seen = watch(control, id);
    expect(first).toMatchObject({ status: "started", turn: 1 });
    expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
    expect(await control.send(id, "three")).toMatchObject({ status: "queued", turn: 3 });
    block.release();
    await until(() => turnsOf(seen).includes("turn-ended:3"), "the third turn to end");
    expect(turnsOf(seen)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2", "turn-ended:2", "turn-started:3", "turn-ended:3"]);
    expect(fake.served[0]?.received).toEqual(["one", "two", "three"]);
    expect(await control.state(id)).toBe("idle");
  } finally {
    await control.dispose();
  }
});

test("a question holds the session: state says running, a send waits behind it, and an interrupt reaches the query of the question", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const seen = watch(control, id);
    await until(() => turnsOf(seen).includes("turn-ended:1"), "the first turn to end");

    const block = fake.hold();
    const asked = control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    await until(() => fake.served.length === 2, "the question to open its query");
    expect(await control.state(id)).toBe("running");
    expect(turnsOf(seen)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2"]);

    // A message sent meanwhile waits: the held query is not written while the question runs.
    expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 3 });
    await Bun.sleep(30);
    expect(fake.served[0]?.received).toEqual(["one"]);

    block.release();
    expect((await asked).value).toBe("ok");
    await until(() => turnsOf(seen).includes("turn-ended:3"), "the queued message to run");
    expect(turnsOf(seen)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2", "turn-ended:2", "turn-started:3", "turn-ended:3"]);
    expect(fake.served[0]?.received).toEqual(["one", "two"]);

    // An interrupt of the turn a question is goes to the query of the question.
    const hold = fake.hold();
    const second = control.ask(id, { schema: z.string(), prompt: promptFromText("again?") });
    const failed = second.then(() => "answered", (error: unknown) => error);
    await until(() => fake.served.length === 3, "the second question to open its query");
    await control.interrupt(id);
    expect(await failed).toBeInstanceOf(Error);
    expect(fake.served[2]?.interrupts).toBe(1);
    expect(fake.served[0]?.interrupts).toBe(0);
    hold.release();
  } finally {
    await control.dispose();
  }
});

test("a question waits behind a turn that runs, as a send does: no query of its own opens before it ends", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const block = fake.hold();
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const seen = watch(control, id);
    const asked = control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    await Bun.sleep(30);
    // The first turn still runs: the question has not opened a query of its own.
    expect(fake.served.length).toBe(1);
    block.release();
    await asked;
    expect(turnsOf(seen)).toEqual(["turn-started:1", "turn-ended:1", "turn-started:2", "turn-ended:2"]);
  } finally {
    await control.dispose();
  }
});

test("the end of a turn carries how it ended: failed when the program's result is an error, completed when it succeeded", async () => {
  const fake = scriptedQuery();
  const control = new ClaudeSdkControl({ harness: HARNESS, query: fake.query });
  try {
    const block = fake.hold();
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const seen = watch(control, id);
    await control.interrupt(id);
    block.release();
    await control.send(id, "two");
    await until(() => turnsOf(seen).includes("turn-ended:2"), "the second turn to end");
    const outcomes = seen.flatMap((event) => (event.kind === "turn-ended" ? [[event.turn, event.outcome]] : []));
    expect(outcomes).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
  } finally {
    await control.dispose();
  }
});
