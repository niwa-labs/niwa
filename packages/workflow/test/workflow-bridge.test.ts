// The script is a client of niwa: it calls any action, waits for a record,
// and a restart of the host does not repeat what finished.
//
// The scenarios run against real host processes (test/fixtures/bridge-host.ts) that are killed.
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/bridge-host.ts", import.meta.url));

const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

function ofType(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

/** The state of the latest invocation of the workflow handler, as the journal holds it. */
function stateOfRun(seen: StoredRecord[]): string | undefined {
  let state: string | undefined;
  for (const record of ofType(seen, "niwa.invocation.state")) {
    const data = record.data as { invocation: string; state: string };
    if (data.invocation.startsWith("inv:workflow/")) state = data.state;
  }
  return state;
}

test("W1a a script calls an action and waits for a record; a restart repeats neither", async () => {
  const home = await tempHome();
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let observed: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    first = spawnHost(HOST_SCRIPT, home.path);
    await first.ready();
    const client = await connectAsOwner(home.path);
    observed = await watch(home.path);
    const seen = observed.seen;

    RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: fileURLToPath(new URL("./fixtures/bridge-wait-script.js", import.meta.url)) } as never),
    );
    await eventually(() => counter(home.path, "w1.create").count() === 1, 20_000, "the thing should be made");
    await eventually(() => stateOfRun(seen) === "waiting", 20_000, "the run should wait for the record");
    expect(ofType(seen, "timer.sleep.requested")).toHaveLength(1);

    // The host dies while the script waits.
    await first.kill();
    first = undefined;
    await client.close().catch(() => {});

    second = spawnHost(HOST_SCRIPT, home.path);
    await second.ready();
    const again = await connectAsOwner(home.path);
    await eventually(() => stateOfRun(seen) === "waiting", 20_000, "the run should keep waiting");
    expect(ofType(seen, "workflow.run.finished")).toHaveLength(0);

    await again.call("stub.finish" as ActionName, { id: "t-lockfile" } as never);
    await eventually(() => ofType(seen, "workflow.run.finished").length > 0, 30_000, "the run should finish");

    const finished = ofType(seen, "workflow.run.finished")[0];
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      made: { id: "t-lockfile" },
      done: { id: "t-lockfile" },
    });
    // The thing was made once, and the wake of the timeout was asked for once.
    expect(counter(home.path, "w1.create").count()).toBe(1);
    expect(ofType(seen, "timer.sleep.requested")).toHaveLength(1);
    await again.close().catch(() => {});
  } finally {
    await observed?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 90_000);

test("W1c calls that arrive in another order on a replay keep their results", async () => {
  const home = await tempHome();
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let observed: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    first = spawnHost(HOST_SCRIPT, home.path);
    await first.ready();
    const client = await connectAsOwner(home.path);
    observed = await watch(home.path);
    const seen = observed.seen;

    RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: fileURLToPath(new URL("./fixtures/bridge-keys-script.js", import.meta.url)) } as never),
    );
    await eventually(
      () => counter(home.path, "w1.hold.a").count() === 1 && counter(home.path, "w1.hold.b").count() === 1,
      20_000,
      "both branches should have called",
    );
    // The second branch answers first, and reads a random number. The first is still in flight.
    gate(home.path, "w1.hold.b").open();
    await eventually(
      () => ofType(seen, "niwa.step.outcome").some((record) => (record.data as { key: string }).key === "p1.1.call-2"),
      20_000,
      "the second branch should have read its random number",
    );
    const recorded = ofType(seen, "niwa.step.outcome").find(
      (record) => (record.data as { key: string }).key === "p1.1.call-2",
    );
    const dice = (recorded?.data as { outcome: { value: number } }).outcome.value;

    await first.kill();
    first = undefined;
    await client.close().catch(() => {});

    // On the replay the second branch is answered from the journal at once, before the first.
    second = spawnHost(HOST_SCRIPT, home.path);
    await second.ready();
    gate(home.path, "w1.hold.a").open();
    await eventually(() => ofType(seen, "workflow.run.finished").length > 0, 30_000, "the run should finish");

    const result = (ofType(seen, "workflow.run.finished")[0]?.data as { outcome: { result: Array<Record<string, unknown>> } }).outcome.result;
    expect(result[0]?.held).toEqual({ name: "a" });
    expect(result[1]).toEqual({ held: { name: "b" }, dice });
    // The call that finished was not made again; the one in flight was.
    expect(counter(home.path, "w1.hold.b").count()).toBe(1);
    expect(counter(home.path, "w1.hold.a").count()).toBe(2);
    // The clock and the random number were read once each.
    const keys = ofType(seen, "niwa.step.intent").map((record) => (record.data as { key: string }).key);
    expect(keys.filter((key) => key === "p1.1.call-2")).toHaveLength(1);
    expect(keys.filter((key) => key === "p1.0.call-2")).toHaveLength(1);
  } finally {
    await observed?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 90_000);
