// Crash in the middle of a call that must not be repeated.
//
// The scenario runs against a real host process (fixtures/no-repeat-crash-host.ts):
//
//   1. spawn the host, connect a client, emit Start { n }
//   2. the handler calls the action "effect", which blocks on the gate "g1"
//   3. kill the host with SIGKILL — a real crash, in the middle of the call
//   4. spawn the host again: the step has an intent and no outcome
//   5. the invocation is paused, and the pause offers retry, skip, cancel
//   6. the test calls "niwa.invocation.resolve" with "retry": the action is called again
//   7. the same, with "skip": the action is not called again and the code continues
//
// Only the public API is used: the entries of the packages (types) and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import type { ActionName } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, invocationOf, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Start } from "./fixtures/no-repeat-crash-host.ts";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/no-repeat-crash-host.ts", import.meta.url));
const RESOLVE = "niwa.invocation.resolve" as ActionName;

/**
 * Run the crash and the restart, and hand over the second host with the invocation paused.
 * `cleanup` stops everything that was started.
 */
async function pausedAfterCrash() {
  const home = await tempHome();
  const homePath = home.path;
  const hosts: Array<ReturnType<typeof spawnHost>> = [];
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;
  const cleanup = async (): Promise<void> => {
    await watcher?.stop();
    for (const host of hosts) await host.kill().catch(() => {});
    await home.cleanup();
  };

  try {
    // 1. The first host. It is killed in the middle of the call.
    const first = spawnHost(HOST_SCRIPT, homePath);
    hosts.push(first);
    await first.ready();

    const observed = await watch(homePath);
    watcher = observed;
    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 7 });

    // 2. The action is blocked on the gate: it was called, and its outcome is not recorded.
    await eventually(
      () => counter(homePath, "effect").count() >= 1,
      10_000,
      "the effect should have been called once before the crash",
    );

    // 3. A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});

    // 4. The second host resumes the unfinished invocation. The gate is opened right away:
    //    a host that called the action again on its own would let it through.
    const second = spawnHost(HOST_SCRIPT, homePath);
    hosts.push(second);
    gate(homePath, "g1").open();
    await second.ready();

    // 5. The invocation is paused: the call was cut off, and "do-not-repeat" cannot call it
    //    again on its own. The observer of the first host carried over to the second.
    await eventually(
      () => lastState(observed.seen)?.state === "paused",
      15_000,
      "the invocation should have paused",
    );
    return { homePath, seen: observed.seen, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("crash in a call that must not be repeated: the invocation pauses, and retry calls the action again", async () => {
  const run = await pausedAfterCrash();
  try {
    const paused = lastState(run.seen);
    expect(paused?.choices).toEqual(["retry", "skip", "cancel"]);
    expect(paused?.key).toBe("1");

    // The step's outcome is "unknown", and the action was called at most once.
    const outcomes = run.seen.filter((record) => record.type === "niwa.step.outcome");
    expect(outcomes.map((record) => (record.data as { outcome?: { status?: string } }).outcome?.status)).toEqual([
      "unknown",
    ]);
    expect(counter(run.homePath, "effect").count()).toBe(1);

    // The owner chooses retry: the step is called again, and the invocation finishes.
    const client = await connectAsOwner(run.homePath);
    await client.call(RESOLVE, { invocation: invocationOf(run.seen), choice: "retry" });
    await eventually(
      () => lastState(run.seen)?.state === "done",
      15_000,
      "the invocation should have finished after the retry",
    );
    expect(counter(run.homePath, "effect").count()).toBe(2);
    expect(counter(run.homePath, "after").count()).toBe(1);
    await client.close();
  } finally {
    await run.cleanup();
  }
}, 40_000);

test("skip: the owner skips the cut-off step and the code continues without it", async () => {
  const run = await pausedAfterCrash();
  try {
    const client = await connectAsOwner(run.homePath);
    await client.call(RESOLVE, { invocation: invocationOf(run.seen), choice: "skip" });
    await eventually(
      () => lastState(run.seen)?.state === "done",
      15_000,
      "the invocation should have finished after the skip",
    );
    // The skipped step was not called again; the step after it ran.
    expect(counter(run.homePath, "effect").count()).toBe(1);
    expect(counter(run.homePath, "after").count()).toBe(1);
    await client.close();
  } finally {
    await run.cleanup();
  }
}, 40_000);
