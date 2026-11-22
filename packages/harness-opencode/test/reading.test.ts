// The shared transcript mapping against an explicit HTTP endpoint and the local read-only transport
// against the OpenCode v2 SQLite projection.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { timestamp } from "@niwa-labs/core";
import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { startFakeServer } from "./fixtures/serve.ts";
import type { FakeServer } from "./fixtures/serve.ts";
import { OpenCodeReading } from "../src/reading.ts";

const HARNESS = harnessId("opencode-test");
const id = (native: string) => sessionId(HARNESS, native);

let dir = "";
let data = "";
let server: FakeServer | undefined;

beforeEach(async () => {
  dir = await tempDir("opencode-reading");
  data = join(dir, "data");
  await mkdir(data, { recursive: true });
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const record of iter) out.push(record);
  return out;
}

// -- the data the fake serves --------------------------------------------------

type MessageRow = Record<string, unknown>;
type SessionRow = Record<string, unknown>;

const session = (native: string, created: number, updated: number, extra: Record<string, unknown> = {}): SessionRow => ({
  id: native,
  projectID: "prj",
  time: { created, updated },
  location: { directory: "/work/opencode" },
  ...extra,
});

const userMessage = (id: string, text: string, created: number, extra: Record<string, unknown> = {}): MessageRow => ({
  id,
  time: { created },
  type: "user",
  text,
  ...extra,
});

const assistantMessage = (id: string, created: number, content: readonly unknown[], completed = true): MessageRow => ({
  id,
  time: { created, ...(completed ? { completed: created + 100 } : {}) },
  type: "assistant",
  agent: "build",
  model: { id: "fixture-model", providerID: "fixture" },
  content: [...content],
});

const toolPart = (id: string, name: string, state: Record<string, unknown>, created: number, completed?: number): MessageRow => ({
  type: "tool",
  id,
  name,
  state,
  time: { created, ...(completed === undefined ? {} : { completed }) },
});

/** Writes the data and starts a fake that serves it; the side is bound to the fake's endpoint. */
async function serve(sessions: readonly SessionRow[], messages: Readonly<Record<string, readonly MessageRow[]>>): Promise<OpenCodeReading> {
  await writeFile(join(data, "sessions.json"), JSON.stringify([...sessions]));
  for (const [native, rows] of Object.entries(messages)) {
    await writeFile(join(data, `messages-${native}.json`), JSON.stringify([...rows]));
  }
  server = await startFakeServer({ cwd: dir, dataDir: data });
  return new OpenCodeReading({ harness: HARNESS, server: { url: server.url, password: server.password } });
}

// -- the tests -------------------------------------------------------------------

test("lists the sessions with their titles and times, and filters them", async () => {
  const side = await serve(
    [
      session("ses_a", 1_000, 1_010, { title: "  The  first\nsession ", location: { directory: "/work/a" } }),
      session("ses_b", 5_000, 5_010),
    ],
    { ses_a: [userMessage("m1", "first", 1_000)], ses_b: [userMessage("m2", "second", 5_000)] },
  );
  const listed = [];
  for await (const info of side.list()) listed.push(info);
  expect(listed.map((info) => String(info.id.native))).toEqual(["ses_a", "ses_b"]);
  expect(listed[0]).toMatchObject({ title: "The first session", cwd: "/work/a", startedAt: timestamp(1_000), updatedAt: timestamp(1_010) });
  expect(listed[1]?.title).toBeUndefined();

  const only = async (filter: Parameters<OpenCodeReading["list"]>[0]): Promise<string[]> => {
    const out: string[] = [];
    for await (const info of side.list(filter)) out.push(String(info.id.native));
    return out;
  };
  expect(await only({ cwd: "/work/a" })).toEqual(["ses_a"]);
  expect(await only({ since: timestamp(4_000) })).toEqual(["ses_b"]);
  expect(await only({ natives: ["ses_a", "ses_nope"] })).toEqual(["ses_a"]);
});

test("maps user text and its image attachments, thoughts, texts, calls and results", async () => {
  const side = await serve([session("ses_a", 1_000, 2_000)], {
    ses_a: [
      userMessage("m1", "look at this", 1_000, {
        files: [
          { data: "AAAA", mime: "image/png", source: { type: "inline" } },
          { data: "dGV4dA==", mime: "text/plain", source: { type: "inline" } },
          { data: "BQUY", mime: "image/jpeg", source: { type: "inline" }, mention: { start: 8, end: 12, text: "this" } },
        ],
      }),
      assistantMessage("m2", 1_100, [
        { type: "reasoning", text: "weighing it", time: { created: 1_050, completed: 1_060 } },
        { type: "text", text: "on it" },
        toolPart(
          "call_1",
          "bash",
          {
            status: "completed",
            input: { command: "ls" },
            content: [
              { type: "text", text: "a.txt" },
              { type: "file", uri: "blob:x", mime: "image/png" },
            ],
          },
          1_100,
          1_150,
        ),
        toolPart("call_2", "read", { status: "error", input: { filePath: "/nope" }, error: { type: "FileNotFound", message: "no such file" } }, 1_160, 1_170),
      ]),
      { id: "m3", time: { created: 1_200 }, type: "system", text: "a warning", description: "warned" },
      { id: "m4", time: { created: 1_300 }, type: "idle", outcome: "succeeded" },
    ],
  });
  const records = await all(side.read(id("ses_a")));
  // The system message is unknown with what it was; the idle marker is no record at all.
  expect(records.map((record) => record.kind)).toEqual([
    "user",
    "thinking",
    "assistant",
    "tool-call",
    "tool-result",
    "tool-call",
    "tool-result",
    "unknown",
  ]);
  expect(records.map((record) => String(record.locator))).toEqual([
    "opencode:v1:0:0",
    "opencode:v1:1:0",
    "opencode:v1:1:1",
    "opencode:v1:1:2",
    "opencode:v1:1:3",
    "opencode:v1:1:4",
    "opencode:v1:1:5",
    "opencode:v1:2:0",
  ]);
  // The image attachments are marks where they stood: one at its mention, one at the text's end;
  // the plain-text attachment is no image.
  expect(records[0]).toMatchObject({ kind: "user", text: "look at this", images: [{ at: 12, mime: "image/png" }, { at: 8, mime: "image/jpeg" }] });
  expect(records[1]).toMatchObject({ kind: "thinking", text: "weighing it", redacted: false, at: 1_050 });
  expect(records[2]).toMatchObject({ kind: "assistant", text: "on it", model: "fixture/fixture-model", at: 1_100 });
  expect(records[3]).toMatchObject({ kind: "tool-call", callId: "call_1", name: "bash", category: "shell", target: "ls", input: { command: "ls" }, at: 1_100 });
  // The result keeps the non-image blocks and marks the image where it stood among them.
  expect(records[4]).toMatchObject({
    kind: "tool-result",
    callId: "call_1",
    output: [{ type: "text", text: "a.txt" }],
    images: [{ at: 1, mime: "image/png" }],
    ok: true,
    at: 1_150,
  });
  expect(records[5]).toMatchObject({ kind: "tool-call", name: "read", category: "read", target: "/nope", incomplete: false });
  expect(records[6]).toMatchObject({ kind: "tool-result", callId: "call_2", ok: false, output: [] });
  expect(records[7]).toMatchObject({ kind: "unknown", raw: { type: "system", text: "a warning" } });
});

test("only the tail of a running session is incomplete; a call left running in an older message is whole", async () => {
  const side = await serve([session("ses_a", 1_000, 2_000)], {
    ses_a: [
      userMessage("m1", "do it", 1_000),
      // A whole message with a call that never answered: the call was abandoned, it holds nothing back.
      assistantMessage("m2", 1_100, [toolPart("call_old", "bash", { status: "running", input: { command: "sleep 9" }, metadata: {} }, 1_100)]),
      // The half-written line: no completion of its own, and a call still at work in it.
      assistantMessage(
        "m3",
        1_200,
        [
          { type: "text", text: "partial" },
          toolPart("call_new", "bash", { status: "streaming", input: '{"comm' }, 1_210),
        ],
        false,
      ),
    ],
  });
  const records = await all(side.read(id("ses_a")));
  expect(records.map((record) => [record.kind, record.incomplete])).toEqual([
    ["user", false],
    ["tool-call", false],
    ["assistant", true],
    ["tool-call", true],
  ]);
  // A streaming call's input is the partial text it has; no result came for either call.
  expect(records[3]).toMatchObject({ kind: "tool-call", callId: "call_new", input: '{"comm' });
});

test("a session spawned inside sits after the message that existed when it was created", async () => {
  const side = await serve(
    [
      session("ses_parent", 900, 2_000),
      session("ses_child", 1_030, 1_040, { parentID: "ses_parent" }),
      session("ses_early", 950, 960, { parentID: "ses_parent" }),
    ],
    {
      ses_parent: [
        userMessage("m1", "hello", 1_000),
        assistantMessage("m2", 1_010, [{ type: "text", text: "hi there" }]),
        assistantMessage("m3", 1_020, [
          toolPart("call_1", "task", { status: "completed", input: { description: "work" }, content: [{ type: "text", text: "done" }] }, 1_020, 1_025),
        ]),
      ],
      ses_child: [userMessage("c1", "work", 1_030)],
      ses_early: [userMessage("e1", "early", 950)],
    },
  );
  const records = await all(side.read(id("ses_parent")));
  expect(records.map((record) => [record.kind, String(record.locator)])).toEqual([
    ["nested", "opencode:v1:-1:0"], // a child created before the first message sits ahead of everything
    ["user", "opencode:v1:0:0"],
    ["assistant", "opencode:v1:1:0"],
    ["tool-call", "opencode:v1:2:0"],
    ["tool-result", "opencode:v1:2:1"],
    ["nested", "opencode:v1:2:2"], // after the last message that existed when it was created
  ]);
  const nested = records.at(-1);
  expect(nested).toMatchObject({ kind: "nested", child: { harness: HARNESS, native: "ses_child" } });
  // Reading from a locator yields exactly what follows it.
  const resumed = await all(side.read(id("ses_parent"), records[2]?.locator));
  expect(resumed.map((record) => String(record.locator))).toEqual(["opencode:v1:2:0", "opencode:v1:2:1", "opencode:v1:2:2"]);
  // raw gives what the server holds: the message whole, and the child session of a nested record.
  const raw = await side.raw(id("ses_parent"), records[1]?.locator ?? LocatorSchema.parse("opencode:v1:0:0"));
  expect(raw).toMatchObject({ id: "m1", type: "user", text: "hello" });
  const childRaw = await side.raw(id("ses_parent"), nested?.kind === "nested" ? nested.locator : LocatorSchema.parse("opencode:v1:0:0"));
  expect(childRaw).toMatchObject({ id: "ses_child", parentID: "ses_parent" });
});

test("raw refuses a locator that is not one, and a place where no record is", async () => {
  const side = await serve([session("ses_a", 1_000, 1_100)], { ses_a: [userMessage("m1", "hello", 1_000)] });
  await expect(side.raw(id("ses_a"), LocatorSchema.parse("opencode:v1:0"))).rejects.toThrow("is not a locator of this side");
  await expect(side.raw(id("ses_a"), LocatorSchema.parse("opencode:v1:9:9"))).rejects.toThrow("no record at");
});

test("coverage: not-scanned while unread, empty past the end, failed when the store broke, unavailable when the session is gone", async () => {
  const side = await serve([session("ses_a", 1_000, 1_100)], {
    ses_a: [userMessage("m1", "hello", 1_000), assistantMessage("m2", 1_010, [{ type: "text", text: "hi" }])],
  });
  expect((await side.coverage(id("ses_a"))).status).toBe("not-scanned");
  const records = await all(side.read(id("ses_a")));
  expect((await side.coverage(id("ses_a"), records.at(-1)?.locator)).status).toBe("empty");
  await writeFile(join(data, "messages-ses_a.json"), "this is not json");
  expect((await side.coverage(id("ses_a"))).status).toBe("failed");
  await writeFile(join(data, "sessions.json"), JSON.stringify([]));
  await rm(join(data, "messages-ses_a.json"), { force: true });
  expect((await side.coverage(id("ses_a"))).status).toBe("unavailable");
});

test("a server that cannot be reached lists nothing, reads nothing and says unavailable", async () => {
  const side = new OpenCodeReading({ harness: HARNESS, server: { url: "http://127.0.0.1:9", password: "x" }, callTimeoutMs: 2_000 });
  const listed = [];
  for await (const info of side.list()) listed.push(info);
  expect(listed).toEqual([]);
  expect(await all(side.read(id("ses_a")))).toEqual([]);
  expect(await side.coverage(id("ses_a"))).toMatchObject({ status: "unavailable" });
  await expect(side.raw(id("ses_a"), LocatorSchema.parse("opencode:v1:0:0"))).rejects.toThrow();
});

test("local history includes committed WAL rows without changing the database or automation state", async () => {
  const home = join(data, "opencode");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const database = new Database(path);
  try {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA wal_autocheckpoint = 0");
    database.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER, time_suspended INTEGER, cost REAL DEFAULT 0,
        tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
      );
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
      CREATE TABLE session_part (session_id TEXT, message_id TEXT, ordinal INTEGER, data TEXT);
      CREATE TABLE blob (hash TEXT, data BLOB);
      CREATE TABLE automation (id TEXT, last_message_id TEXT, status TEXT, next_due_at INTEGER);
      CREATE TABLE session_inbox (id TEXT, session_id TEXT);
      INSERT INTO automation VALUES ('existing', 'pending', 'active', 1);
      INSERT INTO session_inbox VALUES ('pending', 'ses_saved');
      INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated, time_suspended)
        VALUES ('ses_saved', 'global', '/work/a', ' Stored session ', 1000, 2000, 1600);
      INSERT INTO session_v2 (id, parent_id, project_id, directory, time_created, time_updated)
        VALUES ('ses_child', 'ses_saved', 'global', '/work/a', 1550, 1900);
    `);
    const hash = "1".repeat(64);
    database.query("INSERT INTO blob VALUES (?, ?)").run(hash, Buffer.from("fixture bytes"));
    const user = userMessage("msg_user", "hello", 1_010, {
      files: [{ uri: `media:${hash}`, mime: "image/png", source: { type: "inline" } }],
    });
    const assistant = assistantMessage("msg_assistant", 1_500, [{ type: "text", text: "second" }]);
    const message = database.query("INSERT INTO session_message VALUES (?, 'ses_saved', ?, ?, ?)");
    message.run("msg_assistant", "assistant", 2, JSON.stringify(assistant));
    message.run("msg_user", "user", 1, JSON.stringify(user));
    database.query("INSERT INTO session_part VALUES ('ses_saved', 'msg_assistant', 0, ?)").run(JSON.stringify({
      type: "text", text: "first", state: { fixture: true },
    }));
    const before = await Promise.all([readFile(path), readFile(`${path}-wal`)]);
    const side = new OpenCodeReading({ harness: HARNESS, home });
    const listed = [];
    for await (const info of side.list({ cwd: "/work/a", since: timestamp(2_000) })) listed.push(info);
    expect(listed).toEqual([{ id: id("ses_saved"), title: "Stored session", cwd: "/work/a", startedAt: timestamp(1_000), updatedAt: timestamp(2_000) }]);

    expect(await side.coverage(id("ses_saved"))).toMatchObject({ status: "not-scanned" });
    const records = await all(side.read(id("ses_saved")));
    expect(records.map((record) => record.kind)).toEqual(["user", "assistant", "assistant", "nested"]);
    expect(records[0]).toMatchObject({ text: "hello", images: [{ mime: "image/png" }] });
    expect(records[1]).toMatchObject({ text: "first" });
    expect(records[2]).toMatchObject({ text: "second" });
    expect((await side.coverage(id("ses_saved"), records.at(-1)?.locator)).status).toBe("empty");

    const rawUser = await side.raw(id("ses_saved"), LocatorSchema.parse("opencode:v1:0:0"));
    expect(rawUser).toMatchObject({ files: [{ data: Buffer.from("fixture bytes").toString("base64") }] });
    const rawAssistant = await side.raw(id("ses_saved"), LocatorSchema.parse("opencode:v1:1:0"));
    expect(rawAssistant).toMatchObject({ content: [{ native: { fixture: true } }, { type: "text", text: "second" }] });
    await expect(side.raw(id("ses_saved"), LocatorSchema.parse("opencode:v1:1:2")))
      .resolves.toMatchObject({ id: "ses_child", parentID: "ses_saved" });

    expect(await Promise.all([readFile(path), readFile(`${path}-wal`)])).toEqual(before);
    const orphan = join(home, "orphan.db");
    const [main, wal] = before;
    await Promise.all([writeFile(orphan, main), writeFile(`${orphan}-wal`, wal)]);
    const orphanReader = new OpenCodeReading({ harness: HARNESS, home, env: { OPENCODE_DB: "orphan.db" } });
    expect(await orphanReader.coverage(id("ses_saved"))).toMatchObject({
      status: "failed", reason: expect.stringContaining("SQLite journal recovery"),
    });
    expect(await Bun.file(`${orphan}-shm`).exists()).toBe(false);
  } finally {
    database.close();
  }
});

test("missing and invalid databases are reported without creating or repairing files", async () => {
  const home = join(data, "opencode");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const side = new OpenCodeReading({ harness: HARNESS, home });
  const listed = [];
  for await (const info of side.list()) listed.push(info);
  expect(listed).toEqual([]);
  expect(await all(side.read(id("ses_a")))).toEqual([]);
  expect(await side.coverage(id("ses_a"))).toMatchObject({ status: "unavailable" });
  expect(await Bun.file(path).exists()).toBe(false);
  await writeFile(path, "not a SQLite database");
  expect(await side.coverage(id("ses_a"))).toMatchObject({ status: "failed" });
  expect(await readFile(path, "utf8")).toBe("not a SQLite database");
});

test("the offline reader opens a checkpointed WAL database without recreating its sidecars", async () => {
  const home = join(data, "opencode");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const database = new Database(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session_v2 (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('ses_offline', 'Offline session', '/work/a', NULL, 1, 2);
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  database.close();
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });

  const before = await readFile(path);
  const side = new OpenCodeReading({ harness: HARNESS, home });
  const listed = [];
  for await (const info of side.list()) listed.push(info);
  expect(listed).toMatchObject([{ id: id("ses_offline"), title: "Offline session" }]);
  expect(await side.coverage(id("ses_offline"))).toMatchObject({ status: "empty" });
  expect(await readdir(home)).toEqual(["opencode.db"]);
  expect(await readFile(path)).toEqual(before);
});
