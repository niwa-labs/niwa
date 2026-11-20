// An action that waits inside itself is waiting after a restart, not cut off.
//
//   1. spawn the host, emit Start { n }: the handler calls "waiter", a do-not-repeat action that
//      waits inside itself; the invocation becomes "waiting"
//   2. kill the host with SIGKILL while it waits
//   3. spawn a second host: the invocation is waiting again, not paused by the recovery contract
//   4. emit Answer { n }: the action returns, the invocation ends as "done", never "paused"

import { expect, test } from "bun:test";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Answer, Start } from "./fixtures/action-wait-restart-host.ts";

const HOST_SCRIPT = new URL("./fixtures/action-wait-restart-host.ts", import.meta.url).pathname;

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = "niwa.invocation.state";

const InvocationState = z.object({ invocation: z.string(), state: z.string() });

/** The states of the invocation, in the order the journal holds them. */
function statesOf(records: StoredRecord[]): string[] {
  const states: string[] = [];
  for (const record of records) {
    if (record.type !== STATE_TYPE) continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success) states.push(parsed.data.state);
  }
  return states;
}

test("a do-not-repeat action that waits inside itself keeps waiting across a restart and completes", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const clients: Array<{ close(): Promise<void> }> = [];
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;

  try {
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();
    const client = await connectAsOwner(homePath);
    clients.push(client);
    const watcher = await connectAsOwner(homePath);
    clients.push(watcher);
    const seen: StoredRecord[] = [];
    void (async () => {
      for await (const record of watcher.records.since(seq(0))) seen.push(record);
    })().catch(() => {});

    await client.emit(Start, { n: 1 });
    await eventually(() => statesOf(seen).includes("waiting"), 10_000, "the action should be waiting");

    await first.kill();
    first = undefined;

    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();
    const observer = await connectAsOwner(homePath);
    clients.push(observer);
    const history: StoredRecord[] = [];
    void (async () => {
      for await (const record of observer.records.since(seq(0))) history.push(record);
    })().catch(() => {});

    // The restarted host takes the step up again as waiting: a second "waiting" after the crash,
    // and no pause.
    await eventually(
      () => statesOf(history).filter((state) => state === "waiting").length >= 2,
      15_000,
      "the restarted host should resume the invocation as waiting",
    );
    expect(statesOf(history)).not.toContain("paused");

    const answerer = await connectAsOwner(homePath);
    clients.push(answerer);
    await answerer.emit(Answer, { n: 1 });

    await eventually(
      () => statesOf(history).includes("done"),
      15_000,
      "the invocation should end as done once the answer arrives",
    );
    expect(statesOf(history)).not.toContain("paused");
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
