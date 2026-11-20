// Waiting survives a restart.
//
// The scenario runs against a real host process (fixtures/wait-restart-host.ts):
//
//   1. spawn the host, connect a client, emit Start { q }
//   2. the handler calls ask (counted) and then waits for an Answer record;
//      the invocation's state becomes "waiting"
//   3. kill the host with SIGKILL — a real crash, while the invocation waits
//   4. spawn the host again and wait for it to serve; the invocation is picked
//      up again — the journal grows by a state record — and it waits again:
//      the question is not asked a second time
//   5. emit Answer { q, text }; the wait is satisfied, the handler continues
//      from where it waited, calls after (counted), and the invocation ends
//      as done
//   6. ask was called once in total, after once
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Answer, Start } from "./fixtures/wait-restart-host.ts";

const HOST_SCRIPT = new URL("./fixtures/wait-restart-host.ts", import.meta.url).pathname;

/** The question the handler asks and then waits about. */
const QUESTION = "what is the answer";

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = "niwa.invocation.state";

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** The data of a CORE.invocationState record: { invocation, state, reason? }. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
});

/**
 * The states of the invocation, in the order the journal holds them.
 *
 * There is one invocation in this check: only the Start record has a handler,
 * and the Answer record is written by a client, not by a handler.
 */
function statesOf(records: StoredRecord[]): string[] {
  const states: string[] = [];
  for (const record of records) {
    if (record.type !== STATE_TYPE) continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success) states.push(parsed.data.state);
  }
  return states;
}

/** The state of the last state record the journal holds, if there is one. */
function lastState(records: StoredRecord[]): string | undefined {
  const states = statesOf(records);
  return states[states.length - 1];
}

/** True for a record "niwa.invocation.state" whose state is "done". */
function isDoneState(record: StoredRecord): boolean {
  if (record.type !== STATE_TYPE) return false;
  const parsed = InvocationState.safeParse(record.data);
  return parsed.success && parsed.data.state === "done";
}

/** The highest journal position in these records. */
function highestSeq(records: StoredRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0);
}

test("waiting survives a restart: the question is asked once and the answer still arrives", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const clients: Array<{ close(): Promise<void> }> = [];
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The first host. It is killed while the invocation waits.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();

    const client = await connectAsOwner(homePath);
    const watcher = await connectAsOwner(homePath);
    clients.push(client, watcher);
    const seen: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of watcher.records.since(FROM_START)) {
        seen.push(record);
      }
    })().catch(() => {});

    await client.emit(Start, { q: QUESTION });

    // 2. The question was asked, and the invocation is waiting for the answer.
    //    Both are observed, neither is inferred: the counter is the count of
    //    real calls, the state is a record the host wrote.
    await eventually(
      () =>
        counter(homePath, "ask").count() === 1 && statesOf(seen).includes("waiting"),
      10_000,
      "the question should be asked once and the invocation should be waiting",
    );

    expect(counter(homePath, "ask").count()).toBe(1);
    expect(counter(homePath, "after").count()).toBe(0);

    // Where the journal stands before the crash. Everything the second host
    // writes is after this position.
    const beforeCrash = highestSeq(seen);

    // 3. A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    first = undefined;
    await watcher.close().catch(() => {});
    await watch;

    // 4. The second host takes the waiting invocation up again.
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();

    // The observer subscribes from the beginning of the journal, so it reads
    // the states of the first host back from the journal as well.
    const observer = await connectAsOwner(homePath);
    clients.push(observer);
    const history: StoredRecord[] = [];
    const observe = (async () => {
      for await (const record of observer.records.since(FROM_START)) {
        history.push(record);
      }
    })().catch(() => {});

    // The restarted host took the invocation up again: the journal grew by a
    // state record after the crash, and the invocation is waiting — it neither
    // ended nor broke.
    await eventually(
      () => {
        const fresh = history.filter((record) => record.seq > beforeCrash);
        return (
          fresh.some((record) => record.type === STATE_TYPE) &&
          lastState(history) === "waiting" &&
          !statesOf(history).includes("done") &&
          !statesOf(history).includes("paused")
        );
      },
      15_000,
      "the restarted host should resume the waiting invocation",
    );

    // The question was not asked again, and nothing happened after it.
    expect(counter(homePath, "ask").count()).toBe(1);
    expect(counter(homePath, "after").count()).toBe(0);

    // 5. The answer arrives; the handler continues from where it waited.
    await client.close().catch(() => {});
    const answerer = await connectAsOwner(homePath);
    clients.push(answerer);
    await answerer.emit(Answer, { q: QUESTION, text: "42" });

    await eventually(
      () => counter(homePath, "after").count() === 1 && history.some(isDoneState),
      15_000,
      "the handler should continue after the answer and the invocation should be done",
    );

    // 6. The question was still asked only once, in total.
    expect(counter(homePath, "ask").count()).toBe(1);
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
