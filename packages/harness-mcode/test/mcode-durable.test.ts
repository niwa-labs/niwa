// The MiniMax Code reading side against the durable history: a session whose journal is empty
// (it is not adopted yet) keeps its history in `durable-history/sessions.g1.db`.
//
// The database is built here the way the harness builds it: batches of entries, each payload an
// `MZS2` header, a codec byte and a compressed JSON array.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { Locator, SessionRecord } from "@niwa-labs/harness";

import { McodeReading } from "../src/mcode/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";

let home: string;
let db: Database;
let nextBatch = 1;
let nextSeq = 1;
let uid = 0;
const reading = () => new McodeReading({ harness: harnessId("mcode-test"), home });

beforeEach(() => {
  home = tempDirSync("mcode-durable");
  mkdirSync(join(home, "durable-history"), { recursive: true });
  db = new Database(join(home, "durable-history", "sessions.g1.db"));
  db.run("create table batches (batch_id integer primary key, created_ms integer not null, compressed integer not null, payload blob not null)");
  db.run("create table entries (entry_id text primary key, seq integer not null, ordinal integer not null, batch_id integer not null)");
  nextBatch = 1;
  nextSeq = 1;
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly payload: object;
}

/** A batch of entries, encoded as the harness encodes it. */
function putBatch(entries: Entry[], codec: 1 | 2 = 1): void {
  const json = Buffer.from(JSON.stringify(entries.map((e) => ({ ...e, parentId: null }))));
  const frame = codec === 1 ? Buffer.from(Bun.zstdCompressSync(json)) : gzipSync(json);
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = codec;
  header.writeBigUInt64BE(BigInt(json.length), 5);
  header.writeBigUInt64BE(BigInt(frame.length), 13);
  const batch = nextBatch++;
  db.run("insert into batches values (?, ?, 1, ?)", [batch, 0, Buffer.concat([header, frame])]);
  for (const [ordinal, entry] of entries.entries()) {
    db.run("insert into entries values (?, ?, ?, ?)", [entry.id, nextSeq++, ordinal, batch]);
  }
}

const envelope = (messageId: string, message: object) => ({ message_id: messageId, turn_id: "t1", message });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1000 });
const assistant = (text: string, call?: { id: string; name: string }) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    ...(call === undefined ? [] : [{ type: "toolCall", id: call.id, name: call.name, arguments: { a: 1 } }]),
  ],
  timestamp: 2000,
});
const toolResult = (callId: string, text: string) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: "bash",
  content: [{ type: "text", text }],
  timestamp: 3000,
});

const full = (native: string, reason: string, envelopes: object[]): Entry => ({
  id: `${native}|full|${reason}|sha256:${uid++}`,
  kind: "history.v1.full",
  payload: { sessionId: native, reason, envelopes },
});
const append = (native: string, envelopes: object[]): Entry => ({
  id: `${native}|turn:history:${uid++}|x`,
  kind: "history.v1.append",
  payload: { sessionId: native, turnId: "t1", operationId: "op", envelopes },
});

/** A session directory with the manifest and an empty journal. */
function sessionDir(native: string, journal?: string): string {
  const encoded = Buffer.from(native).toString("base64url");
  const dir = join(home, "v2", "sessions", "2026", "11", "01", `12-00-00-000-session_${encoded}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ sessionId: native, createdAtMs: 1000, updatedAtMs: 2000 }));
  if (journal !== undefined) writeFileSync(join(dir, "messages.jsonl"), journal);
  return dir;
}

const id = (native: string) => sessionId(harnessId("mcode-test"), native);

async function all(native: string, from?: Locator): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const record of reading().read(id(native), from)) out.push(record);
  return out;
}

test("a session with an empty journal is read from the durable history: full, then appends, by role", async () => {
  sessionDir("mvs_a", "");
  putBatch([
    full("mvs_a", "seed", [envelope("m1", user("hello"))]),
    append("mvs_a", [envelope("m2", assistant("calling", { id: "c1", name: "bash" }))]),
  ]);
  putBatch([append("mvs_a", [envelope("m3", toolResult("c1", "done"))])], 2);
  const records = await all("mvs_a");
  expect(records.map((r) => r.kind)).toEqual(["user", "assistant", "tool-call", "tool-result"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "hello" });
  expect(records[2]).toMatchObject({ kind: "tool-call", callId: "c1", name: "bash" });
  expect(records[3]).toMatchObject({ kind: "tool-result", callId: "c1", output: "done", ok: true });
});

test("the active view is the last full and the appends after it, a message once", async () => {
  sessionDir("mvs_b", "");
  putBatch([
    full("mvs_b", "seed", [envelope("old", user("before the adopt"))]),
    append("mvs_b", [envelope("old2", user("also before"))]),
    full("mvs_b", "adopt", [envelope("m1", user("one")), envelope("m2", assistant("two"))]),
    append("mvs_b", [envelope("m2", assistant("two")), envelope("m3", user("three"))]),
  ]);
  const records = await all("mvs_b");
  expect(records.map((r) => (r.kind === "user" || r.kind === "assistant" ? r.text : r.kind))).toEqual([
    "one",
    "two",
    "three",
  ]);
});

test("a non-empty journal wins over the durable history", async () => {
  const line = JSON.stringify(envelope("j1", user("from the journal")));
  sessionDir("mvs_c", `${line}\n`);
  putBatch([full("mvs_c", "adopt", [envelope("m1", user("from the db"))])]);
  const records = await all("mvs_c");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ text: "from the journal" });
});

test("a read resumes after a locator; a locator of a replaced history starts over", async () => {
  sessionDir("mvs_d", "");
  putBatch([
    full("mvs_d", "seed", [envelope("m1", user("one"))]),
    append("mvs_d", [envelope("m2", assistant("two", { id: "c1", name: "bash" }))]),
  ]);
  const first = await all("mvs_d");
  expect(first.map((r) => r.kind)).toEqual(["user", "assistant", "tool-call"]);
  expect(first[0]?.locator.startsWith("mcode-db:v1:")).toBe(true);

  // After the first record: the rest. After the assistant text: the call of that envelope.
  expect((await all("mvs_d", first[0]!.locator)).map((r) => r.kind)).toEqual(["assistant", "tool-call"]);
  expect((await all("mvs_d", first[1]!.locator)).map((r) => r.kind)).toEqual(["tool-call"]);
  expect(await all("mvs_d", first[2]!.locator)).toEqual([]);

  // New messages arrive: only they come after the last locator.
  putBatch([append("mvs_d", [envelope("m3", user("three"))])]);
  const fresh = await all("mvs_d", first[2]!.locator);
  expect(fresh.map((r) => r.kind)).toEqual(["user"]);

  // The history is replaced and no longer holds that message: the read starts over.
  putBatch([full("mvs_d", "adopt", [envelope("n1", user("new"))])]);
  expect((await all("mvs_d", first[2]!.locator)).map((r) => r.kind)).toEqual(["user"]);
});

test("raw gives the envelope whole, and coverage follows the locator", async () => {
  sessionDir("mvs_e", "");
  putBatch([full("mvs_e", "seed", [envelope("m1", user("one"))])]);
  const [record] = await all("mvs_e");
  const raw = (await reading().raw(id("mvs_e"), record!.locator)) as { message_id: string };
  expect(raw.message_id).toBe("m1");
  expect(await reading().coverage(id("mvs_e"))).toMatchObject({ status: "not-scanned" });
  expect(await reading().coverage(id("mvs_e"), record!.locator)).toMatchObject({ status: "empty" });
  await expect(reading().raw(id("mvs_e"), "mcode-db:v1:1:0:0:1:nope" as Locator)).rejects.toThrow("no record");
});

test("the listing finds a session by its manifest, with its working directory from the preamble", async () => {
  sessionDir("mvs_f", "");
  const preamble = "<agent-context>\nYOUR WORKSPACE DIRECTORY: /work/db\n</agent-context>\nhi";
  putBatch([full("mvs_f", "seed", [envelope("m1", user(preamble))])]);
  const listed: Array<{ native: string; cwd?: string }> = [];
  for await (const info of reading().list()) listed.push({ native: info.id.native, ...(info.cwd === undefined ? {} : { cwd: info.cwd }) });
  expect(listed).toEqual([{ native: "mvs_f", cwd: "/work/db" }]);
});

test("a session only in the database is listed and read; a filter leaves it out", async () => {
  putBatch([full("mvs_only", "seed", [envelope("m1", user("lonely"))])]);
  const listed: string[] = [];
  for await (const info of reading().list()) listed.push(info.id.native);
  expect(listed).toEqual(["mvs_only"]);
  expect((await all("mvs_only")).map((r) => r.kind)).toEqual(["user"]);
  const filtered: string[] = [];
  for await (const info of reading().list({ cwd: "/x" })) filtered.push(info.id.native);
  expect(filtered).toEqual([]);
});

test("without a database nothing changes: an empty journal and no ledger holds nothing", async () => {
  db.close();
  rmSync(join(home, "durable-history"), { recursive: true });
  sessionDir("mvs_g", "");
  expect(await all("mvs_g")).toEqual([]);
  db = new Database(":memory:");
});

test("a home without durable-history reads exactly as before: the ledger when there is one, else nothing", async () => {
  db.close();
  rmSync(join(home, "durable-history"), { recursive: true });
  const dir = sessionDir("mvs_h", "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    `${JSON.stringify({
      kind: "message.pi_history_appended",
      sessionId: "mvs_h",
      messages: [user("from the ledger")],
      seq: 1,
    })}\n`,
  );
  const records = await all("mvs_h");
  expect(records.map((r) => r.kind)).toEqual(["user"]);
  expect(records[0]?.locator.startsWith("mcode-ledger:")).toBe(true);
  db = new Database(":memory:");
});

test("a corrupt database file does not throw out of the reader: the session reads as it did without it", async () => {
  db.close();
  writeFileSync(join(home, "durable-history", "sessions.g1.db"), "this is not a sqlite database at all".repeat(40));
  sessionDir("mvs_i", "");
  const warn = console.warn;
  const told: string[] = [];
  console.warn = (...args: unknown[]) => void told.push(args.join(" "));
  try {
    expect(await all("mvs_i")).toEqual([]);
    const listed: string[] = [];
    for await (const info of reading().list()) listed.push(info.id.native);
    expect(listed).toEqual(["mvs_i"]);
    expect(await reading().coverage(id("mvs_i"))).toMatchObject({ status: "empty" });
  } finally {
    console.warn = warn;
  }
  expect(told.length).toBeLessThanOrEqual(1);
  db = new Database(":memory:");
});

test("a database with the wrong tables, or a batch that cannot be decoded, falls back to the ledger", async () => {
  db.close();
  const path = join(home, "durable-history", "sessions.g1.db");
  rmSync(path);
  const bad = new Database(path);
  bad.run("create table entries (entry_id text primary key, seq integer, ordinal integer, batch_id integer)");
  bad.run("insert into entries values ('mvs_j|full|seed|x', 1, 0, 1)");
  bad.close();
  const dir = sessionDir("mvs_j", "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    `${JSON.stringify({ kind: "message.pi_history_appended", sessionId: "mvs_j", messages: [user("ledger")], seq: 1 })}\n`,
  );
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    expect((await all("mvs_j")).map((r) => r.kind)).toEqual(["user"]);
  } finally {
    console.warn = warn;
  }

  // A batch with an unknown codec: the table is there, the payload is not readable.
  rmSync(path);
  const odd = new Database(path);
  odd.run("create table batches (batch_id integer primary key, created_ms integer, compressed integer, payload blob)");
  odd.run("create table entries (entry_id text primary key, seq integer, ordinal integer, batch_id integer)");
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = 9;
  odd.run("insert into batches values (1, 0, 1, ?)", [Buffer.concat([header, Buffer.from("zz")])]);
  odd.run("insert into entries values ('mvs_j|full|seed|y', 1, 0, 1)");
  odd.close();
  console.warn = () => undefined;
  try {
    expect((await all("mvs_j")).map((r) => r.kind)).toEqual(["user"]);
  } finally {
    console.warn = warn;
  }
  db = new Database(":memory:");
});

/** Silences (and counts) what the reader tells about a database it cannot use. */
async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; told: string[] }> {
  const warn = console.warn;
  const told: string[] = [];
  console.warn = (...args: unknown[]) => void told.push(args.join(" "));
  try {
    return { result: await run(), told };
  } finally {
    console.warn = warn;
  }
}

const texts = (records: SessionRecord[]) =>
  records.map((r) => (r.kind === "user" || r.kind === "assistant" ? r.text : r.kind));

test("an adopt that keeps the message ids replaces the full: a locator given before it resumes with no repeats", async () => {
  sessionDir("mvs_k", "");
  putBatch([
    full("mvs_k", "seed", [envelope("m1", user("one")), envelope("m2", assistant("two"))]),
    append("mvs_k", [envelope("m3", user("three"))]),
  ]);
  const before = await all("mvs_k");
  const last = before[before.length - 1]!.locator;
  // The adopt states the history again, with the same ids, and a message after it.
  putBatch([
    full("mvs_k", "adopt", [envelope("m1", user("one")), envelope("m2", assistant("two")), envelope("m3", user("three"))]),
    append("mvs_k", [envelope("m4", assistant("four"))]),
  ]);
  expect(texts(await all("mvs_k", last))).toEqual(["four"]);
  expect(texts(await all("mvs_k", before[0]!.locator))).toEqual(["two", "three", "four"]);
});

test("a session in the database only, and its journal that appears later: db locators carry over without repeats", async () => {
  const dir = sessionDir("mvs_l", "");
  putBatch([
    full("mvs_l", "seed", [envelope("m1", user("one"))]),
    append("mvs_l", [envelope("m2", assistant("two", { id: "c1", name: "bash" }))]),
  ]);
  const before = await all("mvs_l");
  expect(before.map((r) => r.kind)).toEqual(["user", "assistant", "tool-call"]);

  // The session is adopted: its journal now holds the history, and one message more.
  const lines = [
    envelope("m1", user("one")),
    envelope("m2", assistant("two", { id: "c1", name: "bash" })),
    envelope("m3", toolResult("c1", "done")),
  ];
  writeFileSync(join(dir, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const afterText = await all("mvs_l", before[1]!.locator); // the text of m2 was delivered, its call was not
  expect(afterText.map((r) => r.kind)).toEqual(["tool-call", "tool-result"]);
  expect(afterText[0]!.locator.startsWith("mcode:v1:")).toBe(true);
  expect((await all("mvs_l", before[2]!.locator)).map((r) => r.kind)).toEqual(["tool-result"]);

  // The same locator still gives the envelope whole, and coverage counts what is not delivered.
  const raw = (await reading().raw(id("mvs_l"), before[0]!.locator)) as { message_id: string };
  expect(raw.message_id).toBe("m1");
  expect(await reading().coverage(id("mvs_l"), before[2]!.locator)).toMatchObject({ status: "not-scanned" });
  const done = (await all("mvs_l")).pop()!;
  expect(await reading().coverage(id("mvs_l"), done.locator)).toMatchObject({ status: "empty" });

  // A message the journal does not hold starts the read over, as a rewritten file does.
  const unknown = "mcode-db:v1:9:0:0:1:nowhere" as Locator;
  expect(texts(await all("mvs_l", unknown))).toEqual(["one", "two", "tool-call", "tool-result"]);
});

test("the active view does not take the entries of a session whose id starts the same", async () => {
  sessionDir("mvs_n", "");
  putBatch([
    full("mvs_n", "seed", [envelope("m1", user("n"))]),
    full("mvs_nn", "seed", [envelope("x1", user("nn"))]),
    full("mvs_n0", "seed", [envelope("y1", user("n0"))]),
  ]);
  expect(texts(await all("mvs_n"))).toEqual(["n"]);
  expect(texts(await all("mvs_nn"))).toEqual(["nn"]);
  const listed: string[] = [];
  for await (const info of reading().list()) listed.push(info.id.native);
  expect(listed.sort()).toEqual(["mvs_n", "mvs_n0", "mvs_nn"]);
});

test("unknown kinds, entries that are not objects and envelopes of no shape do not throw", async () => {
  sessionDir("mvs_o", "");
  const json = Buffer.from(
    JSON.stringify([
      { id: "mvs_o|odd|1", parentId: null, kind: "tool.offload.v1", payload: { blob: "x".repeat(10) } },
      null,
      { id: "mvs_o|full|seed|z", parentId: null, kind: "history.v1.full", payload: { envelopes: [null, 7, "s", { message_id: "a" }, envelope("m1", user("ok"))] } },
      { id: "mvs_o|next|1", parentId: null, kind: "history.v1.append", payload: null },
      { id: "mvs_o|next|2", parentId: null, kind: "history.v1.append", payload: { envelopes: "no" } },
    ]),
  );
  const frame = Buffer.from(Bun.zstdCompressSync(json));
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = 1;
  header.writeBigUInt64BE(BigInt(json.length), 5);
  header.writeBigUInt64BE(BigInt(frame.length), 13);
  db.run("insert into batches values (1, 0, 1, ?)", [Buffer.concat([header, frame])]);
  for (let ordinal = 0; ordinal < 5; ordinal++) {
    db.run("insert into entries values (?, ?, ?, 1)", [`mvs_o|e${ordinal}`, ordinal + 1, ordinal]);
  }
  const { result, told } = await quietly(() => all("mvs_o"));
  expect(told).toEqual([]);
  expect(result.map((r) => r.kind)).toEqual(["unknown", "unknown", "unknown", "unknown", "user"]);
});

test("a runtime whose Bun has no zstd decoder still reads the batches", async () => {
  sessionDir("mvs_p", "");
  putBatch([full("mvs_p", "seed", [envelope("m1", user("zstd"))])]);
  const bun = Bun as unknown as { zstdDecompressSync?: unknown };
  const saved = bun.zstdDecompressSync;
  bun.zstdDecompressSync = undefined;
  try {
    expect(texts(await all("mvs_p"))).toEqual(["zstd"]);
  } finally {
    bun.zstdDecompressSync = saved;
  }
});

test("a batch that claims to be enormous is refused, not inflated: the session reads as it did without the database", async () => {
  const dir = sessionDir("mvs_q", "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    `${JSON.stringify({ kind: "message.pi_history_appended", sessionId: "mvs_q", messages: [user("ledger")], seq: 1 })}\n`,
  );
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = 1;
  header.writeBigUInt64BE(1n << 40n, 5);
  db.run("insert into batches values (1, 0, 1, ?)", [Buffer.concat([header, Buffer.from("not a frame")])]);
  db.run("insert into entries values ('mvs_q|full|seed|h', 1, 0, 1)");
  const { result, told } = await quietly(() => all("mvs_q"));
  expect(result.map((r) => r.kind)).toEqual(["user"]);
  expect(result[0]!.locator.startsWith("mcode-ledger:")).toBe(true);
  expect(told.join()).toContain("larger than it may be");
});

test("a batch whose header claims little but inflates past the cap is refused, zstd and gzip alike", async () => {
  const dir = sessionDir("mvs_lie", "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    `${JSON.stringify({ kind: "message.pi_history_appended", sessionId: "mvs_lie", messages: [user("ledger")], seq: 1 })}\n`,
  );
  // Valid JSON (an empty array) padded with blanks: without the cap it would read as an empty history.
  const huge = Buffer.alloc(256 * 1024 * 1024 + 16, 0x20);
  huge[0] = 0x5b;
  huge[huge.length - 1] = 0x5d;
  for (const [codec, frame] of [
    [1, Buffer.from(Bun.zstdCompressSync(huge))],
    [2, gzipSync(huge)],
  ] as const) {
    const header = Buffer.alloc(21);
    header.write("MZS2", 0, "latin1");
    header[4] = codec;
    header.writeBigUInt64BE(10n, 5);
    db.run("delete from entries");
    db.run("delete from batches");
    db.run("insert into batches values (1, 0, 1, ?)", [Buffer.concat([header, frame])]);
    db.run("insert into entries values ('mvs_lie|full|seed|h', 1, 0, 1)");
    const { result } = await quietly(() => all("mvs_lie"));
    expect(result.map((r) => r.kind)).toEqual(["user"]);
    expect(result[0]!.locator.startsWith("mcode-ledger:")).toBe(true);
  }
});

test("a database locked by a writer is not a failure of the reader: it reads as without the database", async () => {
  sessionDir("mvs_r", "");
  putBatch([full("mvs_r", "seed", [envelope("m1", user("held"))])]);
  expect(texts(await all("mvs_r"))).toEqual(["held"]);
  db.run("begin exclusive");
  try {
    const { result } = await quietly(async () => {
      const records = await all("mvs_r");
      const listed: string[] = [];
      for await (const info of reading().list()) listed.push(info.id.native);
      return { records, listed, coverage: await reading().coverage(id("mvs_r")) };
    });
    expect(result.records).toEqual([]);
    expect(result.listed).toEqual(["mvs_r"]);
    expect(result.coverage).toMatchObject({ status: "empty" });
  } finally {
    db.run("rollback");
  }
  expect(texts(await all("mvs_r"))).toEqual(["held"]);
});

test("a database in WAL mode, with a write in flight, shows the committed state and takes no lock", async () => {
  sessionDir("mvs_s", "");
  db.run("pragma journal_mode = wal");
  putBatch([full("mvs_s", "seed", [envelope("m1", user("committed"))])]);
  db.run("begin");
  putBatch([append("mvs_s", [envelope("m2", user("in flight"))])]);
  expect(texts(await all("mvs_s"))).toEqual(["committed"]);
  // The writer is not held up by the reader: it commits, and the next read sees it.
  db.run("commit");
  expect(texts(await all("mvs_s"))).toEqual(["committed", "in flight"]);
  expect(db.query("pragma wal_checkpoint(passive)").get()).toBeDefined();
});

test("the listing takes the working directory from the head of the history, not by decoding all of it", async () => {
  sessionDir("mvs_t", "");
  const preamble = "<agent-context>\nYOUR WORKSPACE DIRECTORY: /work/head\n</agent-context>\nhi";
  putBatch([full("mvs_t", "seed", [envelope("m1", user(preamble))])]);
  // A later batch that could not be decoded: the listing never reaches it.
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = 9;
  db.run("insert into batches values (50, 0, 1, ?)", [header]);
  db.run("insert into entries values ('mvs_t|turn:history:late|x', 99, 0, 50)");
  const { result, told } = await quietly(async () => {
    const listed: Array<{ native: string; cwd?: string }> = [];
    for await (const info of reading().list()) listed.push({ native: info.id.native, ...(info.cwd === undefined ? {} : { cwd: info.cwd }) });
    return listed;
  });
  expect(result).toEqual([{ native: "mvs_t", cwd: "/work/head" }]);
  expect(told).toEqual([]);
});

test("reading never writes to the database", async () => {
  sessionDir("mvs_u", "");
  putBatch([full("mvs_u", "seed", [envelope("m1", user("same"))])]);
  const path = join(home, "durable-history", "sessions.g1.db");
  const hash = () => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  const before = hash();
  await all("mvs_u");
  for await (const _ of reading().list()) void _;
  await reading().coverage(id("mvs_u"));
  expect(hash()).toBe(before);
});

test("the look at the head ends at the first human message: a history with no preamble is not decoded to its end", async () => {
  sessionDir("mvs_v", "");
  putBatch([full("mvs_v", "seed", [envelope("m1", user("no preamble here"))])]);
  const header = Buffer.alloc(21);
  header.write("MZS2", 0, "latin1");
  header[4] = 9;
  db.run("insert into batches values (50, 0, 1, ?)", [header]);
  db.run("insert into entries values ('mvs_v|turn:history:late|x', 99, 0, 50)");
  const { result, told } = await quietly(async () => {
    const listed: string[] = [];
    for await (const info of reading().list()) listed.push(info.id.native);
    return listed;
  });
  expect(result).toEqual(["mvs_v"]);
  expect(told).toEqual([]);
});

test("a database that cannot be read after a db locator was given: the session falls back with no locator error", async () => {
  const dir = sessionDir("mvs_w", "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    `${JSON.stringify({ kind: "message.pi_history_appended", sessionId: "mvs_w", messages: [user("ledger")], seq: 1 })}\n`,
  );
  putBatch([full("mvs_w", "seed", [envelope("m1", user("one"))])]);
  const [first] = await all("mvs_w");
  db.close();
  writeFileSync(join(home, "durable-history", "sessions.g1.db"), "garbage".repeat(500));
  const { result } = await quietly(async () => ({
    records: await all("mvs_w", first!.locator),
    coverage: await reading().coverage(id("mvs_w"), first!.locator),
  }));
  expect(result.records.map((r) => r.kind)).toEqual(["user"]);
  expect(result.coverage).toMatchObject({ status: "not-scanned" });
  db = new Database(":memory:");
});
