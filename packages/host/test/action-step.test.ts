// An action may call another action as a step: waiting is a step too.
//
// A handler and an action both make durable calls this way. An action that only waits is
// recorded under the key `<stepKey>.wait-N` and resumes as waiting after a restart (action-wait-restart.test.ts).
//
// The scenario runs against a real host process (fixtures/action-step-host.ts). The plugin
// declares one record type, two actions and one handler:
//
//   on Start { n }  — the handler calls the action "outer"
//   "outer"         — calls the action "inner" through ctx.step, by name
//   "inner"         — an effect that counts its calls
//
// The checks:
//
//   1. a handler calls "outer", "outer" calls "inner" by name, and the answer comes back
//   2. the host is killed after the nested call's outcome is recorded and before "outer"
//      finishes: after the restart "inner" is not called again, and the invocation ends as done
//   3. "inner" is cut off mid-call and says "do-not-repeat": the nested step is unknown and the
//      invocation pauses, as a top-level step does
//   4. a direct client call of "outer" works, and "inner" runs once
//   5. a nested call of a name nobody serves pauses the invocation on the nested step, even
//      when the code of the action catches the error
//   6. the outcome of a nested call of a name nobody serves is "failed", and the nested step
//      still takes its key
//
// Only the public API is used: the entries of the packages (types) and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { actionName, CORE_TYPES, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, invocationOf, lastState, watch, connectAsOwner } from "@niwa-labs/testing";

import { Answered, Start } from "./fixtures/action-step-host.ts";

const HOST_SCRIPT = new URL("./fixtures/action-step-host.ts", import.meta.url).pathname;

/** The type the core writes for the intent of a step. */
const INTENT_TYPE = CORE_TYPES.stepIntent;

/** The type the core writes for the outcome of a step. */
const OUTCOME_TYPE = CORE_TYPES.stepOutcome;

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = CORE_TYPES.invocationState;

/** The action a direct call reaches. */
const OUTER = actionName("outer");

/** The action that calls a name nobody serves. */
const MISSING = actionName("missing");

/** The action that asks for the outcome of a name nobody serves. */
const OUTCOME = actionName("outcome");

/** The key a step was recorded under. */
function keyOf(record: StoredRecord): string {
  return (record.data as { key?: string }).key ?? "";
}

/** The step records of one kind, in the order the journal holds them. */
async function stepsOf(
  client: Awaited<ReturnType<typeof connect>>,
  type: typeof INTENT_TYPE,
): Promise<StoredRecord[]> {
  return client.records.read(seq(0), { type });
}

test("an action that calls another action as a step: the answer comes back and the call is recorded", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await host.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    // The gates are opened, so the nested call finishes and the answer comes back.
    gate(homePath, "g-inner").open();
    gate(homePath, "g-outer").open();
    await client.emit(Start, { n: 7 });

    await eventually(
      async () => (await client.records.read(seq(0), { type: Answered.name })).length === 1,
      15_000,
      "the handler should have written the answer",
    );
    const answers = await client.records.read(seq(0), { type: Answered.name });
    expect(answers[0]?.data).toEqual({ n: 7 });

    // The nested call is a step of the same invocation: its key belongs to the step that
    // made it, and the intent and the outcome are recorded like those of any other step.
    const intents = await stepsOf(client, INTENT_TYPE);
    const keys = intents.map(keyOf);
    expect(keys).toContain("1");
    expect(keys).toContain("1.step-1");
    const outcomes = await stepsOf(client, OUTCOME_TYPE);
    expect(outcomes.map(keyOf)).toContain("1.step-1");

    // The inner action ran once.
    expect(counter(homePath, "inner").count()).toBe(1);

    await client.close().catch(() => {});
  } finally {
    await watcher?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("a crash after the nested call's outcome: the nested call is not made again and the invocation ends as done", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    first = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await first.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    // The inner gate is open, so the nested call finishes and its outcome is recorded. The
    // outer gate stays closed: "outer" does not finish before the crash.
    gate(homePath, "g-inner").open();
    await client.emit(Start, { n: 3 });

    // The nested call has run: its outcome is recorded, and "outer" has not finished, because
    // the answer the handler writes comes after it.
    await eventually(
      async () =>
        (await client.records.read(seq(0), { type: OUTCOME_TYPE })).some(
          (record) => keyOf(record) === "1.step-1",
        ),
      15_000,
      "the outcome of the nested call should be recorded",
    );
    expect(counter(homePath, "inner").count()).toBe(1);

    // A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});

    second = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    gate(homePath, "g-outer").open();
    await second.ready();

    // The invocation resumes: the recorded outcome of the nested call is its answer, so the
    // inner action is not called again, and the invocation ends as done.
    await eventually(
      () => lastState(watcher!.seen)?.state === "done",
      15_000,
      "the invocation should have ended as done",
    );
    expect(counter(homePath, "inner").count()).toBe(1);
    expect(lastState(watcher!.seen)?.state).not.toBe("paused");
  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a nested call that is cut off and says do-not-repeat: the step is unknown and the invocation pauses", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    first = spawnHost(HOST_SCRIPT, homePath, ["do-not-repeat"]);
    await first.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    await client.emit(Start, { n: 5 });

    // The nested call was cut off: its intent is recorded and its outcome is not.
    await eventually(
      () => counter(homePath, "inner").count() >= 1,
      15_000,
      "the inner action should have been called",
    );
    await eventually(
      async () =>
        (await client.records.read(seq(0), { type: INTENT_TYPE })).some(
          (record) => keyOf(record) === "1.step-1",
        ),
      15_000,
      "the intent of the nested call should be recorded",
    );

    // A real crash in the middle of the nested call.
    await first.kill();
    await client.close().catch(() => {});

    second = spawnHost(HOST_SCRIPT, homePath, ["do-not-repeat"]);
    await second.ready();

    // The recovery contract decides: the effect may have happened, so the step is unknown and
    // the invocation pauses, exactly as a top-level step does.
    await eventually(
      () => lastState(watcher!.seen)?.state === "paused",
      15_000,
      "the invocation should have paused",
    );
    // The inner action was not called again: the contract says it may not be.
    expect(counter(homePath, "inner").count()).toBe(1);
  } finally {
    await watcher?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a direct call of an action that calls another action: it works and the inner action runs once", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await host.ready();
    const client = await connectAsOwner(homePath);

    // The call is made outside any invocation: it is not a step and not journaled, and the
    // nested call goes through the same point with the same caller.
    gate(homePath, "g-inner").open();
    gate(homePath, "g-outer").open();
    const answer = await client.call(OUTER, { n: 11 });
    expect(answer).toEqual({ n: 11 });
    expect(counter(homePath, "inner").count()).toBe(1);

    await client.close().catch(() => {});
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("a nested call of a name nobody serves: the invocation pauses on the nested step", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await host.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    gate(homePath, "g-inner").open();
    gate(homePath, "g-outer").open();
    await client.emit(Start, { n: 2, mode: "missing" });

    // The code of the action caught the error, but the invocation still pauses: the nested
    // step is a step of the invocation, and nobody serves that name.
    await eventually(
      () => lastState(watcher!.seen)?.state === "paused",
      15_000,
      "the invocation should have paused on the nested step",
    );
    // The pause names the nested step, not the step of the handler.
    const paused = watcher.seen.filter(
      (record) => record.type === STATE_TYPE && (record.data as { state?: string }).state === "paused",
    );
    expect(JSON.stringify(paused[0]?.data)).toContain("1.step-1");
  } finally {
    await watcher?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("the outcome of a nested call of a name nobody serves is failed, and the nested key is taken", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await host.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    gate(homePath, "g-inner").open();
    gate(homePath, "g-outer").open();
    await client.emit(Start, { n: 4, mode: "outcome" });

    // The outcome is "failed", so the action goes on and the invocation ends as done.
    await eventually(
      () => lastState(watcher!.seen)?.state === "done",
      15_000,
      "the invocation should have ended as done",
    );
    // The nested step took its key: the call after it keeps its own.
    const intents = await stepsOf(client, INTENT_TYPE);
    expect(intents.map(keyOf)).toEqual(["1"]);
  } finally {
    await watcher?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("a nested step that failed inside an action that must not be repeated: the answer is about the nested step", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath, ["repeat"]);
    await host.ready();
    watcher = await watch(homePath);
    const client = await connectAsOwner(homePath);

    await client.emit(Start, { n: 1, mode: "careful" });
    await eventually(
      () => lastState(watcher!.seen)?.state === "paused",
      15_000,
      "the invocation should have paused on the nested step",
    );
    expect(lastState(watcher.seen)?.key).toBe("1.step-1");
    expect(counter(homePath, "boom").count()).toBe(1);

    // The owner says retry about the nested step. The action that made the call was not cut off:
    // it paused, so it is entered again and the nested step is called again, and the invocation
    // pauses on the nested step again - not on the action, whose contract is about a crash.
    const before = watcher.seen.length;
    await client.call(actionName("niwa.invocation.resolve"), {
      invocation: invocationOf(watcher.seen),
      choice: "retry",
    });
    await eventually(
      () => counter(homePath, "boom").count() === 2,
      15_000,
      "the nested step should have been called again",
    );
    await eventually(
      () => watcher!.seen.length > before + 2 && lastState(watcher!.seen)?.state === "paused",
      15_000,
      "the invocation should have paused again",
    );
    expect(lastState(watcher.seen)?.key).toBe("1.step-1");
    await client.close().catch(() => {});
  } finally {
    await watcher?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);
