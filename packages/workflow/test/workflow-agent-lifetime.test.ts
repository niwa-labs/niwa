// One-shot questions release the harness process before returning to the script.

import { expect, test } from "bun:test";

import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId } from "@niwa-labs/harness";
import { createNiwa, sessions, eventually, tempDirSync } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";

const HARNESS = harnessId("fake-harness");

/** A side that answers every ask, and says which sessions it was asked to close. */
class Closing implements SessionControl {
  readonly closed: string[] = [];
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
    return { session: id, value: { answer: `from ${String(id.native)}` } as T, at: 0 as never };
  }
  readonly #gone = new Map<string, () => void>();
  /** A session's signs of life go on until its process is let go. */
  async *life(id: SessionId): AsyncIterable<never> {
    await new Promise<void>((resolve) => this.#gone.set(String(id.native), resolve));
  }
  async state(): Promise<"running" | "idle" | "unknown"> {
    return "idle";
  }
  async close(id: SessionId): Promise<void> {
    this.closed.push(String(id.native));
    this.#gone.get(String(id.native))?.();
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: "fake-kind" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    control: { start: true, resume: true, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } },
  },
};

test("each one-shot question closes its own session before the run finishes", async () => {
  const control = new Closing();
  const home = tempDirSync("agent-lifetime");
  const niwa = createNiwa({ home });
  niwa.use(sessions({ harnesses: [{ instance, control }] }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();
  try {
    const script = join(home, "script.js");
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  const first = await ask({ harness: "fake-harness" }, "one");',
        '  const second = await ask({ harness: "fake-harness" }, "two");',
        "  return [first, second];",
        "});",
        "",
      ].join("\n"),
    );
    await niwa.call("workflow.start" as ActionName, { file: script } as never);
    const ended = async () => (await niwa.records.read()).filter((row) => row.type === "session.ended").map((row) => row.data as { session: string; reason: string });
    await eventually(async () => (await niwa.records.read()).some((row) => row.type === "workflow.run.finished"), 10_000);
    const records = await niwa.records.read();
    const finishedAt = records.find((row) => row.type === "workflow.run.finished")?.seq ?? 0;
    // Neither completed question leaves a harness running while the script continues.
    expect(records.filter((row) => row.type === "session.ended").every((row) => row.seq < finishedAt)).toBe(true);
    expect((await ended()).map((data) => data.session).sort()).toEqual([`${HARNESS} session-1`, `${HARNESS} session-2`]);
    expect((await ended()).every((data) => data.reason === "workflow question finished")).toBe(true);
    // The stream that closes with the process does not write a second end.
    await Bun.sleep(100);
    expect(await ended()).toHaveLength(2);
    expect(control.closed.sort()).toEqual(["session-1", "session-2"]);
  } finally {
    await niwa.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
