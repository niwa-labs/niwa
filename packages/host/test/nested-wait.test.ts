// A wait inside a nested call is waiting after a restart, not cut off: waiting is a step too, and
// recovery contracts are for cut-off calls.
//
//   1. a chain three calls deep of do-not-repeat actions, the deepest waiting: after a SIGKILL
//      and a restart the invocation is waiting again, no call of the chain is judged as cut off, and
//      the answer ends the invocation as done
//   2. a call whose wait was answered and whose next nested call is cut off is not waiting:
//      the nested call's own recovery contract judges it and the invocation pauses

import { expect, test } from "bun:test";

import { CORE_TYPES } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Answer, Start } from "./fixtures/nested-wait-host.ts";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/nested-wait-host.ts", import.meta.url));

/** The states the invocation went through, in the order the journal holds them. */
function statesOf(seen: StoredRecord[]): string[] {
  return seen.filter((record) => record.type === CORE_TYPES.invocationState).map((record) => (record.data as { state: string }).state);
}

/** How many times the invocation became waiting. */
function waitings(seen: StoredRecord[]): number {
  return statesOf(seen).filter((state) => state === "waiting").length;
}

test("a wait three calls deep survives a restart: it is not judged as cut off and the answer ends it as done", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 1, mode: "top" });
    await eventually(
      () => lastState(watcher!.seen)?.state === "waiting",
      15_000,
      "the chain should be waiting",
    );

    await first.kill();
    await watcher.stop();
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();
    // A watcher of the restarted host reads the whole history.
    watcher = await watch(homePath);

    await eventually(
      () => waitings(watcher!.seen) >= 2,
      15_000,
      "the restarted host should resume the chain as waiting",
    );
    expect(lastState(watcher!.seen)?.state).toBe("waiting");

    await client.emit(Answer, { n: 1 });
    await eventually(() => lastState(watcher!.seen)?.state === "done", 15_000, "the invocation should end as done");
    expect(statesOf(watcher.seen)).not.toContain("paused");
    await client.close().catch(() => {});
  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a nested call cut off after an answered wait is judged by its own contract", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 2, mode: "after" });
    await eventually(
      () => lastState(watcher!.seen)?.state === "waiting",
      15_000,
      "the call should be waiting",
    );
    // The answer lets the waiter finish; "slow" starts and stays on its closed gate.
    await client.emit(Answer, { n: 2 });
    await eventually(() => counter(homePath, "slow").count() === 1, 15_000, "slow should have started");

    await first.kill();
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();

    await eventually(() => lastState(watcher!.seen)?.state === "paused", 15_000, "the cut-off call should pause it");
    expect(counter(homePath, "slow").count()).toBe(1);
    await client.close().catch(() => {});
  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
