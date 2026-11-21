// The pi control side against a fake `pi --mode rpc` that says what the test scripts: what each
// line of the wire becomes, and that a pi that outgrew the snapshot never stops a session.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Unavailable, promptFromText } from "@niwa-labs/harness";
import type { LifeEvent } from "@niwa-labs/harness";
import { PiControl } from "../src/control.ts";
import { PiCommandSchema, PiUiResponseSchema } from "../src/protocol/index.ts";
import { eventually, tempDir } from "@niwa-labs/testing";
import { EVENT_FIXTURES, UI_FIXTURES } from "./wire-fixtures.ts";

/**
 * A fake pi. FAKE_STATE is the `data` of its answer to `get_state`. On a `prompt` it answers, then
 * writes the lines of FAKE_LINES, and ends the run with FAKE_END. A line it reads that is an
 * `extension_ui_response` is logged, and every frame it reads is kept in `frames.log`.
 */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const send = (frame) => process.stdout.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\\n");
const lines = JSON.parse(process.env.FAKE_LINES ?? "[]");
const end = JSON.parse(process.env.FAKE_END ?? '{"type":"agent_end","messages":[],"willRetry":false}');
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    appendFileSync(process.env.FAKE_DIR + "/frames.log", JSON.stringify(frame) + "\\n");
    if (frame.type === "get_state") {
      if (process.env.FAKE_BARE_STATE) send({ type: "response", id: frame.id, data: { sessionId: "s1" } });
      else send({ type: "response", id: frame.id, command: "get_state", success: true, data: JSON.parse(process.env.FAKE_STATE ?? '{"sessionId":"s1"}') });
    } else if (frame.type === "prompt") {
      send({ type: "response", id: frame.id, command: "prompt", success: true, data: { disposition: "started" } });
      send({ type: "agent_start" });
      for (const line of lines) send(line);
      if (end !== null) send(end);
    } else if (frame.type === "extension_ui_response") {
      appendFileSync(process.env.FAKE_DIR + "/replies.log", JSON.stringify(frame) + "\\n");
    }
  }
});
`;

let dir: string;
const env = (name: string, value: unknown): void => {
  process.env[name] = typeof value === "string" ? value : JSON.stringify(value);
};

beforeEach(async () => {
  dir = await tempDir("pi-wire");
  await writeFile(join(dir, "pi"), FAKE);
  await chmod(join(dir, "pi"), 0o755);
  process.env.FAKE_DIR = dir;
});

afterEach(async () => {
  for (const name of ["FAKE_DIR", "FAKE_STATE", "FAKE_LINES", "FAKE_END", "FAKE_BARE_STATE"]) delete process.env[name];
  await rm(dir, { recursive: true, force: true });
});

/** Starts a session that has no first prompt, and watches its life before any run. */
async function watched(pi: PiControl): Promise<{ send: () => Promise<unknown>; events: LifeEvent[]; ended: () => Promise<void> }> {
  const { session } = await pi.start({ prompt: promptFromText("") });
  const events: LifeEvent[] = [];
  void (async () => {
    for await (const event of pi.life(session)) events.push(event);
  })();
  return {
    send: () => pi.send(session, "go"),
    events,
    ended: () => eventually(async () => events.some((event) => event.kind === "turn-ended")),
  };
}

const details = (events: readonly LifeEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "activity" && event.detail !== undefined ? [event.detail] : []));

const replies = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, "replies.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Record<string, unknown>);

const pi = (): PiControl => new PiControl({ mode: "full", harness: "pi-wire", binary: join(dir, "pi"), callTimeoutMs: 20_000 });

test("a get_state whose body is not what the snapshot says fails the start at once, naming the answer", async () => {
  env("FAKE_STATE", { sessionId: 5 });
  const side = pi();
  const began = Date.now();
  const failure = await side.start({ prompt: promptFromText("go") }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Unavailable);
  expect(String(failure)).toContain('malformed response "get_state"');
  // It was settled by the id of its envelope, not left to the timeout of the call.
  expect(Date.now() - began).toBeLessThan(10_000);
  await side.dispose();
});

test("an answer that has an id but no command or success still settles its request at once", async () => {
  env("FAKE_BARE_STATE", "1");
  const side = pi();
  const began = Date.now();
  const failure = await side.start({ prompt: promptFromText("go") }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Unavailable);
  expect(String(failure)).toContain('response ""');
  expect(Date.now() - began).toBeLessThan(10_000);
  await side.dispose();
});

test("an agent_end without willRetry still ends the run: the session is idle after it", async () => {
  env("FAKE_END", { type: "agent_end", messages: [] });
  const side = pi();
  try {
    const { session } = await side.start({ prompt: promptFromText("") });
    const events: LifeEvent[] = [];
    void (async () => {
      for await (const event of side.life(session)) events.push(event);
    })();
    await side.send(session, "go");
    await eventually(async () => events.some((event) => event.kind === "turn-ended"));
    expect(await side.state(session)).toBe("idle");
  } finally {
    await side.dispose();
  }
});

test("an agent_end that says pi will retry does not end the turn: the session is running until the retry ends", async () => {
  env("FAKE_END", { type: "agent_end", messages: [], willRetry: true });
  const side = pi();
  try {
    const run = await watched(side);
    const session = (await run.send()) as { turn: number };
    expect(session.turn).toBe(1);
    await eventually(async () => details(run.events).includes("agent_end (pi will retry)"));
    expect(run.events.some((event) => event.kind === "turn-ended")).toBe(false);
  } finally {
    await side.dispose();
  }
});

test("a run pi retries is the same turn: one start, one end, after the last try", async () => {
  env("FAKE_LINES", [
    { type: "agent_end", messages: [], willRetry: true },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" },
    { type: "agent_start" },
  ]);
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(run.events.filter((event) => event.kind === "turn-started")).toMatchObject([{ turn: 1 }]);
    expect(run.events.filter((event) => event.kind === "turn-ended")).toMatchObject([{ turn: 1 }]);
    // The end is the last thing that happened to the turn.
    expect(run.events.at(-1)?.kind).toBe("turn-ended");
  } finally {
    await side.dispose();
  }
});

test("pi giving up a retry it announced settles the turn it held open", async () => {
  env("FAKE_LINES", [
    { type: "agent_end", messages: [], willRetry: true },
    { type: "agent_settled", aborted: true },
  ]);
  env("FAKE_END", "null");
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(run.events.filter((event) => event.kind === "turn-ended")).toHaveLength(1);
  } finally {
    await side.dispose();
  }
});

test("the end of a run is the end of a run even when a message in it has a role or a block pi grew", async () => {
  env("FAKE_END", {
    type: "agent_end",
    messages: [
      { role: "hologram", content: "x" },
      { role: "assistant", content: [{ type: "audio", data: "AAA" }], timestamp: 1 },
    ],
    willRetry: false,
  });
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(run.events.filter((event) => event.kind === "turn-started")).toHaveLength(1);
  } finally {
    await side.dispose();
  }
});

test("a request of an extension with an unknown method is cancelled, and said out loud", async () => {
  env("FAKE_LINES", [{ type: "extension_ui_request", id: "x9", method: "pickColor", title: "Color" }]);
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    await eventually(async () => (await replies()).length === 1);
    expect(await replies()).toEqual([{ type: "extension_ui_response", id: "x9", cancelled: true }]);
    expect(details(run.events).some((detail) => detail.includes('"pickColor"') && detail.includes("unrecognized"))).toBe(true);
  } finally {
    await side.dispose();
  }
});

test("an event pi grew is an activity that carries it, and the run goes on to its end", async () => {
  env("FAKE_LINES", [{ type: "turn_quantum", flux: 3 }, EVENT_FIXTURES.turn_start]);
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    const said = details(run.events);
    expect(said[0]).toContain('"turn_quantum"');
    expect(said[0]).toContain('"flux":3');
    expect(said[1]).toBe("turn_start");
    // The same line is the typed unknown the sessions plugin records.
    expect(run.events.filter((event) => event.kind === "unknown-variant")).toEqual([
      expect.objectContaining({ protocol: "pi rpc", variant: "turn_quantum", raw: { type: "turn_quantum", flux: 3 } }),
    ]);
  } finally {
    await side.dispose();
  }
});

test("every event but the run's two is an activity named by its type; the steps of a run are not turns of niwa", async () => {
  const steps = Object.entries(EVENT_FIXTURES).filter(([type]) => type !== "agent_start" && type !== "agent_end");
  env("FAKE_LINES", steps.map(([, fixture]) => fixture));
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(details(run.events)).toEqual(steps.map(([type]) => type));
    expect(run.events.filter((event) => event.kind === "turn-started")).toHaveLength(1);
    expect(run.events.filter((event) => event.kind === "turn-ended")).toHaveLength(1);
  } finally {
    await side.dispose();
  }
});

test("the notices of an extension are neither activity nor answered; its failure is an activity", async () => {
  const notices = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].map((method) => UI_FIXTURES[method]);
  env("FAKE_LINES", [...notices, { type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" }]);
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(details(run.events)).toEqual(["an extension of pi failed: /x.ts (tool_call): boom"]);
    expect(await replies()).toEqual([]);
  } finally {
    await side.dispose();
  }
});

test("a line that is not JSON is an activity, and an answer with no id is one too", async () => {
  env("FAKE_LINES", ["this is not json", { type: "response", command: "parse", success: false, error: "Failed to parse command" }]);
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    expect(details(run.events)).toEqual([
      "a line of the wire could not be read",
      "pi answered without an id: Failed to parse command",
    ]);
  } finally {
    await side.dispose();
  }
});

test("everything niwa writes is a command pi has or an answer to a dialog", async () => {
  const side = pi();
  try {
    const run = await watched(side);
    await run.send();
    await run.ended();
    const frames = (await readFile(join(dir, "frames.log"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string });
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const known = frame.type === "extension_ui_response" ? PiUiResponseSchema.safeParse(frame) : PiCommandSchema.safeParse(frame);
      expect(known.success).toBe(true);
    }
  } finally {
    await side.dispose();
  }
});
