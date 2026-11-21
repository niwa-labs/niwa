// Repeated write.
//
// The scenario runs against a real host process (fixtures/repeated-write-host.ts):
//
//   1. spawn the host, connect a client
//   2. write Note { n: 1 } with the explicit id "repeated-write.note.1"; the record is
//      committed
//   3. write the same id with the same content: the record that is already
//      committed comes back — the same id, the same position, and nothing new
//      in the journal
//   4. write the same id with different content: the write is refused with an
//      integrity error
//   5. the journal is unchanged: the record still holds the first content, and
//      no record was added (a sentinel record written last marks the end)
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { Note } from "./fixtures/repeated-write-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/repeated-write-host.ts", import.meta.url));

/** The explicit id the test writes under. */
const ID = "repeated-write.note.1";

/** From the beginning of the journal. */
const FROM_START = seq(0);

/**
 * The code of a refused write.
 *
 * The host names its refusals by the class of the error, so the code is what says that the
 * refusal was an integrity error — whether the refusal arrived as the typed error or as the
 * host's own error carrying that name.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

test("repeated write: the same id with the same content returns the existing record, and different content is an integrity error", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The host and a client.
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);

    // 2. The first write of that id commits a record.
    const first = await client.emit(Note, { n: 1 }, { id: ID });
    expect(first.id).toBe(ID as unknown as typeof first.id);
    expect(first.data).toEqual({ n: 1 });

    // The journal holds exactly one record of that type.
    const seen: StoredRecord[] = [];
    const watcher = await connectAsOwner(homePath);
    const watch = (async () => {
      for await (const record of watcher.records.since()) {
        seen.push(record);
      }
    })().catch(() => {});
    const notes = () => seen.filter((record) => record.type === Note.name);
    await eventually(() => notes().length === 1, 10_000, "the first write should be in the journal");

    // 3. The same id with the same content: the record that is already there
    //    comes back, and nothing is written.
    const second = await client.emit(Note, { n: 1 }, { id: ID });
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(second.data).toEqual({ n: 1 });

    // 4. The same id with different content: the write is refused.
    let refused: unknown;
    try {
      await client.emit(Note, { n: 2 }, { id: ID });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(codeOf(refused)).toBe("IntegrityError");
    expect((refused as Error).message).toContain(ID);

    // 5. Nothing changed: the record still holds the first content, and neither
    //    repeated write added a record. A sentinel written last is observed after
    //    anything the earlier writes could have added, so the journal is complete
    //    when it arrives.
    const sentinel = await client.emit(Note, { n: 3 }, { id: "repeated-write.note.sentinel" });
    await eventually(
      () => seen.some((record) => record.id === sentinel.id),
      10_000,
      "the sentinel should be in the journal",
    );
    expect(notes().map((record) => record.id)).toEqual([first.id, sentinel.id]);
    expect(notes()[0]?.data).toEqual({ n: 1 });
    expect(notes()[0]?.seq).toBe(first.seq);

    // The record is still readable under its id, unchanged.
    const traced = await client.trace(first.id);
    expect(traced[0]?.data).toEqual({ n: 1 });

    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
