// The session of an agent call sees the action that answers a question.
//
// The agent action of a workflow starts a session and asks it. A harness that cannot answer by
// itself answers through `submit-answer`, and a session that does not see that action can never
// answer at all: the session of an agent call must see it.
//
// The scenario runs against a fake control side: the script names a harness, and the session
// that the harness starts is asked.

import { expect, test } from "bun:test";

import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId, StartOptions } from "@niwa-labs/harness";
import { SUBMIT_ANSWER_ACTION } from "@niwa-labs/sessions/records";
import { createNiwa, sessions, tempDirSync, watch } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";


/** The harness the script names. */
const HARNESS = harnessId("fake-harness");

/**
 * The fake control side: it starts sessions and answers them.
 *
 * It cannot answer natively, so the session of an agent call answers through the request.
 */
class FakeControl implements SessionControl {
  readonly starts: StartOptions[] = [];
  private counter = 0;

  async start(options: StartOptions): Promise<{ session: SessionId }> {
    this.starts.push(options);
    this.counter += 1;
    return { session: { harness: HARNESS, native: `session-${this.counter}` as never } };
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

  async ask<T>(): Promise<{ session: SessionId; value: T; at: never }> {
    throw new Error("this harness cannot answer natively");
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
      structuredOutput: false, launch: { model: false, effort: [], modes: [] },
    },
  },
};

test("the session of an agent call sees the action that answers a question", async () => {
  const control = new FakeControl();
  const home = tempDirSync("session-sees-answer");
  const niwa = createNiwa({ home });
  niwa.use(
    sessions({
      harnesses: [{ instance: fakeInstance, control }],
      // The harness cannot answer natively, so the session answers through the niwa server.
      niwaMcp: { command: "bun", args: ["bin/niwa.ts", "mcp"] },
    }),
  );
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();

  try {
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

    const observer = await watch(home);
    await Bun.sleep(1500);

    // The session was started, and it sees the action that answers a question.
    expect(control.starts.length).toBe(1);
    expect(control.starts[0]?.visible?.actions).toContain(SUBMIT_ANSWER_ACTION);

    // The steps of the agent call name the actions of the sessions module, as old journals do.
    const intents = observer.seen
      .filter((record) => record.type === "niwa.step.intent")
      .map((record) => (record.data as { action?: string }).action);
    expect(intents).toContain("session.start");
    expect(intents).toContain("session.ask");

    await observer.stop();
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
