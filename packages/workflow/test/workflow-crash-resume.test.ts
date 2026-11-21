// Workflow resume: a script runs agents in parallel in two harnesses and the host is killed midway.
// After the resume the finished calls are not repeated and the result is complete.
//
// The scenario runs against a real host process (test/fixtures/crash-host.ts):
//
//   1. spawn the host, which installs the workflow plugin with a stub agent; start the script
//   2. the two branches of the script reach the gated agent call; the host is killed there
//   3. spawn the host again, open the gate: the run is resumed
//   4. the calls that already finished are not repeated, and the result of the run is complete
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/crash-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/crash-script.js", import.meta.url));

/** What the workflow actions answer. */
const RunOutput = z.object({
  run: z.string(),
  finished: z.boolean(),
  result: z.unknown().optional(),
});

/** The result the script returns: the two reports. */
const ScriptResult = z.object({
  reports: z.array(z.object({ answer: z.string() })),
});

/** The data of a record of the type that says a run finished. */
function finishedResult(record: StoredRecord): unknown {
  if (record.type !== "workflow.run.finished") return undefined;
  return (record.data as { outcome?: { result?: unknown } }).outcome?.result;
}

test("Workflow resume: the finished calls are not repeated and the result is complete", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The host, and the script that runs two agents in parallel.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();
    const client = await connectAsOwner(homePath);

    const started = RunOutput.parse(
      await client.call("workflow.start" as never, { file: SCRIPT } as never),
    );
    expect(started.run).toBeTruthy();

    // 2. Both branches reach the gated call: they are in flight at the same time.
    await eventually(
      () => counter(homePath, "crash.agent").count() === 2,
      20_000,
      "both branches should have reached the agent call",
    );

    // One branch finishes: its gate is opened and its answer is committed to the journal. The
    // counter only says the action returned, so the journal is what is waited for.
    const early = await connectAsOwner(homePath);
    const outcomes: StoredRecord[] = [];
    const reading = (async () => {
      for await (const record of early.records.since()) outcomes.push(record);
    })().catch(() => undefined);
    gate(homePath, "crash.gate.crash.one").open();
    await eventually(
      () =>
        outcomes.some(
          (record) =>
            record.type === "niwa.step.outcome" &&
            // The hold of the grant on a call is a step of its own: it is not the call.
            !(record.data as { key: string }).key.endsWith("~auth") &&
            (record.data as { outcome?: { status?: string } }).outcome?.status === "completed",
        ),
      20_000,
      "the first branch should have finished and be in the journal",
    );
    await early.close().catch(() => {});
    await reading;

    // The host is killed in the middle: a real crash, with the other branch still in flight.
    await first.kill();
    first = undefined;
    await client.close().catch(() => {});

    // 3. The host comes back and the gate of the second branch opens: the run is resumed.
    second = spawnHost(HOST_SCRIPT, homePath);
    gate(homePath, "crash.gate.crash.two").open();
    await second.ready();

    const watcher = await connectAsOwner(homePath);
    const records: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of watcher.records.since()) {
        records.push(record);
      }
    })().catch(() => undefined);

    // The run ends with its result.
    await eventually(
      () => records.some((record) => finishedResult(record) !== undefined),
      30_000,
      "the resumed run should have finished",
    );

    // 4. The result is complete: both branches answered.
    const finished = records.find((record) => finishedResult(record) !== undefined);
    const result = ScriptResult.parse(finishedResult(finished as StoredRecord));
    expect(result.reports.length).toBe(2);
    // The results are in the order of the branches, whichever finished first.
    expect(result.reports.map((report) => report.answer)).toEqual([
      "answered: Study the core.",
      "answered: Study the state.",
    ]);
    expect(records.filter((record) => finishedResult(record) !== undefined).length).toBe(1);

    // The finished call is not repeated: it was called once before the crash and the resumed
    // run took its answer from the journal. Only the branch that was in flight ran again.
    expect(counter(homePath, "crash.crash.one").count()).toBe(1);
    expect(counter(homePath, "crash.crash.two").count()).toBe(1);
    expect(counter(homePath, "crash.agent").count()).toBe(3);

    await watcher.close().catch(() => {});
    await watch;

    // No child of the script is left behind, neither the one orphaned by the crash nor the new one.
    const left = Bun.spawnSync(["pgrep", "-f", "child.ts.*crash-script.js"]);
    expect(left.stdout.toString().trim()).toBe("");
  } finally {
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 90_000);
