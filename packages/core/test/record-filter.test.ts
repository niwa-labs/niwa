// The run filter of a read of the journal: a follow reads again after every commit, so what it
// pays must be the new records and not the whole journal, and the answer must be the same as a
// read of the whole journal would give.

import { expect, test } from "bun:test";

import type { JournalReader, StoredRecord } from "../src/index.ts";
import { readFiltered, recordId, recordTypeName, seq, streamId, timestamp } from "../src/index.ts";

/** A journal in memory that counts the records its reads hand out. */
function journalOf() {
  const records: StoredRecord[] = [];
  let handedOut = 0;
  const reader: JournalReader = {
    get: (id) => records.find((record) => record.id === id),
    since: (from, types, limit) => {
      const rows = records.filter((record) => record.seq > from && (types === undefined || types.includes(record.type)));
      const chunk = limit === undefined ? rows : rows.slice(0, limit);
      handedOut += chunk.length;
      return chunk;
    },
    find: (query) => records.filter((record) => record.type === query.type),
    last: () => seq(records.length),
  };
  const add = (type: string, data: object, root?: StoredRecord["root"]): StoredRecord => {
    const n = records.length + 1;
    const id = recordId(`r${n}`);
    const record: StoredRecord = {
      id,
      seq: seq(n),
      stream: streamId("s"),
      type: recordTypeName(type),
      schema: 1,
      data,
      actor: { kind: "host" },
      cause: null,
      root: root ?? id,
      at: timestamp(n),
    };
    records.push(record);
    return record;
  };
  return { reader, add, handed: () => handedOut, reset: () => (handedOut = 0) };
}

const ids = (rows: readonly StoredRecord[]): string[] => rows.map((row) => row.id);

test("a follow of a run reads only what is new, and still finds what grew from the run", () => {
  const { reader, add, handed, reset } = journalOf();
  const start = add("run.requested", { run: "run_a" });
  const opened = add("session.started", { session: "s1" }, start.root);
  for (let n = 0; n < 3000; n += 1) add("noise.tick", { n });

  const first = readFiltered(reader, seq(0), { run: "run_a" }, {});
  expect(ids(first.records)).toEqual([start.id, opened.id]);
  expect(handed()).toBeGreaterThanOrEqual(3000);

  // Later records: of the run's chain, of its session from another chain, of nothing it owns.
  const step = add("run.step", { n: 1 }, start.root);
  const strangerSession = add("session.turn-started", { session: "s1", turn: 1 });
  const unrelated = add("noise.tick", { n: -1 });
  const strangerSessionOther = add("session.turn-started", { session: "s2", turn: 1 });

  reset();
  const more = readFiltered(reader, first.next, { run: "run_a" }, {});
  expect(ids(more.records)).toEqual([step.id, strangerSession.id]);
  expect(more.records).not.toContain(unrelated);
  expect(more.records).not.toContain(strangerSessionOther);
  // Four new records are read, and the 3000 before them are not read again.
  expect(handed()).toBeLessThan(20);

  // A read with nothing new reads nothing.
  reset();
  const none = readFiltered(reader, more.next, { run: "run_a" }, {});
  expect(none.records).toEqual([]);
  expect(handed()).toBeLessThan(5);
});

test("a chain met late brings in what it had written before the run was named", () => {
  const { reader, add } = journalOf();
  add("noise.tick", { n: 0 });
  const first = readFiltered(reader, seq(0), { run: "run_late" }, {});
  expect(first.records).toEqual([]);

  // The chain starts with a request, and only its later record names the run.
  const head = add("request.created", { id: "req_1" });
  const early = add("session.started", { session: "s9" }, head.root);
  const named = add("run.requested", { run: "run_late" }, head.root);
  // Something about the session and the request, written by another chain, is the run's too.
  const turn = add("session.turn-started", { session: "s9", turn: 1 });
  const answer = add("request.answered", { request: "req_1" });
  const other = add("session.turn-started", { session: "s10", turn: 1 });

  const found = readFiltered(reader, first.next, { run: "run_late" }, {});
  expect(ids(found.records)).toEqual([head.id, early.id, named.id, turn.id, answer.id]);
  expect(found.records).not.toContain(other);

  // The whole journal read at once, with no closure kept, says the same.
  expect(ids(readFiltered({ ...reader }, seq(0), { run: "run_late" }, {}).records)).toEqual(ids(found.records));
});

test("a read made at a position before the closure reached sees only what was there", () => {
  const { reader, add } = journalOf();
  const start = add("run.requested", { run: "run_p" });
  const early = add("session.started", { session: "s1" }, start.root);
  const later = add("session.turn-started", { session: "s1", turn: 1 });

  expect(ids(readFiltered(reader, seq(0), { run: "run_p" }, {}).records)).toEqual([start.id, early.id, later.id]);
  // Until the second record: the third, which the run grew into after, is not in the read.
  expect(ids(readFiltered(reader, seq(0), { run: "run_p", until: early.seq }, {}).records)).toEqual([start.id, early.id]);
  // And the closure that was kept is still whole for the next read.
  expect(ids(readFiltered(reader, seq(0), { run: "run_p" }, {}).records)).toEqual([start.id, early.id, later.id]);
});
