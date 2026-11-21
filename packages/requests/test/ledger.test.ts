// What the ledger reads from the journal: which request a text names, and what a fold of the facts makes of it.

import { expect, test } from "bun:test";

import { recordId, seq, streamId } from "@niwa-labs/core";
import type { JournalReader, StoredRecord } from "@niwa-labs/core";
import { owner } from "@niwa-labs/core";

import { REQUEST_TYPES, RequestCancelledRecord, RequestCreated, RequestId } from "../src/records.ts";
import { RequestLedger } from "../src/state.ts";

/** A journal that holds the records it is given: all the ledger asks of it is `since`. */
function journalOf(rows: ReadonlyArray<{ type: string; data: unknown }>): JournalReader {
  const stored = rows.map(
    (row, index): StoredRecord => ({
      id: recordId(`r${String(index + 1)}`),
      seq: seq(index + 1),
      stream: streamId("test"),
      type: row.type as StoredRecord["type"],
      schema: 1,
      data: row.data,
      actor: { kind: "host" },
      cause: null,
      root: recordId(`r${String(index + 1)}`),
      at: 0 as StoredRecord["at"],
    }),
  );
  return {
    since: (from, types) => stored.filter((one) => one.seq > from && (types === undefined || types.includes(one.type))),
  } as JournalReader;
}

const created = (id: string) => ({
  type: RequestCreated.name,
  data: { id, to: owner, question: "q.q", input: { kind: "text", title: "Which one?" } },
});

test("the full id of an ended request names it, though a longer open id starts with the same text", () => {
  const journal = journalOf([created("req-123456"), { type: RequestCancelledRecord.name, data: { id: "req-123456" } }, created("req-1234567")]);
  const ledger = new RequestLedger(REQUEST_TYPES.map((type) => type.name), () => journal);
  expect(ledger.named({ id: "req-123456" })).toBe(RequestId.parse("req-123456"));
  // A short form still prefers what is open.
  expect(ledger.named({ id: "req-12345" })).toBe(RequestId.parse("req-1234567"));
});

test("the full id of a request the caller may not see is not turned into another request", () => {
  const journal = journalOf([created("req-123456"), created("req-1234567")]);
  const ledger = new RequestLedger(REQUEST_TYPES.map((type) => type.name), () => journal);
  // Only the longer one is the caller's: the exact id still names the first, which it may not act on.
  expect(ledger.named({ id: "req-123456" }, (request) => request.id === "req-1234567")).toBe(RequestId.parse("req-123456"));
});
