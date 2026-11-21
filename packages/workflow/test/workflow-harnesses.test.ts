// The workflow plugin registers the agent action of every harness it was given.
//
// The workflow module needs no hand glue for a script that names a harness.
//
// The option `harnesses` says which harnesses a script may name. For each of them the plugin
// registers the agent action `session.start.<harness>`, so `session({harness})` works with no hand
// glue.
//
// The scenario runs against a fake control side: the script names a harness, and the session that
// the harness starts answers.

import { expect, test } from "bun:test";

import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId } from "@niwa-labs/harness";
import { createNiwa, sessions, eventually, tempDirSync, watch } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


/** The harness the script names. */
const HARNESS = harnessId("fake-harness");

/** The sessions the fake control side started, in order. */
interface FakeSession {
  readonly id: SessionId;
  readonly prompts: string[];
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly mode: string | undefined;
}

/**
 * The fake control side: it starts sessions and answers them.
 */
class FakeControl implements SessionControl {
  readonly started: FakeSession[] = [];
  private counter = 0;

  async start(options: { prompt: { sections: Array<{ text: string }> }; cwd?: string; model?: string; effort?: string; mode?: string }): Promise<{ session: SessionId }> {
    this.counter += 1;
    const id = { harness: HARNESS, native: `session-${this.counter}` as never };
    this.started.push({
      id,
      prompts: options.prompt.sections.map((section) => section.text),
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      mode: options.mode,
    });
    return { session: id };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {
    // The fake interrupts nothing.
  }

  async ask<T>(id: SessionId, options: { prompt: { sections: Array<{ text: string }> } }): Promise<{
    session: SessionId;
    value: T;
    at: never;
  }> {
    const question = options.prompt.sections.map((section) => section.text).join("\n\n");
    return { session: id, value: { answer: `answered: ${question}` } as T, at: 0 as never };
  }

  async *life(): AsyncIterable<never> {
    // The fake reports no signs of life: the sessions module does not need them here.
  }

  async state(): Promise<"running" | "idle" | "unknown"> {
    return "unknown";
  }
}

/** The installation the fake side serves. */
const fakeInstance: Harness = {
  id: HARNESS,
  kind: "fake-kind" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    reading: { list: true, read: true, watch: false },
    control: {
      start: true,
      resume: false,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: true, launch: { model: true, effort: ["low", "high"], modes: ["ask", "auto"] },
    },
  },
};

test("the workflow registers the agent action of every harness it was given", async () => {
  const control = new FakeControl();
  const home = tempDirSync("harnesses");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance: fakeInstance, control }] }));
  // The host says which harnesses a script may name: nothing else is asked of it.
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  try {
    // 1. The agent action of the harness is registered: it is there with no hand glue.
    const description = await niwa.describe();
    const agentAction = description.actions.find(
      (entry) => entry.name === `session.start.${HARNESS}`,
    );
    expect(agentAction).toBeDefined();

    // 2. A script that names the harness reaches the agents of that harness.
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  const answer = await ask({ harness: "fake-harness" }, "Study the core.");',
        "  return answer;",
        "});",
        "",
      ].join("\n"),
    );

    const started = (await niwa.call("workflow.start" as ActionName, { file: script } as never)) as {
      run: string;
    };
    expect(started.run).toBeDefined();

    // 3. The session was started on that harness, and the script got its answer.
    const observer = await watch(home);
    await eventually(() => observer.seen.some((record) => record.type === "workflow.run.finished"));
    expect(control.started.length).toBe(1);
    expect(control.started[0]?.id.harness).toBe(HARNESS);

    // 4. The run finished with what the session answered.
    const finished = observer.seen.find((record) => record.type === "workflow.run.finished");
    expect(finished).toBeDefined();
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      answer: "answered: Study the core.",
    });

    await observer.stop();
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("an agent call may name the directory its session starts in, and without one the session is given none", async () => {
  const control = new FakeControl();
  const home = tempDirSync("agent-cwd");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance: fakeInstance, control }] }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  try {
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  await ask({ harness: "fake-harness", cwd: "/tmp/the-worktree" }, "in the worktree");',
        '  await ask({ harness: "fake-harness" }, "where the host is");',
        "  return null;",
        "});",
        "",
      ].join("\n"),
    );
    await niwa.call("workflow.start" as ActionName, { file: script } as never);
    const observer = await watch(home);
    for (let waited = 0; waited < 10_000 && control.started.length < 2; waited += 100) await Bun.sleep(100);
    await observer.stop();

    expect(control.started.map((session) => session.cwd)).toEqual(["/tmp/the-worktree", undefined]);
    expect(control.started.map((session) => [session.model, session.effort])).toEqual([[undefined, undefined], [undefined, undefined]]);
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("an agent call may name the model and the effort of its session, and a level the kind does not take fails the call before a session starts", async () => {
  const control = new FakeControl();
  const home = tempDirSync("agent-effort");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance: fakeInstance, control }] }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  try {
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  await ask({ harness: "fake-harness", model: "m-1", effort: "high" }, "tuned");',
        '  await ask({ harness: "fake-harness", effort: "max" }, "too much");',
        "  return null;",
        "});",
        "",
      ].join("\n"),
    );
    await niwa.call("workflow.start" as ActionName, { file: script } as never);
    const observer = await watch(home);
    for (let waited = 0; waited < 10_000 && !JSON.stringify(observer.seen).includes("is not one of"); waited += 100) await Bun.sleep(100);
    await observer.stop();

    expect(control.started.map((session) => [session.model, session.effort])).toEqual([["m-1", "high"]]);
    expect(JSON.stringify(observer.seen)).toContain("is not one of low, high");
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("an agent call may name the mode of its session, and a mode the kind does not have fails the call before a session starts", async () => {
  const control = new FakeControl();
  const home = tempDirSync("agent-mode");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance: fakeInstance, control }] }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  try {
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  await ask({ harness: "fake-harness", mode: "ask" }, "careful");',
        '  await ask({ harness: "fake-harness", mode: "full" }, "unrestricted");',
        "  return null;",
        "});",
        "",
      ].join("\n"),
    );
    await niwa.call("workflow.start" as ActionName, { file: script } as never);
    const observer = await watch(home);
    for (let waited = 0; waited < 10_000 && !JSON.stringify(observer.seen).includes("is not one of"); waited += 100) await Bun.sleep(100);
    await observer.stop();

    expect(control.started.map((session) => session.mode)).toEqual(["ask"]);
    expect(JSON.stringify(observer.seen)).toContain('the mode \\"full\\" is not one of ask, auto');
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
