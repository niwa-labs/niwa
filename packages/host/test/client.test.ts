// Client.
//
// The scenario runs against a real host process (fixtures/client-host.ts),
// with the clients in this process:
//
//   1. spawn the host, connect client A, call the action "echo" and check the
//      value it returns
//   2. A writes the notes 1..3
//   3. client B subscribes from the beginning of the journal, filtered to the
//      record type Note, and collects what it receives
//   4. A writes the notes 4..6; B sees them
//   5. the host is killed with SIGKILL and spawned again
//   6. A, which stayed open, writes the notes 7..9: its call connection is reopened by itself
//   7. B ends up with all nine notes: the numbers 1..9 in order, positions
//      strictly increasing, no record twice; and a subscriber that read everything
//      from the start, unfiltered, saw exactly what a fresh read of the journal returns
//
// A second check holds a consumer that reads slowly: the subscription holds off the
// socket, and still delivers every record once, in order.
//
// The position is the point of the check. B subscribes from seq(0) and keeps
// its position across the restart, so the notes written before B connected
// and the notes written after the host came back arrive exactly once each:
// no gap, no duplicate.
//
// Only the public API is used: the entries of the packages (types, connect, seq) and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { NiwaApi } from "@niwa-labs/client";
import type { RecordQuery, StoredRecord } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Note, echo } from "./fixtures/client-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/client-host.ts", import.meta.url));

/** The data of a Note record: { n }. */
const NoteData = z.object({ n: z.number() });

/** Read a subscription into a list until it is closed. */
function collect(client: NiwaApi, query?: RecordQuery): { records: StoredRecord[]; done: Promise<void> } {
  const records: StoredRecord[] = [];
  const done = (async () => {
    for await (const record of client.records.since(query)) records.push(record);
  })().catch(() => {});
  return { records, done };
}

test("client: the action is called, the records arrive with no gap and no duplicate, and the subscriber continues after a restart", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The first host, and a client that calls an action of it.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();

    const clientA = await connectAsOwner(homePath);
    const echoed = await clientA.call(echo, { n: 42 });
    expect(echoed).toEqual({ n: 42 });

    // 2. The notes 1..3 are written before anybody subscribes.
    for (const n of [1, 2, 3]) {
      await clientA.emit(Note, { n });
    }

    // 3. Client B subscribes from the beginning of the journal, and collects
    //    what it receives. The subscription keeps its position, so it survives
    //    the restart of the host below.
    const clientB = await connectAsOwner(homePath);
    const { records: collected, done: subscription } = collect(clientB, { types: [Note] });
    // An unfiltered subscriber from the start sees the whole journal, core records included.
    const clientU = await connectAsOwner(homePath);
    const { records: everything, done: everythingDone } = collect(clientU);

    await eventually(
      () => collected.length >= 3,
      15_000,
      "the subscriber should have received the notes written before it connected",
    );

    // 4. The notes 4..6 are written while B is subscribed.
    for (const n of [4, 5, 6]) {
      await clientA.emit(Note, { n });
    }

    await eventually(
      () => collected.length >= 6,
      15_000,
      "the subscriber should have received the notes written while it was subscribed",
    );

    // 5. A real crash: SIGKILL, no clean shutdown.
    await first.kill();

    // 6. The host comes back on the same home.
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();

    // 7. A writes the notes 7..9 on the same client: its connection died with the host.
    for (const n of [7, 8, 9]) {
      await clientA.emit(Note, { n });
    }

    await eventually(
      () => collected.length >= 9,
      20_000,
      "the subscriber should have received the notes written after the restart",
    );

    // Everything is written: a fresh read of the journal from the start is the truth. The
    // unfiltered subscriber must hold exactly that — no gap and no duplicate, whatever the
    // restart did to its connection.
    const clientF = await connectAsOwner(homePath);
    const { records: truth, done: truthDone } = collect(clientF);
    const lastNote = collected[collected.length - 1];
    await eventually(
      () => truth.some((record) => record.id === lastNote?.id),
      15_000,
      "a fresh read should reach the last note",
    );
    await eventually(
      () => everything.length >= truth.length,
      15_000,
      "the long-lived subscriber should have caught up with the journal",
    );
    const upToLast = (records: StoredRecord[]) => records.slice(0, records.findIndex((r) => r.id === lastNote?.id) + 1);
    expect(upToLast(everything).map((record) => record.id)).toEqual(upToLast(truth).map((record) => record.id));

    // 8. The nine notes: the numbers 1..9 in order, positions strictly
    //    increasing, no record twice.
    const notes = collected.map((record) => NoteData.parse(record.data));
    expect(notes.map((note) => note.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const ids = collected.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (let i = 1; i < collected.length; i++) {
      const previous = collected[i - 1];
      const current = collected[i];
      if (!previous || !current) throw new Error("the collection has a hole in it");
      expect(current.seq).toBeGreaterThan(previous.seq);
    }

    await Promise.all([clientA, clientB, clientU, clientF].map((client) => client.close()));
    await Promise.all([subscription, everythingDone, truthDone]);
  } finally {
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("slow consumer: the subscription holds off a full queue and still delivers every record once, in order", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;
  const total = 3000; // well past the records a subscription queues for its consumer

  try {
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();
    const writer = await connectAsOwner(home.path);
    await Promise.all(Array.from({ length: total }, (_unused, n) => writer.emit(Note, { n })));

    const reader = await connectAsOwner(home.path);
    const received: StoredRecord[] = [];
    for await (const record of reader.records.since({ types: [Note] })) {
      received.push(record);
      // The first record is held for a while: the queue behind it fills and the connection is dropped.
      if (received.length === 1) await new Promise((resolve) => setTimeout(resolve, 500));
      if (received.length === total) break;
    }

    expect(new Set(received.map((record) => record.id)).size).toBe(total);
    for (let i = 1; i < received.length; i++) {
      expect(received[i]!.seq).toBeGreaterThan(received[i - 1]!.seq);
    }
    await Promise.all([writer.close(), reader.close()]);
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
