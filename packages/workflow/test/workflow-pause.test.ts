// A failure pauses the run with a request, and the owner
// answers that request with one of the choices the pause offers.
//
// The scenario runs against a real host process (test/fixtures/revision-host.ts), which installs the
// requests module next to the workflow:
//
//   1. the script makes one call that finishes and one that fails: the run pauses
//   2. the pause is on the owner's list of open requests, with the choices retry, skip, cancel
//   3. the owner answers "skip": the run goes on without the failed call, and finishes
//   4. the owner answers "cancel": the run ends there, and the failed call is never made
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { REQUEST_OPEN } from "@niwa-labs/requests/records";
import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/revision-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/revision-script.js", import.meta.url));
const RESOLVE = "niwa.invocation.resolve" as ActionName;

/** What the workflow actions answer. */
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

/** The list of what waits: the open requests and the invocations paused for a decision. */
const Listed = z.object({ requests: z.array(z.record(z.string(), z.unknown())) });

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

/** The paused invocations on the owner's list of what waits. */
function pausedEntries(listed: z.infer<typeof Listed>): Array<Record<string, unknown>> {
  return listed.requests.filter((entry) => entry.kind === "paused");
}

/** The records of one type, as the observer saw them. */
function ofType(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

test("rq-4: a failed call pauses the run, and the pause is a request the owner answers", async () => {
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

    // 1. The script runs: the first call finishes, the second fails and the run pauses.
    const started = RunOutput.parse(
      await client.call("workflow.start" as never, { file: SCRIPT } as never),
    );

    await eventually(
      () => statesOf(seen).some((state) => state.state === "paused"),
      20_000,
      "the run should have paused",
    );
    const pause = statesOf(seen).find((state) => state.state === "paused");
    if (pause === undefined) throw new Error("the run did not pause");

    // The pause offers the choices of the core.
    expect(pause.choices).toEqual(["retry", "skip", "cancel"]);
    // It paused on the step of the call that failed.
    expect(pause.key).toBe("label:work:second");
    // The first call finished; the second failed.
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // The run says it paused, and it is the run that was started.
    const runPaused = ofType(seen, "workflow.run.paused")[0];
    expect((runPaused?.data as { run?: string }).run).toBe(started.run);

    // 2. The pause is on the owner's list of open requests, and it is the only thing there.
    const listed = Listed.parse(await client.call(REQUEST_OPEN, {}));
    const paused = pausedEntries(listed);
    expect(paused).toHaveLength(1);
    expect(paused[0]?.invocation).toBe(pause.invocation);
    expect(paused[0]?.choices).toEqual(["retry", "skip", "cancel"]);

    // 3. The owner answers "skip": the run goes on without the failed call.
    await client.call(RESOLVE, { invocation: pause.invocation, choice: "skip" });

    await eventually(
      () => ofType(seen, "workflow.run.finished").length > 0,
      30_000,
      "the run should have finished after the skip",
    );
    const finished = ofType(seen, "workflow.run.finished")[0];
    expect((finished?.data as { run?: string }).run).toBe(started.run);
    // The first call has its answer; the skipped one has none, and the script goes on.
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      first: { answer: "answered: Study the core." },
      second: null,
    });

    // The invocation ends as done after its handler returns, so its state follows the record of
    // the finished run. The test waits for that state instead of reading it at once.
    await eventually(
      () => lastStateOf(seen, pause.invocation)?.state === "done",
      20_000,
      "the invocation should have ended as done after the skip",
    );

    // The failed call was not made again, and the run is not paused any more.
    expect(counter(homePath, "revision.agent").count()).toBe(2);
    expect(pausedEntries(Listed.parse(await client.call(REQUEST_OPEN, {})))).toHaveLength(0);

    await client.close().catch(() => {});
  } finally {
    await observed?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("rq-4: the owner cancels the paused run, and it ends there", async () => {
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

    // The script runs and pauses on the call that failed.
    await client.call("workflow.start" as never, { file: SCRIPT } as never);
    await eventually(
      () => statesOf(seen).some((state) => state.state === "paused"),
      20_000,
      "the run should have paused",
    );
    const pause = statesOf(seen).find((state) => state.state === "paused");
    if (pause === undefined) throw new Error("the run did not pause");
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // The owner answers "cancel": the run ends, and the failed call is never made.
    await client.call(RESOLVE, { invocation: pause.invocation, choice: "cancel" });

    await eventually(
      () => lastStateOf(seen, pause.invocation)?.state === "done",
      20_000,
      "the run should have ended after the cancel",
    );
    expect(lastStateOf(seen, pause.invocation)?.reason).toBe("cancelled");
    expect(ofType(seen, "workflow.run.finished")).toHaveLength(0);
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // The pause is not on the list of what waits any more.
    expect(pausedEntries(Listed.parse(await client.call(REQUEST_OPEN, {})))).toHaveLength(0);

    await client.close().catch(() => {});
  } finally {
    await observed?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
