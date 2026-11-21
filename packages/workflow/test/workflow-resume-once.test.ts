// A run is not started twice at once.
//
// A resume or a revision starts another invocation of the run's handler. While the invocation
// that is going has not ended, the two would write over the same children of the run, so the
// resume is refused.
//
// The scenario runs against a real host process (test/fixtures/running-host.ts):
//
//   1. the script makes a call that waits: the run is still going
//   2. the owner resumes the run: it is refused
//   3. the owner revises the run: it is refused too
//   4. a run that paused is resolved as part of the resume, and one new run starts
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/running-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/running-script.js", import.meta.url));

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

/** The records of one type, as the observer saw them. */
function ofType(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

test("a run that is still going is not resumed or revised", async () => {
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

    // 1. The script runs: the first call is made and waits, so the run is still going.
    const started = RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: SCRIPT } as never),
    );
    await eventually(
      () => counter(homePath, "running.agent").count() === 1,
      20_000,
      "the first call should have been made",
    );

    // The run is going: its invocation is running.
    await eventually(
      () => statesOf(seen).some((state) => state.state === "running"),
      20_000,
      "the invocation of the run should be running",
    );

    // 2. The owner resumes the run: it is refused, and nothing runs.
    await expect(
      client.call("workflow.resume" as ActionName, { run: started.run } as never),
    ).rejects.toThrow("still going");

    // 3. The owner revises the run: it is refused too.
    await expect(
      client.call("workflow.revise" as ActionName, { run: started.run, file: SCRIPT } as never),
    ).rejects.toThrow("still going");

    // No second run was started, and no call was made twice.
    expect(ofType(seen, "workflow.run.started")).toHaveLength(1);
    expect(counter(homePath, "running.agent").count()).toBe(1);

    await client.close().catch(() => {});
  } finally {
    await observed?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a paused run is resolved as part of the resume, and one new run starts", async () => {
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

    // The script runs: its first call fails, so the run pauses.
    const script = `${homePath}/running-pausing.js`;
    await Bun.write(
      script,
      [
        "export default workflow({ output: z.json() }, async () => {",
        '  const answer = await ask({ label: "work:first" }, "This one will fail.");',
        "  return answer;",
        "});",
        "",
      ].join("\n"),
    );
    const started = RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: script } as never),
    );

    await eventually(
      () => statesOf(seen).some((state) => state.state === "paused"),
      20_000,
      "the run should have paused",
    );

    // The resume resolves the pause with a cancel, and starts one new run.
    const resumed = RunOutput.parse(
      await client.call("workflow.resume" as ActionName, { run: started.run } as never),
    );
    expect(resumed.run).toBe(started.run);

    await eventually(
      () => ofType(seen, "workflow.run.started").length === 2,
      20_000,
      "the resume should have started one new run",
    );

    // The old invocation was resolved: it is done, and the run has one new invocation.
    const invocations = ofType(seen, "niwa.invocation.admitted").map(
      (record) => (record.data as { invocation?: string }).invocation ?? "",
    );
    expect(invocations.length).toBe(2);
    const states = invocations.map(
      (invocation) => statesOf(seen).filter((s) => s.invocation === invocation).at(-1)?.state,
    );
    // The old invocation was resolved by the resume: it is over.
    expect(states[0]).toBe("done");
    // The new invocation is the one that goes on: it is running or paused, not done.
    expect(states[1]).not.toBe("done");

    // The resolution of the old invocation was written: the pause was answered with a cancel.
    const resolutions = ofType(seen, "niwa.invocation.resolved");
    expect(resolutions.length).toBe(1);
    expect((resolutions[0]?.data as { choice?: string }).choice).toBe("cancel");

    await client.close().catch(() => {});
  } finally {
    await observed?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
