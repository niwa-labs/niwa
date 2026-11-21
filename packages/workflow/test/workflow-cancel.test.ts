// A cancelled run stops its child process.
//
// A cancel stops the child process of the run, and the run ends there: the invocation ends
// cancelled, and no call of the script is made after the cancel.
//
// The scenario runs against a real host process (test/fixtures/cancel-host.ts):
//
//   1. the script makes a long call: the run is parked inside it
//   2. the owner cancels the run: the child process of the run is gone
//   3. the invocation ends as done, with the reason "cancelled"
//   4. no further call of the script was made
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/cancel-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/cancel-script.js", import.meta.url));

/** What the workflow actions answer. */
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

/** The state of an invocation, as the journal holds it. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
  key: z.string().optional(),
});

/** The states of the invocations, in the order they happened. */
function statesOf(seen: StoredRecord[]): Array<z.infer<typeof InvocationState>> {
  const states: Array<z.infer<typeof InvocationState>> = [];
  for (const record of seen) {
    if (record.type !== "niwa.invocation.state") continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success) states.push(parsed.data);
  }
  return states;
}

/** The last state of an invocation. */
function lastStateOf(
  seen: StoredRecord[],
  invocation: string,
): z.infer<typeof InvocationState> | undefined {
  let last: z.infer<typeof InvocationState> | undefined;
  for (const state of statesOf(seen)) {
    if (state.invocation === invocation) last = state;
  }
  return last;
}

/** The records of one type, as the observer saw them. */
function ofType(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

/** Is a process with this pid still there? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The child processes of a process, by their parent pid. */
function childPids(parentPid: number): number[] {
  const pids: number[] = [];
  const listing = Bun.spawnSync(["ps", "ax", "-o", "pid=,ppid="]).stdout.toString();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/);
    if (ppid !== String(parentPid)) continue;
    const parsed = Number(pid);
    if (Number.isInteger(parsed) && parsed > 0) pids.push(parsed);
  }
  return pids;
}

test("a cancelled run stops its child process, and no call is made after it", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let observed: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);
    observed = await watch(homePath);
    const seen = observed.seen;

    // 1. The script runs: the long call is made, and the run waits for its answer.
    const started = RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: SCRIPT } as never),
    );

    await eventually(
      () => counter(homePath, "cancel.agent").count() === 1,
      20_000,
      "the long call should have been made",
    );

    // The child process of the run is there: the script is running in it.
    const children = childPids(host.pid);
    expect(children.length).toBeGreaterThan(0);
    const childPid = children[0] as number;
    expect(alive(childPid)).toBe(true);

    // 2. The owner cancels the run.
    await client.call("workflow.cancel" as ActionName, { run: started.run } as never);

    // 3. The child process of the run is gone: the cancel stopped it.
    await eventually(
      () => !alive(childPid),
      20_000,
      "the child process of the cancelled run should be gone",
    );

    // 4. The run ended as cancelled, and the invocation of the run ended with it.
    const finished = ofType(seen, "workflow.run.finished")[0];
    expect((finished?.data as { run?: string; cancelled?: boolean }).run).toBe(started.run);
    expect((finished?.data as { outcome?: { status?: string } }).outcome?.status).toBe("cancelled");

    await eventually(
      () => {
        const invocation = (seen.find((record) => record.type === "niwa.invocation.admitted")?.data as
          | { invocation?: string }
          | undefined)?.invocation;
        if (invocation === undefined) return false;
        return lastStateOf(seen, invocation)?.state === "done";
      },
      20_000,
      "the invocation of the cancelled run should have ended",
    );
    const invocation = (seen.find((record) => record.type === "niwa.invocation.admitted")?.data as
      | { invocation?: string }
      | undefined)?.invocation;
    // The invocation of the run ended: it is done, and it did not pause on the call that was cut
    // off.
    expect(lastStateOf(seen, invocation ?? "")?.state).toBe("done");
    expect(statesOf(seen).some((state) => state.state === "paused")).toBe(false);

    // 5. No call was made after the cancel: the second call of the script never happened.
    expect(counter(homePath, "cancel.agent").count()).toBe(1);
    const intents = ofType(seen, "niwa.step.intent").filter(
      (record) => (record.data as { action?: string }).action === "cancel.agent",
    );
    expect(intents.length).toBe(1);

    await client.close().catch(() => {});
  } finally {
    await observed?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
