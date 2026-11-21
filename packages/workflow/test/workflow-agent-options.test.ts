// An agent() call may carry the options block of its harness's kind: the block crosses the script's
// process, the request to the host, the agent action and session.start, and arrives at the control
// side. A block of another kind, or a field the block does not have, fails the call before a session
// starts: the agent action of the harness takes the block of the kind the sessions module binds it to,
// and no other. The run's own check (workflow.check) knows each harness's block from the same place.

import { expect, test } from "bun:test";
import { z } from "zod";

import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { harnessId, kindOptions, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, KindOptions, SessionControl, SessionId, StartOptions, StartedSession } from "@niwa-labs/harness";
import { createNiwa, sessions, tempDirSync, watch } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


const HARNESS = harnessId("claude-sonnet");
/** The block of the Claude kinds, as their package declares it. */
const CLAUDE = kindOptions("claude", z.strictObject({ advisor: z.boolean().optional() }));

/** A control side that keeps what each session was started with and answers every question. */
class RecordingControl implements SessionControl {
  readonly starts: StartOptions[] = [];

  async start(options: StartOptions): Promise<StartedSession> {
    this.starts.push(options);
    return { session: sessionId(HARNESS, `session-${String(this.starts.length)}`) };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId): Promise<{ session: SessionId; value: T; at: never }> {
    return { session: id, value: { answer: "ok" } as T, at: 0 as never };
  }

  async *life(): AsyncIterable<never> {}

  async state(): Promise<"unknown"> {
    return "unknown";
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: "claude-code" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    control: {
      start: true,
      resume: false,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: true,
      launch: { model: false, effort: [], modes: [] },
    },
  },
};

/** Runs a script on a host over the recording control side, until `done` holds of what the journal has seen. */
async function run(
  script: string,
  done: (seen: string) => boolean,
  binding: { options?: KindOptions } = { options: CLAUDE },
): Promise<{ control: RecordingControl; seen: string }> {
  const control = new RecordingControl();
  const home = tempDirSync("agent-options");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance, control, ...binding }] }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();
  try {
    const file = join(home, "script.js");
    await Bun.write(file, script);
    await niwa.call("workflow.start" as ActionName, { file } as never);
    const observer = await watch(home);
    for (let waited = 0; waited < 10_000 && !done(JSON.stringify(observer.seen)); waited += 100) await Bun.sleep(100);
    await observer.stop();
    return { control, seen: JSON.stringify(observer.seen) };
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("the block of the harness's kind in an agent() call reaches the control side; a call without one carries none", async () => {
  const { control } = await run(
    [
      "export default workflow({ output: z.json() }, async () => {",
      '  await agent("tuned", { harness: "claude-sonnet", claude: { advisor: false } });',
      '  await agent("plain", { harness: "claude-sonnet" });',
      "  return null;",
      "});",
      "",
    ].join("\n"),
    (seen) => seen.includes("workflow.run.finished"),
  );

  expect(control.starts.map((start) => start.blocks?.claude)).toEqual([{ advisor: false }, undefined]);
  expect(Object.keys(control.starts[1] ?? {})).not.toContain("blocks");
}, 30_000);

test("stuckAfter of an agent() call is kept in the record of the session it starts, in milliseconds", async () => {
  const { seen } = await run(
    [
      "export default workflow({ output: z.json() }, async () => {",
      '  await agent("watched", { harness: "claude-sonnet", stuckAfter: "10m" });',
      '  await agent("unwatched", { harness: "claude-sonnet" });',
      "  return null;",
      "});",
      "",
    ].join("\n"),
    (seen) => seen.includes("workflow.run.finished"),
  );
  const started = (JSON.parse(seen) as Array<{ type: string; data: { stuckAfter?: number } }>).filter((row) => row.type === "session.started");
  expect(started.map((row) => row.data.stuckAfter)).toEqual([600_000, undefined]);
}, 30_000);

test("the block of another kind fails the call before a session starts, and so does a field the block does not have", async () => {
  const { control, seen } = await run(
    [
      "export default workflow({ output: z.json() }, async () => {",
      '  await agent("foreign", { harness: "claude-sonnet", codex: {} });',
      "  return null;",
      "});",
      "",
    ].join("\n"),
    (seen) => seen.includes("options block only"),
  );
  expect(seen).toContain('the harness \\"claude-sonnet\\" takes the \\"claude\\" options block only (asked for \\"codex\\")');
  expect(control.starts).toEqual([]);

  const typo = await run(
    [
      "export default workflow({ output: z.json() }, async () => {",
      '  await agent("typo", { harness: "claude-sonnet", claude: { advisor: false, advisr: true } });',
      "  return null;",
      "});",
      "",
    ].join("\n"),
    (seen) => seen.includes("advisr"),
  );
  expect(typo.seen).toContain("advisr");
  expect(typo.control.starts).toEqual([]);
}, 60_000);

test("a harness the sessions module binds to no options block takes no block", async () => {
  const { control, seen } = await run(
    [
      "export default workflow({ output: z.json() }, async () => {",
      '  await agent("bare", { harness: "claude-sonnet", claude: { advisor: false } });',
      "  return null;",
      "});",
      "",
    ].join("\n"),
    (seen) => seen.includes("takes no options"),
    {},
  );
  expect(seen).toContain('the harness \\"claude-sonnet\\" takes no options (asked for \\"claude\\")');
  expect(control.starts).toEqual([]);
}, 30_000);
