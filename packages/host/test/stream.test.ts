// Observation by stream: one stream, over history and live.
//
// A subscription may name the stream it watches. What it sees is the history of that stream
// and then its live records, in order, with no gap and no duplicate — the same guarantee as by
// type.
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const Note = record("stream.note", z.object({ n: z.number() }), { open: true });
const Other = record("stream.other", z.object({ text: z.string() }), { open: true });

/** A host with the two record types declared, and a client connected to it. */
async function hosted() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("stream", (api) => {
      api.declare(Note, Other);
    }),
  );
  await niwa.serve();
  const client = await connectAsOwner(home.path);
  return {
    niwa,
    client,
    close: async () => {
      await client.close().catch(() => {});
      await niwa.close();
      await home.cleanup();
    },
  };
}

test("a subscription by stream sees that stream only, over history and live", async () => {
  const h = await hosted();
  try {
    const first = await h.niwa.emit(Note, { n: 1 });
    const other = await h.niwa.emit(Other, { text: "other" });
    const second = await h.niwa.emit(Note, { n: 2 });
    // Two record types are two streams: the records of one are not the records of the other.
    expect(other.stream).not.toBe(first.stream);
    const stream = first.stream;

    const seen: StoredRecord[] = [];
    const collecting = (async () => {
      for await (const record of h.client.records.since({ stream })) {
        seen.push(record);
        if (seen.length >= 4) break;
      }
    })();

    // The history of the stream comes first: the two notes that were written.
    await eventually(() => seen.length >= 2, 5_000, "the history of the stream did not come");
    expect(seen.map((record) => record.id)).toEqual([first.id, second.id]);

    // Then the live records of the same stream, and nothing of the other one.
    await h.niwa.emit(Note, { n: 3 });
    await h.niwa.emit(Other, { text: "other again" });
    await h.niwa.emit(Note, { n: 4 });
    await eventually(() => seen.length >= 4, 5_000, "the live records of the stream did not come");
    await collecting;

    // Exactly one stream, in order, no gap and no duplicate.
    expect(seen.every((record) => record.stream === stream)).toBe(true);
    expect(new Set(seen.map((record) => record.id)).size).toBe(seen.length);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]!.seq).toBeGreaterThan(seen[index - 1]!.seq);
    }
    // What the journal holds of that stream is what was seen: nothing was lost.
    const truth = await h.niwa.records.read({ stream });
    expect(seen.map((record) => record.id)).toEqual(truth.map((record) => record.id));
  } finally {
    await h.close();
  }
});

test("the host filters its own subscription by stream too", async () => {
  const h = await hosted();
  try {
    const note = await h.niwa.emit(Note, { n: 1 });
    await h.niwa.emit(Other, { text: "other" });
    await h.niwa.emit(Note, { n: 2 });

    const seen: StoredRecord[] = [];
    for await (const record of h.niwa.records.since({ stream: note.stream })) {
      seen.push(record);
      if (seen.length >= 2) break;
    }
    expect(seen.length).toBe(2);
    expect(seen.every((record) => record.stream === note.stream)).toBe(true);
  } finally {
    await h.close();
  }
});

test("the read over the wire carries the stream and the types", async () => {
  const h = await hosted();
  try {
    const note = await h.client.emit(Note, { n: 1 });
    await h.client.emit(Other, { text: "other" });
    const second = await h.client.emit(Note, { n: 2 });

    // The stream of the wire's read op: the records of that stream only.
    const ofStream = await h.client.records.read({ stream: note.stream });
    expect(ofStream.every((record) => record.stream === note.stream)).toBe(true);
    expect(ofStream.map((record) => record.id)).toEqual([note.id, second.id]);

    // The types of the wire's read op: several types at once.
    const ofTypes = await h.client.records.read({ types: [Note.name, Other.name] });
    expect(ofTypes.map((record) => record.type)).toEqual([Note.name, Other.name, Note.name]);

    // The stream and the types together.
    const both = await h.client.records.read({ types: [Note.name], stream: note.stream });
    expect(both.map((record) => record.id)).toEqual([note.id, second.id]);
  } finally {
    await h.close();
  }
});

test("a type and a stream together: both must match, in history and live", async () => {
  const h = await hosted();
  try {
    const note = await h.niwa.emit(Note, { n: 1 });
    await h.niwa.emit(Other, { text: "other" });

    const seen: StoredRecord[] = [];
    const collecting = (async () => {
      for await (const record of h.client.records.since({ types: [Note], stream: note.stream })) {
        seen.push(record);
      }
    })();
    await eventually(() => seen.length >= 1, 5_000, "the history did not come");
    await h.niwa.emit(Other, { text: "other again" });
    const live = await h.niwa.emit(Note, { n: 2 });
    await eventually(() => seen.length >= 2, 5_000, "the live record did not come");
    expect(seen.map((record) => record.id)).toEqual([note.id, live.id]);

    // A type of one stream with the stream of another matches nothing.
    const none = await h.niwa.records.read({ types: [Other], stream: note.stream });
    expect(none).toEqual([]);
    void collecting;
  } finally {
    await h.close();
  }
});
