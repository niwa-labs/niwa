// One writer.
//
// The scenario runs against real host processes (fixtures/single-writer-host.ts):
//
//   1. spawn host A; it serves the home
//   2. spawn host B on the same home — B is refused with WriterBusy, and its output says so
//   3. kill A with SIGKILL — a real crash, no clean shutdown
//   4. spawn B again — the dead holder is taken over, and B serves
//   5. the journal is the same one: a record written through B is readable
//
// The stale holder is the second half of the check:
//
//   6. host A parks inside a step, on a gate that the test opens later
//   7. host B starts with "takeover": it takes the journal from the living A
//   8. the gate opens — A tries to write the outcome of its step and the journal refuses
//      it: A has lost ownership. A says so and stops
//   9. B's journal holds no record written by a handler after the take-over
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { StoredRecord } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { Probe, Start } from "./fixtures/single-writer-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/single-writer-host.ts", import.meta.url));

/** From the beginning of the journal. */
const FROM_START = seq(0);

/**
 * Read the journal through the public subscription.
 *
 * A subscription never ends by itself, so the read stops itself: it waits for the journal to
 * settle and then closes the subscription.
 */
async function readJournal(
  client: Awaited<ReturnType<typeof connect>>,
  settleMs = 500,
): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  const reading = (async () => {
    for await (const record of client.records.since()) {
      records.push(record);
    }
  })().catch(() => {});
  await Bun.sleep(settleMs);
  await client.close().catch(() => {});
  await reading;
  return records;
}

/**
 * True for a record written by one plugin's handler: the actor names the handler that
 * wrote it, and a handler id is the plugin's name and the handler's own name
 *.
 */
function writtenByHandler(record: StoredRecord, pluginName = "single-writer"): boolean {
  return record.actor.kind === "handler" && record.actor.handler.startsWith(`${pluginName}/`);
}

/** The highest journal position in these records. */
function highestSeq(records: StoredRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0);
}

test("one writer: a second host is refused while the first lives, and it takes the journal over after the first dies", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let refused: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    // 1. The first host serves the home.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();

    // 2. A second host on the same home is refused while the first lives. The
    //    refusal is a fact about the second host, so it is read from its output.
    refused = spawnHost(HOST_SCRIPT, homePath);
    await eventually(
      () => refused?.output().includes("WriterBusy") === true,
      10_000,
      "the second host should be refused with WriterBusy",
    );
    expect(refused.output()).toContain("WriterBusy");
    await refused.kill();
    refused = undefined;

    // 3. The first host dies without a clean shutdown: SIGKILL, no goodbye.
    await first.kill();
    first = undefined;

    // 4. The second host takes the journal over: the holder is dead, so the
    //    journal may be taken.
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();

    // 5. The journal is the same one and it works: a record written through
    //    the second host comes back with its data.
    client = await connectAsOwner(homePath);
    const written = await client.emit(Start, { n: 1 });
    expect(written.type).toBe(Start.name);

    const records = await readJournal(client);
    expect(records.some((record) => record.id === written.id)).toBe(true);
  } finally {
    await client?.close().catch(() => {});
    await first?.kill().catch(() => {});
    await refused?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("one writer: a stale holder that writes learns it lost the journal, writes nothing and stops", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let stale: ReturnType<typeof spawnHost> | undefined;
  let taker: ReturnType<typeof spawnHost> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    // 1. The first host serves the home, and parks inside a step: the gate is
    //    not open, so the invocation waits in the middle of the step.
    stale = spawnHost(HOST_SCRIPT, homePath, ["block", "single-writer"]);
    await stale.ready();

    client = await connectAsOwner(homePath);
    await client.emit(Start, { n: 1 });
    await eventually(
      () => counter(homePath, "block").count() === 1,
      10_000,
      "the first host should be parked inside the step",
    );

    // Where the journal stands before the take-over. The step intent of the
    // parked invocation is the last thing a handler wrote.
    const before = await readJournal(await connectAsOwner(homePath));
    const handlerRecords = before.filter((record) => writtenByHandler(record, "single-writer"));
    expect(handlerRecords.length).toBeGreaterThan(0);
    const position = highestSeq(handlerRecords);

    // 2. The second host takes the journal over from the living holder. The
    //    take-over is explicit: the holder did not ask for it, so it learns it
    //    lost the journal from its next write.
    //
    //    The socket of the stale host is still there, so `ready()` would be
    //    answered by the stale host. The take-over is therefore observed where
    //    it is real: in the journal.
    taker = spawnHost(HOST_SCRIPT, homePath, ["takeover", "block2", "single-writer-taker"]);

    // The take-over is done when the socket belongs to the new holder. The
    // socket of the stale host is still there, so `ready()` would be answered
    // by the stale host. The new holder is told apart by what it declares:
    // its plugin has its own name, and the description says which host is
    // listening.
    await eventually(
      async () => {
        // The connection itself may fail while the take-over is under way (the file is removed
        // and bound again), so it is part of the attempt.
        let probe: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          probe = await connectAsOwner(homePath);
          const described = await probe.describe();
          return described.actions.some((action) => action.name === "single-writer-taker-finish");
        } catch {
          return false;
        } finally {
          await probe?.close().catch(() => {});
        }
      },
      15_000,
      "the second host should be the one listening",
    );

    // 3. The gate opens: the parked invocation of the stale host tries to write
    //    the outcome of its step, and the journal refuses it. The stale host says
    //    so and stops — it is not the writer any more, and it writes nothing.
    gate(homePath, "block").open();
    await eventually(
      () => stale?.output().includes("LostOwnership") === true,
      15_000,
      "the stale holder should learn it lost the journal",
    );
    expect(stale.output()).toContain("LostOwnership");

    // The stale holder does not go on: its next step never ran, because the
    // write of this one was refused.
    expect(counter(homePath, "single-writer-finish").count()).toBe(0);

    // 4. The journal of the new holder holds no record written by the stale
    //    holder after the take-over: the write of the old holder was refused,
    //    and nothing was written in its place.
    //
    //    Only the records of the stale holder's own plugin are counted: the new
    //    holder has its own plugin and writes its own records.
    const after = await readJournal(await connectAsOwner(homePath));
    const staleRecords = after.filter((record) => writtenByHandler(record, "single-writer"));
    const afterTakeover = staleRecords.filter((record) => record.seq > position);
    expect(afterTakeover).toHaveLength(0);
    // The records of the stale holder from before the take-over are still there.
    expect(staleRecords.length).toBe(handlerRecords.length);

    // 5. The new holder is the writer now: it writes, and it may write.
    const takerClient = await connectAsOwner(homePath);
    const probe = await takerClient.emit(Probe, { n: 2 });
    expect(probe.type).toBe(Probe.name);
    await takerClient.close().catch(() => {});
  } finally {
    await client?.close().catch(() => {});
    await stale?.kill().catch(() => {});
    await taker?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("one writer: a stale host that is stopped leaves the socket of the new holder alone", async () => {
  const home = await tempHome();
  let stale: ReturnType<typeof spawnHost> | undefined;
  let taker: ReturnType<typeof spawnHost> | undefined;

  try {
    stale = spawnHost(HOST_SCRIPT, home.path);
    await stale.ready();
    taker = spawnHost(HOST_SCRIPT, home.path, ["takeover", "block2", "single-writer-taker"]);
    await eventually(
      async () => {
        let probe: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          probe = await connectAsOwner(home.path);
          return (await probe.describe()).actions.some((action) => action.name === "single-writer-taker-finish");
        } catch {
          return false;
        } finally {
          await probe?.close().catch(() => {});
        }
      },
      15_000,
      "the second host should be the one listening",
    );

    // The stale host shuts down cleanly. It did not write yet, so it has not noticed the
    // take-over: stopping its listener must not remove the file the new holder listens on.
    await stale.stop();
    stale = undefined;

    const client = await connectAsOwner(home.path);
    try {
      const described = await client.describe();
      expect(described.actions.some((action) => action.name === "single-writer-taker-finish")).toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await stale?.kill().catch(() => {});
    await taker?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
