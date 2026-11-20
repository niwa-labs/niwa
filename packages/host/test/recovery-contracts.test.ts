// Recovery contracts.
//
// The scenario runs against a real host process (fixtures/recovery-contracts-host.ts). The recovery
// contract of the action comes from the third argument of the host:
//
//   1. spawn the host, connect a client, emit Start { n }
//   2. the handler calls the action "effect", which blocks on the gate "g1"
//   3. kill the host with SIGKILL — a real crash, in the middle of the call
//   4. spawn the host again with the same contract: the step has an intent and no outcome
//   5. with "repeat": the action is called again and the invocation finishes
//   6. with "repeat-with-key": the action is called again with the same operation id as the
//      first time — the ids are recorded by the stub, one per line, in the home
//
// Only the public API is used: the entries of the packages (types) and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { counter, eventually, gate, operations, spawnHost, tempHome, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Start } from "./fixtures/recovery-contracts-host.ts";

const HOST_SCRIPT = new URL("./fixtures/recovery-contracts-host.ts", import.meta.url).pathname;

/** Run the crash and the restart with one recovery contract; `seen` is the journal as observed. */
async function crashAndRestart(recovery: "repeat" | "repeat-with-key") {
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
    const first = spawnHost(HOST_SCRIPT, homePath, [recovery]);
    hosts.push(first);
    await first.ready();

    // One observer for the whole run: it reconnects to the second host by itself.
    const observed = await watch(homePath);
    watcher = observed;
    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 7 });

    // The action is blocked on the gate: it was called, and its outcome is not recorded.
    await eventually(
      () => counter(homePath, "effect").count() >= 1,
      10_000,
      "the effect should have been called once before the crash",
    );

    // A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});

    // The second host resumes the unfinished invocation. The gate is opened right away.
    const second = spawnHost(HOST_SCRIPT, homePath, [recovery]);
    hosts.push(second);
    gate(homePath, "g1").open();
    await second.ready();

    return { homePath, seen: observed.seen, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("repeat: the action is called again after the crash and the invocation finishes", async () => {
  const run = await crashAndRestart("repeat");
  try {
    // The action is called again: the contract allows it.
    await eventually(
      () => lastState(run.seen)?.state === "done",
      15_000,
      "the invocation should have finished",
    );
    expect(counter(run.homePath, "effect").count()).toBe(2);
  } finally {
    await run.cleanup();
  }
}, 40_000);

test("repeat-with-key: the action is called again with the same operation id", async () => {
  const run = await crashAndRestart("repeat-with-key");
  try {
    await eventually(
      () => lastState(run.seen)?.state === "done",
      15_000,
      "the invocation should have finished",
    );
    expect(counter(run.homePath, "effect").count()).toBe(2);

    // The operation id of the second call is the one of the first: the other side can dedupe
    // it, because it is the same operation.
    const ids = operations(run.homePath, "effect").ids();
    expect(ids.length).toBe(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
  } finally {
    await run.cleanup();
  }
}, 40_000);
