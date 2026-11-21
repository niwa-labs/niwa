// State.
//
// The scenario runs against a real host process (fixtures/state-host.ts):
//
//   1. spawn the host, connect a client, emit many Add and Bump records; the
//      two handlers of the same counter wait on the gate "g2", so every one of
//      their invocations is in flight at the same time
//   2. open the gate: all the invocations update the same counter at once, and
//      every update must be in it — no update is lost
//   3. emit Fill { items } and Take { tag }; the handler of Take takes the
//      batch and blocks in the gated step "g"
//   4. kill the host with SIGKILL — a real crash, after the take and before the
//      next step
//   5. spawn the host again, open the gate "g": the invocation of Take is
//      replayed and returns the same batch
//   6. the batch is taken once and not twice, and the invocation ends as done
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Add, Bump, Fill, Seen, Take } from "./fixtures/state-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/state-host.ts", import.meta.url));

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = "niwa.invocation.state";

/** The type the core writes for every change of a plugin's state. */
const CHANGED_TYPE = "niwa.state.changed";

/** The data of a CORE.invocationState record: { invocation, state, reason? }. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
});

/** The data of a state change: { plugin, name, op, value }. */
const Change = z.object({
  plugin: z.string(),
  name: z.string(),
  op: z.string(),
  value: z.unknown(),
});

/**
 * The current value of a state key, as the journal says it.
 *
 * Every change is a record, so the value a key holds is the value of the last
 * change of that key. This is what the host's own projection holds too: the
 * value is folded from the journal, never kept anywhere else.
 */
function currentOf(records: StoredRecord[], name: string): unknown {
  let value: unknown;
  for (const record of records) {
    if (record.type !== CHANGED_TYPE) continue;
    const parsed = Change.safeParse(record.data);
    if (!parsed.success) continue;
    if (parsed.data.name !== name) continue;
    value = parsed.data.value;
  }
  return value;
}

/** The changes of a state key, in the order the journal holds them. */
function changesOf(records: StoredRecord[], name: string): Array<z.infer<typeof Change>> {
  const changes: Array<z.infer<typeof Change>> = [];
  for (const record of records) {
    if (record.type !== CHANGED_TYPE) continue;
    const parsed = Change.safeParse(record.data);
    if (!parsed.success) continue;
    if (parsed.data.name !== name) continue;
    changes.push(parsed.data);
  }
  return changes;
}

/** True for a record "niwa.invocation.state" whose state is "done". */
function isDoneState(record: StoredRecord): boolean {
  if (record.type !== STATE_TYPE) return false;
  const parsed = InvocationState.safeParse(record.data);
  return parsed.success && parsed.data.state === "done";
}

/** The batch a Seen record carries. */
function seenItems(record: StoredRecord): string[] | undefined {
  if (record.type !== Seen.name) return undefined;
  const parsed = Seen.schema.safeParse(record.data);
  return parsed.success ? parsed.data.items : undefined;
}

test("state: concurrent updates are not lost, and a batch taken before a crash is taken again after the restart", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const clients: Array<{ close(): Promise<void> }> = [];
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The first host, and many records that wait for the same gate.
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
    })().catch(() => undefined);

    // Two handlers, the same counter. Every handler waits on the gate first, so
    // all of them are in flight at the same time when the gate opens.
    const adds = 10;
    const bumps = 10;
    for (let i = 0; i < adds; i += 1) {
      await client.emit(Add, { n: 1 });
    }
    for (let i = 0; i < bumps; i += 1) {
      await client.emit(Bump, { n: 1 });
    }

    // Every invocation reached the gated step: they are all in flight.
    await eventually(
      () => counter(homePath, "tick").count() === adds + bumps,
      15_000,
      "every handler should have reached the gated step",
    );
    // No update has happened yet, so the journal holds no change of the counter:
    // it still holds its initial value.
    expect(changesOf(seen, "counter").length).toBe(0);

    // 2. The gate opens: all the invocations update the same counter at once.
    gate(homePath, "g2").open();

    await eventually(
      () => currentOf(seen, "counter") === adds + bumps,
      15_000,
      "the counter should hold every update",
    );

    // 2. No update is lost: the counter holds every one of them.
    expect(currentOf(seen, "counter")).toBe(adds + bumps);
    const counterChanges = changesOf(seen, "counter");
    expect(counterChanges.length).toBe(adds + bumps);
    expect(counterChanges.every((change) => change.plugin === "state")).toBe(true);

    // 3. The batch is filled and then taken.
    const items = ["a", "b", "c"];
    await client.emit(Fill, { items });
    await client.emit(Take, { tag: "take-1" });

    // The handler of Take took the batch and is now blocked in the gated step.
    await eventually(
      () => counter(homePath, "hold").count() === 1,
      15_000,
      "the take handler should have reached the gated step",
    );

    // The batch is gone from the state: the take reset it in one change.
    await eventually(
      () => changesOf(seen, "batch").some((change) => change.op === "take"),
      10_000,
      "the batch should have been taken",
    );
    expect(currentOf(seen, "batch")).toEqual([]);

    // 4. A real crash: SIGKILL, after the take and before the next step.
    await first.kill();
    first = undefined;
    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;

    // 5. The second host takes the unfinished invocation up again. The gate is
    //    opened right away, before waiting for the socket: the resumed step
    //    must not block the host from accepting connections.
    second = spawnHost(HOST_SCRIPT, homePath);
    gate(homePath, "g").open();
    await second.ready();

    const observer = await connectAsOwner(homePath);
    clients.push(observer);
    const history: StoredRecord[] = [];
    const observe = (async () => {
      for await (const record of observer.records.since(FROM_START)) {
        history.push(record);
      }
    })().catch(() => undefined);

    // The replayed invocation finished and wrote down the batch it took.
    await eventually(
      () => history.some((record) => seenItems(record) !== undefined),
      15_000,
      "the replayed take should have written down the batch",
    );

    // 6. The same batch is returned after the restart.
    const taken = history.find((record) => seenItems(record) !== undefined);
    expect(seenItems(taken as StoredRecord)).toEqual(items);

    // The batch was taken once and not twice: the state holds one take.
    const takes = changesOf(history, "batch").filter((change) => change.op === "take");
    expect(takes.length).toBe(1);

    // The batch was read once, and the replay returned that record, not today's empty batch.
    const batchReads = history.filter((record) => {
      if (record.type !== "niwa.state.read") return false;
      const parsed = Change.safeParse(record.data);
      return parsed.success && parsed.data.name === "batch" && parsed.data.op === "take";
    });
    expect(batchReads.length).toBe(1);
    expect(batchReads[0]?.data).toMatchObject({ value: items });

    // The invocation of Take ended as done.
    await eventually(
      () => history.some(isDoneState),
      15_000,
      "the invocation of the take should have ended as done",
    );

    // The counter is untouched by the restart: its value is a projection of the
    // journal, and the journal still holds every update.
    expect(currentOf(history, "counter")).toBe(adds + bumps);
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
