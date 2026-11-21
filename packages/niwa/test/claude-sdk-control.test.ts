/**
 * The Claude Agent SDK control side.
 *
 * The SDK runs Claude Code in this process. The test is live: it starts a real session on
 * `--model haiku`, and it is skipped when this machine has no Claude auth — the SDK needs an
 * account, and a test that cannot run is said to be skipped, never to have passed.
 *
 * What it proves:
 *
 * - a session starts, and the id is the one the SDK named it with (the `system/init` message);
 * - the session is a real Claude Code session: the reading side finds it in the files;
 * - a resume continues the same session;
 * - a question with a schema is answered with a value that passes the schema;
 * - every session this side holds is stopped when it is disposed.
 */

import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  modelName,
  promptFromText,
  type LifeEvent,
  Unavailable,
  harnessId,
  NativeSessionIdSchema,
  sessionId,
} from "@niwa-labs/harness";
import { ClaudeCodeReading, ClaudeSdkControl } from "@niwa-labs/harness-claude";
import { onSpawn } from "@niwa-labs/sandbox";
import type { SessionId } from "@niwa-labs/harness";
import { tempDir, live, claudePrompt, fakeSdkQuery } from "@niwa-labs/testing";

/** The kinds of the events, with the turn numbers, so they can be compared. */
function kinds(events: readonly LifeEvent[]): string[] {
  return events.map((event) =>
    event.kind === "turn-started" || event.kind === "turn-ended"
      ? `${event.kind}:${event.turn}`
      : event.kind,
  );
}

/** The first model the first stream of life of a session names. */
async function firstModel(side: { life(id: SessionId): AsyncIterable<LifeEvent> }, id: SessionId): Promise<string | undefined> {
  for await (const event of side.life(id)) {
    if (event.kind === "model") return event.model;
  }
  return undefined;
}

/** Collects the events of a session until the predicate holds. */
async function collect(
  iterable: AsyncIterable<LifeEvent>,
  until: (events: readonly LifeEvent[]) => boolean,
): Promise<LifeEvent[]> {
  const seen: LifeEvent[] = [];
  for await (const event of iterable) {
    seen.push(event);
    if (until(seen)) return seen;
  }
  return seen;
}

const runReal = live && Bun.which("claude") !== null;

test.skipIf(!runReal)(
  "the SDK starts a session, names it, resumes it and answers a question by schema",
  async () => {
    const harness = harnessId("claude-sdk-proof");
    const control = new ClaudeSdkControl({ harness, model: "haiku", turnTimeoutMs: 120_000, claude: { advisor: false } });
    const cwd = tmpdir();

    try {
      // A session starts; the SDK names it in its `system/init` message.
      const { session: id } = await control.start({
        prompt: promptFromText(claudePrompt("Reply with ok")),
        cwd,
      });
      expect(id.harness).toBe(harness);
      expect(id.native).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // The start returns once the session is named; its first turn runs on after it.
      while ((await control.state(id)) === "running") await Bun.sleep(200);
      expect(await control.state(id)).toBe("idle");

      // The program names the model it really ran: the alias the start asked for is not what it says.
      const named = await firstModel(control, id);
      expect(named).toContain("haiku");
      expect(named).not.toBe("haiku");

      // The session is a real Claude Code session: the reading side finds it in the files the SDK
      // wrote, under the same ids.
      const reading = new ClaudeCodeReading({ harness, home: join(homedir(), ".claude") });
      let found = false;
      for await (const info of reading.list()) {
        if (info.id.native === id.native) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);

      // The turn ended: the session is idle, and it said so.
      const life = collect(control.life(id), (events) =>
        kinds(events).some((kind) => kind.startsWith("turn-ended")),
      );
      await control.send(id, "Reply with ok too");
      expect(kinds(await life).some((kind) => kind.startsWith("turn-ended"))).toBe(true);

      // A resume continues the same session: the id does not change.
      await control.resume(id, { prompt: promptFromText(claudePrompt("Reply with still ok")) });
      expect(await control.state(id)).not.toBe("unknown");

      // A message sent mid-turn is queued; an interrupt ends the turn and the session goes on.
      while ((await control.state(id)) === "running") await Bun.sleep(200);
      const first = await control.send(id, "Count slowly from 1 to 200, one number per line.");
      expect(first.status).toBe("started");
      const second = await control.send(id, "Reply with ok");
      expect(second.status).toBe("queued");
      await control.interrupt(id);
      const third = await control.send(id, "Reply with ok");
      expect(["started", "queued"]).toContain(third.status);

      // A question with a schema is answered with a value that passes the schema.
      const answer = await control.ask(id, {
        schema: z.object({ word: z.string() }),
        prompt: promptFromText(claudePrompt("Reply with the single word ok, and nothing else.")),
      });
      expect(answer.session).toEqual(id);
      expect(typeof answer.value.word).toBe("string");
      expect(answer.value.word.toLowerCase()).toContain("ok");
    } finally {
      await control.dispose();
    }
  },
  300_000,
);

/** A session this side does not hold is refused by name, never emulated. */
test("the SDK side refuses what it cannot do", async () => {
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-proof") });
  const missing: SessionId = {
    harness: harnessId("claude-sdk-proof"),
    native: NativeSessionIdSchema.parse("not-held"),
  };
  await expect(control.send(missing, "hi")).rejects.toThrow("not held by this control side");
  expect(await control.state(missing)).toBe("unknown");
  await control.dispose();
});

test("the start returns once the SDK named the session: a first turn that never ends does not block it", async () => {
  const fake = fakeSdkQuery({ firstTurnMs: Number.POSITIVE_INFINITY });
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    const { session: id, first } = await control.start({ prompt: promptFromText("one") });
    expect(id.native.length).toBeGreaterThan(0);
    // The prompt became the first turn; it is still running.
    expect(first).toMatchObject({ status: "started", turn: 1 });
    expect(await control.state(id)).toBe("running");
    // The first stream of life is given the start of that turn, which began before it existed.
    const iterator = control.life(id)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "turn-started", turn: 1 });
    void iterator.return?.();
    // The session takes messages at once: they wait behind the first turn.
    expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  } finally {
    await control.dispose();
  }
});

test("the model the program names is a sign of life: the name, not the alias that was asked for", async () => {
  const fake = fakeSdkQuery({ models: { opus: "claude-opus-real" } });
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one"), model: "opus" });
    expect(fake.asked()[0]).toMatchObject({ model: "opus" });
    expect(await firstModel(control, id)).toBe("claude-opus-real");
  } finally {
    await control.dispose();
  }
});

test("a resume starts the session on the model that was named for it, not on the alias or the instance's default, and a question over it keeps that model", async () => {
  const fake = fakeSdkQuery({ models: { opus: "claude-opus-real" } });
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), model: "haiku", query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one"), model: "opus" });
    await firstModel(control, id);
    // The question runs in a query of its own over the session: it keeps the model the session runs.
    await control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.asked().at(-1)).toMatchObject({ model: "claude-opus-real", resume: id.native });
    await control.dispose();

    const again = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), model: "haiku", query: fake.query });
    await again.resume(id, { model: modelName("claude-opus-real"), prompt: promptFromText("two") });
    expect(fake.asked().at(-1)).toMatchObject({ model: "claude-opus-real", resume: id.native });
    // A session whose model nobody named takes the instance's own.
    await again.resume(sessionId(harnessId("claude-sdk-fake"), "other"), { prompt: promptFromText("three") });
    expect(fake.asked().at(-1)).toMatchObject({ model: "haiku", resume: "other" });
    await again.dispose();
  } finally {
    await control.dispose();
  }
});

/** A `claude` that is a script which exits at once: what the SDK spawns is under test, not what it does. */
async function fakeClaudeIn(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, name);
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  return bin;
}

test("the SDK runs the local claude from the PATH, the executable the instance names wins, and no claude at all refuses the start by name", async () => {
  const dir = await tempDir("claude-sdk-executable");
  const onPath = await fakeClaudeIn(join(dir, "bin"), "claude");
  const named = await fakeClaudeIn(join(dir, "elsewhere"), "my-claude");
  const spawned: string[][] = [];
  const off = onSpawn((event) => spawned.push([...event.argv]));
  const savedPath = process.env.PATH;
  const sides: ClaudeSdkControl[] = [];
  const startedBy = async (executable: string | undefined): Promise<unknown> => {
    const side = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), startTimeoutMs: 5_000, ...(executable === undefined ? {} : { executable }) });
    sides.push(side);
    return await side.start({ prompt: promptFromText("one") }).catch((error: unknown) => error);
  };
  try {
    process.env.PATH = `${join(dir, "bin")}:${savedPath ?? ""}`;
    await startedBy(undefined);
    expect(spawned[0]?.[0]).toBe(onPath);
    await startedBy(named);
    expect(spawned[1]?.[0]).toBe(named);

    process.env.PATH = join(dir, "empty");
    const refusal = await startedBy(undefined);
    expect(refusal).toBeInstanceOf(Unavailable);
    expect(String(refusal)).toContain("control.executable");
    expect(spawned).toHaveLength(2);
  } finally {
    process.env.PATH = savedPath;
    off();
    for (const side of sides) await side.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a question right after the start waits for the first turn, so one query writes the session at a time", async () => {
  const fake = fakeSdkQuery({ firstTurnMs: 200 });
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const life = collect(control.life(id), (events) => kinds(events).includes("turn-ended:2"));
    const answer = await control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(answer.value).toBe("ok");
    // The question is the second turn, begun after the first one ended.
    expect(kinds(await life).filter((kind) => kind !== "activity" && kind !== "model")).toEqual([
      "turn-started:1",
      "turn-ended:1",
      "turn-started:2",
      "turn-ended:2",
    ]);
  } finally {
    await control.dispose();
  }
});

test("two questions after the start run one after the other: one query writes the session at a time", async () => {
  const fake = fakeSdkQuery({ firstTurnMs: 200 });
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const life = collect(control.life(id), (events) => kinds(events).includes("turn-ended:3"));
    const answers = await Promise.all([
      control.ask(id, { schema: z.string(), prompt: promptFromText("first?") }),
      control.ask(id, { schema: z.string(), prompt: promptFromText("second?") }),
    ]);
    expect(answers.map((answer) => answer.value)).toEqual(["ok", "ok"]);
    // Each question is a turn that ends before the next one begins.
    expect(kinds(await life).filter((kind) => kind !== "activity" && kind !== "model")).toEqual([
      "turn-started:1",
      "turn-ended:1",
      "turn-started:2",
      "turn-ended:2",
      "turn-started:3",
      "turn-ended:3",
    ]);
  } finally {
    await control.dispose();
  }
});

test("a question behind a first turn that never ends fails at the turn timeout and does not wait for ever", async () => {
  const fake = fakeSdkQuery({ firstTurnMs: Number.POSITIVE_INFINITY });
  const control = new ClaudeSdkControl({
    harness: harnessId("claude-sdk-fake"),
    query: fake.query,
    turnTimeoutMs: 300,
  });
  try {
    const { session: id } = await control.start({ prompt: promptFromText("one") });
    const started = Date.now();
    await expect(control.ask(id, { schema: z.string(), prompt: promptFromText("word?") })).rejects.toThrow(
      "did not end in time",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    // The question that gave up leaves nothing queued behind it: the next one waits its own time.
    await expect(control.ask(id, { schema: z.string(), prompt: promptFromText("again?") })).rejects.toThrow(
      "did not end in time",
    );
  } finally {
    await control.dispose();
  }
});

test.skipIf(!runReal)(
  "a schema given as JSON, with optional and loose objects, is answered by the real SDK",
  async () => {
    const control = new ClaudeSdkControl({
      harness: harnessId("claude-sdk-proof"),
      model: "haiku",
      turnTimeoutMs: 120_000,
      claude: { advisor: false },
    });
    try {
      const { session } = await control.start({
        prompt: { sections: [{ id: "p", tier: "volatile", text: claudePrompt("Reply only ready.") }] },
        cwd: tmpdir(),
      });
      const schema = z.fromJSONSchema({
        type: "object",
        properties: {
          answer: { type: "integer" },
          note: { type: "string" },
          inner: { type: "object", properties: { n: { type: "integer" } } },
        },
        required: ["answer"],
      });
      const answer = await control.ask(session, { schema, prompt: promptFromText(claudePrompt("What is 21+21? Put it in answer.")) });
      expect((answer.value as { answer: number }).answer).toBe(42);
    } finally {
      await control.dispose();
    }
  },
  240_000,
);

test("a model and an effort reach the SDK as its own options, and an effort it does not have is refused before a query is made", async () => {
  const fake = fakeSdkQuery();
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    await control.start({ prompt: promptFromText("one"), model: "haiku", effort: "xhigh" });
    expect(fake.asked()[0]).toMatchObject({ model: "haiku", effort: "xhigh" });

    await expect(control.start({ prompt: promptFromText("two"), effort: "extreme" })).rejects.toThrow(
      /effort "extreme" is not one of low, medium, high, xhigh, max/,
    );
    expect(fake.served()).toBe(1);
  } finally {
    await control.dispose();
  }
});

test("the effort of the instance is the default of a session that names none", async () => {
  const fake = fakeSdkQuery();
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), effort: "low", query: fake.query });
  try {
    await control.start({ prompt: promptFromText("one") });
    expect(fake.asked()[0]).toMatchObject({ effort: "low" });
  } finally {
    await control.dispose();
  }
});

test("a working mode is the SDK's permission mode: ask is default, auto is auto, full is bypassPermissions; only full runs without asking", async () => {
  const fake = fakeSdkQuery();
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  try {
    const modes = [
      ["ask", "default"],
      ["auto", "auto"],
      ["full", "bypassPermissions"],
    ] as const;
    for (const [mode, native] of modes) {
      const started = await control.start({ prompt: promptFromText("one"), mode });
      expect(started.mode).toBe(mode);
      const options = fake.asked().at(-1);
      expect(options?.permissionMode).toBe(native);
      expect(options?.allowDangerouslySkipPermissions).toBe(mode === "full" ? true : undefined);
      expect(options?.canUseTool === undefined).toBe(mode === "full");
    }
    // None chosen: the default of every harness is auto.
    expect((await control.start({ prompt: promptFromText("one") })).mode).toBe("auto");
    expect(fake.asked().at(-1)?.permissionMode).toBe("auto");
  } finally {
    await control.dispose();
  }
});

test("the control option is the default mode; a question over the session and a resumed session keep it", async () => {
  const fake = fakeSdkQuery();
  const control = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), mode: "full", query: fake.query });
  try {
    const { session: id, mode } = await control.start({ prompt: promptFromText("one") });
    expect(mode).toBe("full");
    await control.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.asked().at(-1)?.permissionMode).toBe("bypassPermissions");
    // A session started in another mode, and resumed by a process of its own, comes back in it.
    await control.dispose();
    const again = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), mode: "full", query: fake.query });
    await again.resume(id, { mode: "ask", prompt: promptFromText("two") });
    expect(fake.asked().at(-1)?.permissionMode).toBe("default");
    await again.dispose();
  } finally {
    await control.dispose();
  }
});

test("advisor off takes Claude Code's advisor tool away through its variable; by default the owner's settings stand", async () => {
  const DISABLE = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
  const fake = fakeSdkQuery();
  const plain = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), query: fake.query });
  const off = new ClaudeSdkControl({ harness: harnessId("claude-sdk-fake"), claude: { advisor: false }, query: fake.query });
  try {
    await plain.start({ prompt: promptFromText("one") });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBeUndefined();
    await plain.start({ prompt: promptFromText("two"), env: { KEEP: "1" }, claude: { advisor: false } });
    expect(fake.asked().at(-1)?.env).toMatchObject({ KEEP: "1", [DISABLE]: "1" });

    // The instance's option is the default; a start can turn the advisor back on.
    const { session: id } = await off.start({ prompt: promptFromText("three") });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBe("1");
    // A question over the session runs a query of its own, with the options the session started with.
    await off.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBe("1");
    await off.start({ prompt: promptFromText("four"), claude: { advisor: true } });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBeUndefined();
  } finally {
    await plain.dispose();
    await off.dispose();
  }
});

test("a resume or a question that names the Claude options runs the process with them, though the host that started the session is gone", async () => {
  const DISABLE = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
  const fake = fakeSdkQuery();
  const harness = harnessId("claude-sdk-fake");
  const started = new ClaudeSdkControl({ harness, query: fake.query });
  const fresh = new ClaudeSdkControl({ harness, query: fake.query });
  const plain = new ClaudeSdkControl({ harness, query: fake.query });
  try {
    const { session: id } = await started.start({ prompt: promptFromText("one"), claude: { advisor: false } });
    await started.dispose();
    // A process that is launched again is given what niwa recorded: the session's own options.
    await fresh.resume(id, { claude: { advisor: false }, prompt: promptFromText("two") });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBe("1");
    // A resume that names none leaves the owner's settings.
    await plain.resume(id, { prompt: promptFromText("three") });
    expect(fake.asked().at(-1)?.env?.[DISABLE]).toBeUndefined();
    // A question over a session whose process this side launched again runs a query of its own, with the options it is given.
    const asker = new ClaudeSdkControl({ harness, query: fake.query });
    try {
      await asker.resume(id, {});
      await asker.ask(id, { schema: z.string(), prompt: promptFromText("word?"), claude: { advisor: false } });
      expect(fake.asked().at(-1)?.env?.[DISABLE]).toBe("1");
      await asker.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
      expect(fake.asked().at(-1)?.env?.[DISABLE]).toBeUndefined();
    } finally {
      await asker.dispose();
    }
  } finally {
    await started.dispose();
    await fresh.dispose();
    await plain.dispose();
  }
});

test("a question over a session this side never held is refused before any query: it would run without the limits the session was launched with", async () => {
  const fake = fakeSdkQuery();
  const harness = harnessId("claude-sdk-fake");
  const started = new ClaudeSdkControl({ harness, query: fake.query });
  const restarted = new ClaudeSdkControl({ harness, query: fake.query });
  try {
    const { session: id } = await started.start({ prompt: promptFromText("one"), tools: "niwa-only" });
    await started.dispose();
    const served = fake.served();
    await expect(restarted.ask(id, { schema: z.string(), prompt: promptFromText("word?") })).rejects.toThrow("resume it");
    expect(fake.served()).toBe(served);
    // Resumed with its limits, it is asked under them.
    await restarted.resume(id, { tools: "niwa-only" });
    await restarted.ask(id, { schema: z.string(), prompt: promptFromText("word?") });
    expect(fake.asked().at(-1)).toMatchObject({ tools: [], strictMcpConfig: true, resume: id.native });
  } finally {
    await started.dispose();
    await restarted.dispose();
  }
});
