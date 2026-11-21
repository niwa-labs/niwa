// The one-shot read of the history: `records.read`.
//
// The stream (`records.since`) never ends by itself: history, then live. A reader that wants
// the history and nothing else has to know when the history is read — a guess about a quiet
// moment, or a timeout. The read is that knowledge in the core: one request, one answer, the
// records that are committed now.
//
// What is checked here:
//
//   1. the host reads its own history: the records after a position, in commit order
//   2. the read is a one-shot: it ends, and a record written after it is not in the answer
//   3. the type filter and the limit hold
//   4. a client reads over the wire (op "read"), and the answer is the same history
//   5. the MCP tool `niwa_records_read` reads that way: it answers with the committed
//      records and returns, instead of waiting for a stream that has no end

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { jsonOf, mcpPair } from "./fixtures/mcp-pair.ts";

const Note = record("read.note", z.object({ n: z.number() }), { open: true });
const Other = record("read.other", z.object({ text: z.string() }), { open: true });

/** A host with the two record types declared, and a client connected to it. */
async function hosted() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("read", (api) => {
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

test("the host reads the history after a position, in commit order", async () => {
  const h = await hosted();
  try {
    const first = await h.niwa.emit(Note, { n: 1 });
    await h.niwa.emit(Other, { text: "between" });
    const second = await h.niwa.emit(Note, { n: 2 });

    const read = await h.niwa.records.read(seq(0));
    expect(read.map((record) => record.id)).toContain(first.id);
    expect(read.map((record) => record.id)).toContain(second.id);

    // Commit order, and the positions grow.
    for (let i = 1; i < read.length; i++) {
      expect(read[i]!.seq).toBeGreaterThan(read[i - 1]!.seq);
    }

    // Only the records after the position: the read from the last one is empty.
    const after = await h.niwa.records.read(second.seq);
    expect(after).toEqual([]);
  } finally {
    await h.close();
  }
});

test("the read ends: a record written after it is not in the answer", async () => {
  const h = await hosted();
  try {
    await h.niwa.emit(Note, { n: 1 });
    const read = await h.niwa.records.read(seq(0));
    expect(read.length).toBeGreaterThan(0);

    // The answer was made before this one: it is not in it, and a second read sees it.
    const later = await h.niwa.emit(Note, { n: 2 });
    expect(read.map((record) => record.id)).not.toContain(later.id);
    const second = await h.niwa.records.read(seq(0));
    expect(second.map((record) => record.id)).toContain(later.id);
  } finally {
    await h.close();
  }
});

test("the read filters by type and honours the limit", async () => {
  const h = await hosted();
  try {
    await h.niwa.emit(Note, { n: 1 });
    await h.niwa.emit(Other, { text: "other" });
    await h.niwa.emit(Note, { n: 2 });

    const notes = await h.niwa.records.read(seq(0), { type: Note });
    expect(notes.every((record) => record.type === Note.name)).toBe(true);
    expect(notes.length).toBe(2);

    const others = await h.niwa.records.read(seq(0), { type: Other });
    expect(others.every((record) => record.type === Other.name)).toBe(true);
    expect(others.length).toBe(1);

    const limited = await h.niwa.records.read(seq(0), { limit: 2 });
    expect(limited.length).toBe(2);

    const limitedNotes = await h.niwa.records.read(seq(0), { type: Note, limit: 1 });
    expect(limitedNotes.length).toBe(1);
  } finally {
    await h.close();
  }
});

test("a client reads the same history over the wire", async () => {
  const h = await hosted();
  try {
    const written = await h.client.emit(Note, { n: 7 });
    await h.client.emit(Other, { text: "other" });

    const read: StoredRecord[] = await h.client.records.read(seq(0));
    expect(read.map((record) => record.id)).toContain(written.id);

    const notes = await h.client.records.read(seq(0), { type: Note.name });
    expect(notes.every((record) => record.type === Note.name)).toBe(true);
    expect(notes.map((record) => record.id)).toEqual([written.id]);

    const limited = await h.client.records.read(seq(0), { limit: 1 });
    expect(limited.length).toBe(1);

    // The position is a position: nothing before it is in the answer.
    const after = await h.client.records.read(written.seq);
    expect(after.map((record) => record.id)).not.toContain(written.id);
  } finally {
    await h.close();
  }
});

test("the MCP tool reads the history and returns, without waiting for more", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("read-mcp", (api) => {
      api.declare(Note, Other);
    }),
  );
  await niwa.serve();
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;
  try {
    pair = await mcpPair(home.path);
    const writer = await connectAsOwner(home.path);
    const written = await writer.emit(Note, { n: 1 });
    await writer.emit(Other, { text: "other" });

    // The tool answers with the committed records, and it answers: it does not wait for a
    // stream that has no end.
    const started = Date.now();
    const answered = jsonOf(
      await pair.client.callTool({ name: "niwa_records_read", arguments: { from: 0 } }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    const records = (answered as { records: Array<{ id: string; type: string }> }).records;
    expect(records.map((record) => record.id)).toContain(written.id);

    // The type filter and the limit are the tool's own arguments.
    const notes = jsonOf(
      await pair.client.callTool({
        name: "niwa_records_read",
        arguments: { from: 0, types: [Note.name] },
      }),
    ) as { records: Array<{ id: string }> };
    expect(notes.records.map((record) => record.id)).toEqual([written.id]);

    const limited = jsonOf(
      await pair.client.callTool({ name: "niwa_records_read", arguments: { from: 0, limit: 1 } }),
    ) as { records: Array<{ id: string }> };
    expect(limited.records.length).toBe(1);

    await writer.close();
  } finally {
    await pair?.close();
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("a limit that is not a positive integer is refused, on the host and over the wire", async () => {
  const h = await hosted();
  try {
    await h.niwa.emit(Note, { n: 1 });
    await expect(h.niwa.records.read(seq(0), { limit: 0 })).rejects.toThrow();
    await expect(h.niwa.records.read(seq(0), { limit: -1 })).rejects.toThrow();
    await expect(h.niwa.records.read(seq(0), { limit: 1.5 })).rejects.toThrow();
    await expect(h.client.records.read(seq(0), { limit: 0 })).rejects.toThrow();
  } finally {
    await h.close();
  }
});
