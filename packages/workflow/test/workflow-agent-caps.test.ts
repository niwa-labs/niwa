// The ceiling of a harness holds for a run's agent calls too: under a ceiling of one, two calls of
// a parallel are answered one after the other.

import { expect, test } from "bun:test";

import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId } from "@niwa-labs/harness";
import { createNiwa, sessions, eventually, tempDirSync } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";

const HARNESS = harnessId("fake-harness");

/** A side whose asks wait until the test answers them, and that counts the asks it holds at once. */
class HeldAsks implements SessionControl {
  readonly waiting: Array<() => void> = [];
  most = 0;
  private counter = 0;
  async start(): Promise<{ session: SessionId }> {
    this.counter += 1;
    return { session: sessionId(HARNESS, `session-${String(this.counter)}`) };
  }
  async resume(): Promise<void> {}
  async send() {
    return { status: "started" as const, turn: 1 };
  }
  async interrupt(): Promise<void> {}
  async ask<T>(id: SessionId): Promise<{ session: SessionId; value: T; at: never }> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.most = Math.max(this.most, this.waiting.length);
    });
    return { session: id, value: { answer: String(id.native) } as T, at: 0 as never };
  }
  /** Answers the oldest ask that waits. */
  answer(): void {
    this.waiting.shift()?.();
  }
  async *life(): AsyncIterable<never> {
    await new Promise<never>(() => {});
  }
  async state(): Promise<"running" | "idle" | "unknown"> {
    return "idle";
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: "fake-kind" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    control: { start: true, resume: true, send: true, interrupt: false, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } },
  },
};

test("two agent calls of a parallel under a ceiling of one are asked one after the other", async () => {
  const control = new HeldAsks();
  const home = tempDirSync("agent-caps");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance, control }], caps: { [HARNESS]: 1 } }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();
  try {
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  return await parallel([() => agent("one", { harness: "fake-harness" }), () => agent("two", { harness: "fake-harness" })]);',
        "});",
        "",
      ].join("\n"),
    );
    await niwa.call("workflow.start" as ActionName, { file: script } as never);
    await eventually(() => control.waiting.length === 1, 10_000, "the first ask should be made");
    await Bun.sleep(300);
    expect(control.waiting).toHaveLength(1);
    control.answer();
    await eventually(() => control.waiting.length === 1, 10_000, "the second ask should be made once the first is answered");
    control.answer();
    await eventually(async () => (await niwa.records.read()).some((row) => row.type === "workflow.run.finished"), 10_000, "the run should finish");
    expect(control.most).toBe(1);
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
