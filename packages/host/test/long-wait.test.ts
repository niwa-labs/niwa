// A long wait blocks nothing.
//
// The scenario runs against a real host process (fixtures/long-wait-host.ts):
//
//   1. spawn the host, connect a client, emit Ask { n: 0 }
//   2. the handler waits (step.wait) for Answer { n: 0 }; the invocation's
//      state becomes "waiting" — a state record the host wrote
//   3. emit Job { n: 1 } … Job { n: 10 }; each one calls the action "job",
//      which is counted
//   4. the counter of "job" reaches 10 while the Ask invocation is still
//      waiting: no invocation of the Ask handler is done, and its latest
//      state is "waiting"
//   5. emit Answer { n: 0 }; the wait is satisfied, the invocation ends as
//      done
//
// The counter is the count of real calls, not an inference: ten calls of "job"
// are ten hits of the stub. The state of the waiting invocation is read from
// the records the host wrote.
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Answer, Ask, Job } from "./fixtures/long-wait-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/long-wait-host.ts", import.meta.url));

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = "niwa.invocation.state";

/** The type the core writes when an invocation is admitted. */
const ADMITTED_TYPE = "niwa.invocation.admitted";

/** The handler of the invocation that waits. */
const ASK_HANDLER = "long-wait/long-wait.ask";

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** The data of a CORE.invocationState record: { invocation, state, reason? }. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
});

/** The data of a CORE.invocationAdmitted record: { invocation, handler, … }. */
const Admitted = z.object({
  invocation: z.string(),
  handler: z.string(),
});

/**
 * The invocation of the Ask handler: the journal says which invocation the
 * waiting record woke.
 */
function askInvocation(records: StoredRecord[]): string | undefined {
  for (const record of records) {
    if (record.type !== ADMITTED_TYPE) continue;
    const parsed = Admitted.safeParse(record.data);
    if (parsed.success && parsed.data.handler === ASK_HANDLER) return parsed.data.invocation;
  }
  return undefined;
}

/**
 * The states of one invocation, in the order the journal holds them.
 */
function statesOf(records: StoredRecord[], invocation: string): string[] {
  const states: string[] = [];
  for (const record of records) {
    if (record.type !== STATE_TYPE) continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success && parsed.data.invocation === invocation) states.push(parsed.data.state);
  }
  return states;
}

test("a long wait blocks nothing: the ten jobs are handled while the first invocation still waits", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const clients: Array<{ close(): Promise<void> }> = [];
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The host, a client that writes and an observer that reads.
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();

    const client = await connectAsOwner(homePath);
    clients.push(client);
    const observer = await connectAsOwner(homePath);
    clients.push(observer);
    const seen: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of observer.records.since(FROM_START)) {
        seen.push(record);
      }
    })().catch(() => {});

    // 2. The Ask record wakes the invocation that waits.
    await client.emit(Ask, { n: 0 });

    // The invocation waits: the host wrote the state "waiting" for it, and it
    // did not finish.
    await eventually(
      () => {
        const invocation = askInvocation(seen);
        if (invocation === undefined) return false;
        const states = statesOf(seen, invocation);
        return states.includes("waiting");
      },
      15_000,
      "the invocation should be waiting for its answer",
    );

    const waiting = askInvocation(seen);
    expect(waiting).toBeDefined();
    if (waiting === undefined) throw new Error("the invocation was not admitted");

    // 3. Ten more records, written while the first invocation waits.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await client.emit(Job, { n });
    }

    // 4. All ten are handled while the first still waits.
    await eventually(
      () => counter(homePath, "job").count() === 10,
      15_000,
      "the ten jobs should have been handled while the first invocation waits",
    );

    expect(counter(homePath, "job").count()).toBe(10);

    // The waiting invocation is still waiting: its latest state is "waiting"
    // and it has not ended.
    const states = statesOf(seen, waiting);
    expect(states[states.length - 1]).toBe("waiting");
    expect(states).not.toContain("done");
    expect(states).not.toContain("paused");

    // 5. The answer arrives: the wait is satisfied and the invocation ends.
    await client.emit(Answer, { n: 0 });

    await eventually(
      () => statesOf(seen, waiting).includes("done"),
      15_000,
      "the waiting invocation should end as done once the answer arrives",
    );

    // The ten jobs were handled exactly once each, and the answer did not make
    // the host run them again.
    expect(counter(homePath, "job").count()).toBe(10);
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
