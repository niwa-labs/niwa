// Replay mismatch.
//
// The scenario runs against a real host process (fixtures/replay-mismatch-host.ts). The number the step
// is called with comes from the third argument of the host:
//
//   1. spawn the host with the step input 7, connect a client, emit Start { n }
//   2. the handler calls the action "effect", which blocks on the gate "g1"
//   3. kill the host with SIGKILL — a real crash, in the middle of the call
//   4. spawn the host again with the step input 9: the invocation resumes on the same record,
//      but the step is now called with a different input under the same key
//   5. the invocation pauses with a mismatch, and the effect was not called again
//
// Only the public API is used: the entries of the packages (types) and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { counter, eventually, gate, spawnHost, tempHome, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Start } from "./fixtures/replay-mismatch-host.ts";

const HOST_SCRIPT = new URL("./fixtures/replay-mismatch-host.ts", import.meta.url).pathname;

test("replay mismatch: the step is called with another input under the same key, and the invocation pauses", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    // 1. The first host. It is killed in the middle of the call.
    first = spawnHost(HOST_SCRIPT, homePath, ["7"]);
    await first.ready();

    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 7 });

    // 2. The action is blocked on the gate: it was called, and its outcome is not recorded.
    await eventually(
      () => counter(homePath, "effect").count() >= 1,
      10_000,
      "the effect should have been called once before the crash",
    );
    expect(counter(homePath, "effect").count()).toBe(1);

    // 3. A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});

    // 4. The second host resumes the unfinished invocation, but the step is called with
    //    another input under the same key.
    second = spawnHost(HOST_SCRIPT, homePath, ["9"]);
    gate(homePath, "g1").open();
    await second.ready();

    const observed = await watch(homePath);
    watcher = observed;

    // 5. The invocation pauses with a mismatch.
    await eventually(
      () => lastState(observed.seen)?.state === "paused",
      15_000,
      "the invocation should have paused",
    );
    const paused = lastState(observed.seen);
    expect(paused?.state).toBe("paused");
    expect(paused?.reason ?? "").toContain("replay mismatch");

    // No second effect happened: the action was not called again.
    expect(counter(homePath, "effect").count()).toBe(1);
  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);
