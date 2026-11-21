// How the actions that end a request behave when the world moves under them: a try that is made again,
// a request that ends while a resolver works, an answer that does not fit, a deadline that passed.
// The actions run on a journal held in memory, so the order of the writes is the test's.

import { expect, test } from "bun:test";
import { z } from "zod";

import { owner, recordId, seq, streamId } from "@niwa-labs/core";
import type { ActionContext, Address, Caller, JournalReader, OperationId, RecordType, StoredRecord, Timestamp } from "@niwa-labs/core";

import { requestActions } from "../src/index.ts";
import type { Expiry } from "../src/index.ts";
import { REQUEST_TYPES, RequestAnswered, RequestCancelledRecord, RequestCreated, RequestExpiredRecord, RequestId, expiryId } from "../src/records.ts";
import { ResolverRegistry } from "../src/resolver.ts";
import type { Resolver } from "../src/resolver.ts";
import { question } from "../src/question.ts";
import { RequestLedger } from "../src/state.ts";

const run = "run:abc";
const asker: Address = { kind: "client", id: run };
const text = question("t.text", { kind: "text", title: "Say something" });

/** A journal in memory that the ledger reads and the stub context writes. */
class Memory {
  readonly rows: StoredRecord[] = [];

  readonly reader = {
    get: (id: string) => this.rows.find((row) => row.id === id),
    since: (from: number, types?: string[]) => this.rows.filter((row) => row.seq > from && (types === undefined || types.includes(row.type))),
  } as unknown as JournalReader;

  append<T>(type: RecordType<T>, data: T, id?: string, actor: StoredRecord["actor"] = { kind: "host" }): StoredRecord {
    const placed = id ?? `m${String(this.rows.length + 1)}`;
    const existing = this.rows.find((row) => row.id === placed);
    if (existing !== undefined) return existing;
    const row: StoredRecord = {
      id: recordId(placed),
      seq: seq(this.rows.length + 1),
      stream: streamId("test"),
      type: type.name,
      schema: 1,
      data,
      actor,
      cause: null,
      root: recordId(placed),
      at: 0 as Timestamp,
    };
    this.rows.push(row);
    return row;
  }

  typesOf(): string[] {
    return this.rows.map((row) => row.type);
  }
}

interface World {
  readonly memory: Memory;
  readonly time: { now: Timestamp | undefined };
  readonly actions: ReturnType<typeof requestActions>;
  /** The context of one call: its operation, and what it writes as the record of that operation. */
  context(operation: string, caller?: Caller): ActionContext;
}

function world(resolver?: Resolver): World {
  const memory = new Memory();
  const ledger = new RequestLedger(REQUEST_TYPES.map((type) => type.name), () => memory.reader);
  const resolvers = new ResolverRegistry();
  if (resolver !== undefined) resolvers.register(text, resolver);
  const time: { now: Timestamp | undefined } = { now: undefined };
  const expiry: Expiry = {
    now: () => time.now,
    expire: async (id) => {
      memory.append(RequestExpiredRecord, { id }, String(expiryId(id)));
    },
  };
  const bind = (caller: Caller): Address | undefined => (caller.kind === "client" ? (caller.id === "owner" ? owner : { kind: "client", id: caller.id }) : undefined);
  return {
    memory,
    time,
    actions: requestActions(ledger, bind, resolvers, expiry),
    context: (operation, caller = { kind: "client", id: "owner", principal: { kind: "owner", id: "owner" } } as Caller) =>
      ({
        operationId: operation as OperationId,
        caller,
        emit: async <T>(type: RecordType<T>, data: T) => memory.append(type, data, `${operation}/emit/1`, { ...caller, issuedBy: "requests" }),
      }) as unknown as ActionContext,
  };
}

const ID = RequestId.parse("req-aaaaaa");
const born = (memory: Memory, over: Partial<z.input<typeof RequestCreated.schema>> = {}): void => {
  memory.append(RequestCreated, RequestCreated.schema.parse({ id: ID, to: owner, question: text.question, input: text.input, from: asker, ...over }));
};

test("an answer by run that was written before the cut-off is found again, not refused as having no open ask", async () => {
  const w = world();
  born(w.memory);
  const first = await w.actions.answer.run({ run: "abc" as never, answer: { text: "yes" } }, w.context("op-1"));
  expect(first).toEqual({ id: ID, accepted: true });
  // The host stopped before it saved the result: the same operation is made again.
  const again = await w.actions.answer.run({ run: "abc" as never, answer: { text: "yes" } }, w.context("op-1"));
  expect(again).toEqual({ id: ID, accepted: true });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name, RequestAnswered.name]);
});

test("a cancel by run that was written before the cut-off is found again", async () => {
  const w = world();
  born(w.memory);
  await w.actions.cancel.run({ run: "abc" as never }, w.context("op-1"));
  expect(await w.actions.cancel.run({ run: "abc" as never }, w.context("op-1"))).toEqual({ id: ID });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name, RequestCancelledRecord.name]);
});

test("a resolve that answered before the cut-off says so when it is made again", async () => {
  const w = world(() => ({ answered: true, answer: { text: "from the resolver" } }));
  born(w.memory, { from: undefined });
  const resolver = w.context("op-1", { kind: "host" });
  expect(await w.actions.resolve.run({ id: ID }, resolver)).toEqual({ answered: true });
  expect(await w.actions.resolve.run({ id: ID }, resolver)).toEqual({ answered: true });
  expect(w.memory.typesOf().filter((type) => type === RequestAnswered.name)).toHaveLength(1);
});

test("a request cancelled while its resolver works is not answered afterwards", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = world(async () => {
    await held;
    return { answered: true, answer: { text: "too late" } };
  });
  born(w.memory);
  const pending = w.actions.resolve.run({ id: ID }, w.context("op-1", { kind: "host" }));
  await w.actions.cancel.run({ id: ID }, w.context("op-2"));
  release();
  expect(await pending).toEqual({ answered: false });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name, RequestCancelledRecord.name]);
});

test("an answer of a resolver that does not fit the question is not written, and the request stays open", async () => {
  const w = world(() => ({ answered: true, answer: { ids: [] } }));
  born(w.memory);
  const quiet = console.error;
  console.error = () => undefined;
  try {
    expect(await w.actions.resolve.run({ id: ID }, w.context("op-1", { kind: "host" }))).toEqual({ answered: false });
  } finally {
    console.error = quiet;
  }
  expect(w.memory.typesOf()).toEqual([RequestCreated.name]);
});

test("an answer after the deadline ends the request as expired and is not taken, before the timer runs", async () => {
  const w = world();
  born(w.memory, { deadline: 1_000 as Timestamp });
  w.time.now = 1_000 as Timestamp;
  const result = await w.actions.answer.run({ id: ID, answer: { text: "late" } }, w.context("op-1"));
  expect(result).toEqual({ id: ID, accepted: false, reason: "expired" });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name, RequestExpiredRecord.name]);
  expect(w.memory.rows[1]?.id).toBe(expiryId(ID));
});

test("a resolver that answers after the deadline passed is not taken either", async () => {
  // The time passes while the resolver works.
  const w = world(() => {
    w.time.now = 1_001 as Timestamp;
    return { answered: true, answer: { text: "late" } };
  });
  born(w.memory, { deadline: 1_000 as Timestamp });
  w.time.now = 999 as Timestamp;
  expect(await w.actions.resolve.run({ id: ID }, w.context("op-1", { kind: "host" }))).toEqual({ answered: false });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name, RequestExpiredRecord.name]);
});

test("a resolve names the request by its whole id: one that does not exist is not taken for a longer id", async () => {
  const w = world(() => ({ answered: true, answer: { text: "for whom?" } }));
  born(w.memory, { id: RequestId.parse("req-1234567") });
  expect(await w.actions.resolve.run({ id: RequestId.parse("req-123456") }, w.context("op-1", { kind: "host" }))).toEqual({ answered: false });
  expect(w.memory.typesOf()).toEqual([RequestCreated.name]);
});

test("a try made again after an answer that landed behind a cancel says it did not stand", async () => {
  const w = world();
  born(w.memory);
  w.memory.append(RequestCancelledRecord, { id: ID });
  // The answer of an earlier try of this operation was written after the cancel: the cancel is the end.
  w.memory.append(RequestAnswered, { id: ID, answer: { text: "behind" }, by: owner }, "op-1/emit/1");
  expect(await w.actions.answer.run({ id: ID, answer: { text: "behind" } }, w.context("op-1"))).toEqual({ id: ID, accepted: false, reason: "cancelled" });
  expect(await w.actions.resolve.run({ id: ID, answer: { text: "behind" } }, w.context("op-1"))).toEqual({ answered: false });
});

test("an owner-only decision can be answered only through the addressee action", async () => {
  let calls = 0;
  const w = world(() => {
    calls++;
    return { answered: true, answer: { text: "automatic" } };
  });
  born(w.memory, { answerPolicy: "owner-only" });
  expect(await w.actions.resolve.run({ id: ID }, w.context("automatic"))).toEqual({ answered: false });
  expect(await w.actions.resolve.run({ id: ID, answer: { text: "forwarded" } }, w.context("forwarded", { kind: "host" }))).toEqual({ answered: false });
  expect(calls).toBe(0);
  expect(await w.actions.answer.run({ id: ID, answer: { text: "operator" } }, w.context("operator"))).toEqual({ id: ID, accepted: true });
});
