// Crash between steps.
//
// The scenario runs against a real host process (fixtures/crash-between-steps-host.ts):
//
//   1. spawn the host, connect a client, emit Start { n }
//   2. the handler calls a1 (its outcome is recorded) and then a2, which
//      blocks on the gate "g2"; a2's counter reaching 1 proves step 1's
//      outcome is already recorded
//   3. kill the host with SIGKILL — a real crash, in the middle of step 2
//   4. spawn the host again; the invocation resumes on the same record
//   5. open the gate "g2"; the second step finishes
//   6. a record of type "niwa.invocation.state" with state "done" appears
//   7. a1 was called once in total, a2 twice
//
// Only the public API is used: the entries of the packages (types) and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { counter, eventually, gate, spawnHost, tempHome, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Start } from "./fixtures/crash-between-steps-host.ts";

const HOST_SCRIPT = new URL("./fixtures/crash-between-steps-host.ts", import.meta.url).pathname;

test("crash between steps: the first action is called once, the second step runs, the invocation ends as done", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    // 1. The first host. It is killed in the middle of the second step.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();

    // One observer for the whole check: it reconnects to the second host by itself.
    const observed = await watch(homePath);
    watcher = observed;
    const client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 7 });

    // 2. a2 is only reached after step 1 returned, so its counter reaching 1
    //    is the proof that step 1's outcome was recorded. The gate is still
    //    closed, so a2 blocks and its own outcome is not recorded.
    await eventually(
      () => counter(homePath, "a2").count() >= 1,
      10_000,
      "a2 should have been called once before the crash",
    );
    expect(counter(homePath, "a1").count()).toBe(1);
    await eventually(
      () => observed.seen.some((record) => record.type === "niwa.step.outcome"),
      10_000,
      "the outcome of the first step should be recorded before the crash",
    );

    // 3. A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});

    // 4. The second host resumes the unfinished invocation. The gate is opened
    //    right away, before waiting for the socket: the resumed step must not
    //    block the host from accepting connections.
    second = spawnHost(HOST_SCRIPT, homePath);
    gate(homePath, "g2").open();
    await second.ready();

    // 5. The observer sees the invocation end.
    await eventually(
      () => lastState(observed.seen)?.state === "done",
      15_000,
      "the invocation should have ended as done",
    );

    // 6. The first action was called once in total; the second step ran again.
    expect(counter(homePath, "a1").count()).toBe(1);
    expect(counter(homePath, "a2").count()).toBe(2);

  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
