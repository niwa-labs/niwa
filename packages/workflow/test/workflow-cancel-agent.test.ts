// A cancelled run leaves nothing for the owner to decide.
//
// `workflow.cancel` interrupts the sessions of the run, so the agent turn in flight fails. That
// failure is a consequence of the cancel: the invocation ends, and no retry/skip/cancel question
// is put to the owner for a run the owner has just cancelled.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionControl, SessionId } from "@niwa-labs/harness";
import { requestOpen } from "@niwa-labs/requests/records";
import { createNiwa, requests, eventually, tempHome, sessions } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCancel, workflowStart } from "../src/index.ts";

const HARNESS = harnessId("fake-harness");

/** A control side whose turn lasts until it is interrupted, and then fails. */
class InterruptibleControl implements SessionControl {
  asking = false;
  private fail: ((error: Error) => void) | undefined;

  async start(): Promise<{ session: SessionId }> {
    return { session: sessionId(HARNESS, "session-1") };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {
    this.fail?.(new Error("the turn was interrupted"));
  }

  async ask<T>(): Promise<{ session: SessionId; value: T; at: never }> {
    this.asking = true;
    return await new Promise((_, reject) => {
      this.fail = reject;
    });
  }

  async *life(): AsyncIterable<never> {
    // The session stays alive until the test ends.
    await new Promise<never>(() => {});
  }

  async state(): Promise<"running" | "idle" | "unknown"> {
    return "unknown";
  }
}

/** The harness the fake side serves; one that cannot answer natively asks through a request to the session. */
const instanceOf = (structuredOutput: boolean): Harness => ({
  id: HARNESS,
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    reading: { list: true, read: true, watch: false },
    control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput, launch: { model: false, effort: [], modes: [] } },
  },
});

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const recordsOf = async (niwa: Host): Promise<StoredRecord[]> => niwa.records.read();

/** Cancel a run in the middle of an agent turn, and see what is left for the owner. */
async function cancelledMidTurn(structuredOutput: boolean): Promise<void> {
  const home = await tempHome();
  homes.push(home);
  const control = new InterruptibleControl();
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests());
  niwa.use(sessions({ harnesses: [{ instance: instanceOf(structuredOutput), control }], niwaMcp: { command: "niwa", args: ["mcp"] } }));
  niwa.use(workflow({ harnesses: [HARNESS] }));
  await niwa.serve();
  hosts.push(niwa);

  const file = join(home.path, "script.js");
  await writeFile(file, `export default workflow({ output: z.json() }, async () => { return await agent("Work.", { harness: "fake-harness" }); });`);
  const { run } = await niwa.call(workflowStart, { file });
  // A harness that answers natively is in its turn; one that does not has asked the session through a request.
  await eventually(
    async () => (structuredOutput ? control.asking : (await niwa.call(requestOpen, {})).requests.length === 1),
    10_000,
    "the agent turn should be in flight",
  );

  await niwa.call(workflowCancel, { run });
  // The turn fails because of the cancel; give its failure the time to reach the invocation.
  await eventually(
    async () => (await recordsOf(niwa)).some((row) => row.type === "workflow.run.finished"),
    10_000,
    "the cancelled run should finish",
  );
  await Bun.sleep(250);

  const records = await recordsOf(niwa);
  const finished = records.filter((row) => row.type === "workflow.run.finished");
  expect(finished.map((row) => (row.data as { outcome: { status: string } }).outcome.status)).toEqual(["cancelled"]);
  expect(records.filter((row) => row.type === "workflow.run.paused")).toEqual([]);
  const states = records.filter((row) => row.type === "niwa.invocation.state").map((row) => (row.data as { state: string }).state);
  expect(states).not.toContain("paused");
  expect((await niwa.call(requestOpen, {})).requests).toEqual([]);
}

test("cancelling a run in the middle of an agent turn leaves no pause and no question", () => cancelledMidTurn(true), 30_000);

test("cancelling a run that waits for a session to answer through a request leaves no pause and no question", () => cancelledMidTurn(false), 30_000);

test("cancelling a run that asks the owner a question withdraws the question", async () => {
  const home = await tempHome();
  homes.push(home);
  const niwa = createNiwa({ home: home.path });
  niwa.use(requests());
  niwa.use(workflow());
  await niwa.serve();
  hosts.push(niwa);

  const file = join(home.path, "ask.js");
  await writeFile(file, `export default workflow({ output: z.json() }, async () => { return await ask.confirm("Go on?"); });`);
  const { run } = await niwa.call(workflowStart, { file });
  await eventually(async () => (await niwa.call(requestOpen, {})).requests.length === 1, 10_000, "the owner should be asked");

  await niwa.call(workflowCancel, { run });
  expect((await niwa.call(requestOpen, {})).requests).toEqual([]);
}, 30_000);
