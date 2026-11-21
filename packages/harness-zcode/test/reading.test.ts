// The ZCode reading side against small synthetic databases in a temp dir: what is a record and
// what is not, the half-written tail, the sessions spawned inside, locators, and the coverage.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { timestamp } from "@niwa-labs/core";
import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";
import { tempDirSync } from "@niwa-labs/testing";

import { assistant, createDatabase, user, writeSession } from "../src/fixtures.ts";
import type { FixtureMessage } from "../src/fixtures.ts";
import { PART_TYPES } from "../src/format.ts";
import { dbPathOf } from "../src/paths.ts";
import { ZcodeReading, directoryOf } from "../src/reading.ts";

let home: string;
let db: Database;
const reading = () => new ZcodeReading({ harness: harnessId("zcode-test"), home });
const id = (native: string) => sessionId(harnessId("zcode-test"), native);

beforeEach(() => {
  home = tempDirSync("zcode-reading");
  mkdirSync(dirname(dbPathOf(home)), { recursive: true });
  db = createDatabase(dbPathOf(home));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const record of iter) out.push(record);
  return out;
}

const tool = (id: string, status: string, extra: Record<string, unknown> = {}): FixtureMessage => ({
  id,
  data: { role: "assistant", time: { created: 2000, completed: 2100 } },
  parts: [{ type: "tool", callID: `call_${id}`, tool: "Bash", state: { status, input: { command: "ls" }, output: "a.txt", time: { start: 2000, end: 2010 }, ...extra } }],
});

test("lists the sessions, last changed first, without the deleted ones, and filters them", async () => {
  writeSession(db, "sess_a", [user("m1", "first")], { directory: "/work/a", at: 1000, title: "  The  first\nsession " });
  writeSession(db, "sess_b", [user("m2", "second")], { directory: "/work/b", at: 5000 });
  writeSession(db, "sess_gone", [user("m3", "gone")], { at: 9000 });
  db.run("update session set time_deleted = 1 where id = 'sess_gone'");
  db.run("update session set title_source = 'default', title = 'Placeholder Request' where id = 'sess_b'");

  const listed = [];
  for await (const info of reading().list()) listed.push(info);
  expect(listed.map((info) => String(info.id.native))).toEqual(["sess_b", "sess_a"]);
  expect(listed[1]).toMatchObject({ title: "The first session", cwd: "/work/a", startedAt: 1000, updatedAt: 1010 });
  expect(listed[0]?.title).toBeUndefined();

  const only = async (filter: Parameters<ZcodeReading["list"]>[0]) => {
    const out: string[] = [];
    for await (const info of reading().list(filter)) out.push(String(info.id.native));
    return out;
  };
  expect(await only({ cwd: "/work/a" })).toEqual(["sess_a"]);
  expect(await only({ since: timestamp(4000) })).toEqual(["sess_b"]);
  expect(await only({ natives: ["sess_a", "sess_nope"] })).toEqual(["sess_a"]);
  expect(await only({ natives: Array.from({ length: 600 }, (_, i) => (i === 0 ? "sess_b" : `x${i}`)) })).toEqual(["sess_b"]);
});

test("a database that is not there lists nothing and reads as unavailable", async () => {
  rmSync(dbPathOf(home));
  expect(await all(reading().read(id("sess_a")))).toEqual([]);
  expect((await reading().coverage(id("sess_a"))).status).toBe("unavailable");
  const listed = [];
  for await (const info of reading().list()) listed.push(info);
  expect(listed).toEqual([]);
});

test("maps text, tool calls and results; the harness's own messages, thoughts and markers are not records", async () => {
  writeSession(db, "sess_a", [
    { id: "m0", data: { role: "assistant", time: { created: 1, completed: 1 } }, parts: [{ type: "timeline", timelineType: "model_change" }] },
    user("m1", "do it"),
    {
      id: "m1b",
      data: { role: "user", metadata: { visibility: "model-only" }, time: { created: 1 } },
      parts: [{ type: "text", text: "<system-reminder>hidden</system-reminder>" }],
    },
    {
      id: "m2",
      data: { role: "assistant", time: { created: 2, completed: 3 }, modelId: "GLM-5.3-Flash", providerId: "builtin:zai" },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "synthetic", synthetic: true },
        { type: "text", text: "on it", time: { start: 2500 } },
        { type: "step-finish", tokens: { input: 1 } },
      ],
    },
    tool("m3", "completed"),
    tool("m4", "error", { error: "no such file" }),
  ]);
  const records = await all(reading().read(id("sess_a")));
  expect(records.map((record) => record.kind)).toEqual(["user", "assistant", "tool-call", "tool-result", "tool-call", "tool-result"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "do it", incomplete: false });
  expect(records[1]).toMatchObject({ kind: "assistant", text: "on it", model: "builtin:zai/GLM-5.3-Flash", at: 2500 });
  expect(records[2]).toMatchObject({ kind: "tool-call", callId: "call_m3", name: "Bash", input: { command: "ls" }, at: 2000 });
  expect(records[3]).toMatchObject({ kind: "tool-result", callId: "call_m3", output: "a.txt", ok: true, at: 2010 });
  expect(records[5]).toMatchObject({ kind: "tool-result", output: "no such file", ok: false });
});

test("a call is named by its category and its target, in ZCode's tool names", async () => {
  const part = (callID: string, tool: string, input: object) => ({ type: "tool", callID, tool, state: { status: "completed", input, output: "", time: { start: 1, end: 2 } } });
  writeSession(db, "sess_t", [
    {
      id: "m1",
      data: { role: "assistant", time: { created: 2000, completed: 2100 } },
      parts: [part("c1", "Bash", { command: "ls" }), part("c2", "Write", { file_path: "/w/a.ts", content: "" }), part("c3", "mcp__niwa__session_send", {})],
    },
  ]);
  const calls = (await all(reading().read(id("sess_t")))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(calls.map((c) => [c.category, c.target])).toEqual([
    ["shell", "ls"],
    ["edit", "/w/a.ts"],
    ["mcp", undefined],
  ]);
});

test("a finished TodoWrite call leaves its checklist after its result, and a locator resumes past it", async () => {
  const todos = [
    { content: "a", status: "completed" },
    { content: "b", status: "pending" },
  ];
  writeSession(db, "sess_c", [
    {
      id: "m1",
      data: { role: "assistant", time: { created: 2000, completed: 2100 } },
      parts: [{ type: "tool", callID: "t1", tool: "TodoWrite", state: { status: "completed", input: { todos }, output: "", time: { start: 1, end: 2 } } }],
    },
    user("m2", "next"),
  ]);
  const records = await all(reading().read(id("sess_c")));
  expect(records.map((r) => r.kind)).toEqual(["tool-call", "tool-result", "checklist", "user"]);
  expect(records[2]).toMatchObject({ callId: "t1", items: [{ text: "a", state: "done" }, { text: "b", state: "pending" }] });
  expect((await all(reading().read(id("sess_c"), records[2]!.locator))).map((r) => r.kind)).toEqual(["user"]);
});

test("only the tail of a running session is incomplete; an older unfinished message is whole", async () => {
  writeSession(db, "sess_a", [
    user("m1", "go"),
    assistant("m2", "killed in the middle", false),
    user("m3", "go on"),
    tool("m4", "completed"),
    { id: "m5", data: { role: "assistant", time: { created: 5 } }, parts: [
      { type: "tool", callID: "c1", tool: "Bash", state: { status: "completed", input: {}, output: "ok" } },
      { type: "tool", callID: "c2", tool: "Bash", state: { status: "running", input: {} } },
      { type: "tool", callID: "c3", tool: "Bash", state: { status: "completed", input: {}, output: "late" } },
    ] },
  ]);
  const records = await all(reading().read(id("sess_a")));
  const marks = records.map((record) => `${record.kind}:${record.incomplete}`);
  expect(marks.slice(0, 5)).toEqual(["user:false", "assistant:false", "user:false", "tool-call:false", "tool-result:false"]);
  // The running message is the tail: from the running tool on, nothing is whole, the late result included.
  expect(marks.slice(5)).toEqual(["tool-call:true", "tool-result:true", "tool-call:true", "tool-call:true", "tool-result:true"]);
});

test("a call left running in an older message does not hold back what came after it", async () => {
  writeSession(db, "sess_a", [
    user("m1", "go"),
    { id: "m2", data: { role: "assistant", time: { created: 2 } }, parts: [{ type: "tool", callID: "c1", tool: "Bash", state: { status: "running", input: {} } }] },
    user("m3", "go on"),
    assistant("m4", "done"),
  ]);
  const records = await all(reading().read(id("sess_a")));
  // The abandoned call is delivered as it stands, with no result invented for it, and nothing after it is incomplete.
  expect(records.map((record) => `${record.kind}:${record.incomplete}`)).toEqual(["user:false", "tool-call:false", "user:false", "assistant:false"]);
  expect((await reading().coverage(id("sess_a"), records[1]!.locator)).status).toBe("not-scanned");
});

test("a session spawned inside sits after the part that existed when it was created, whichever way it names its parent", async () => {
  writeSession(db, "sess_a", [user("m1", "go"), assistant("m2", "spawning"), assistant("m3", "later")], { at: 1000 });
  writeSession(db, "sess_sub1", [user("s1", "work")], { parent: "sess_a", at: 1015 });
  db.run("create table session_task_link (id text primary key, parent_session_id text, child_session_id text not null)");
  writeSession(db, "sess_actor", [user("s2", "work")], { at: 1015 });
  db.run("insert into session_task_link values ('l1', 'sess_a', 'sess_actor')");
  // Created before anything was said: it comes first.
  writeSession(db, "sess_early", [user("s3", "work")], { parent: "sess_a", at: 5 });

  const records = await all(reading().read(id("sess_a")));
  expect(records.map((record) => (record.kind === "nested" ? `nested:${String(record.child.native)}` : record.kind))).toEqual([
    "nested:sess_early",
    "user",
    "assistant",
    "nested:sess_actor",
    "nested:sess_sub1",
    "assistant",
  ]);
  const nested = records.find((record) => record.kind === "nested" && record.child.native === "sess_sub1");
  expect(await reading().raw(id("sess_a"), nested!.locator)).toEqual({ kind: "child", session: "sess_sub1" });
});

test("reading from a locator gives what follows, also after the session grew", async () => {
  writeSession(db, "sess_a", [user("m1", "one"), tool("m2", "completed")]);
  const first = await all(reading().read(id("sess_a")));
  expect(first.map((record) => record.kind)).toEqual(["user", "tool-call", "tool-result"]);
  // Half a part's records were delivered: the call, not yet the result.
  expect((await all(reading().read(id("sess_a"), first[1]!.locator))).map((record) => record.kind)).toEqual(["tool-result"]);

  db.query("insert into message (id, session_id, time_created, time_updated, data, sequence) values ('m3', 'sess_a', 3, 3, ?, 2)").run(JSON.stringify(user("m3", "").data));
  db.query("insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values ('m3p', 'm3', 'sess_a', 3, 3, ?, 0)").run(JSON.stringify({ type: "text", text: "two" }));
  const after = await all(reading().read(id("sess_a"), first[2]!.locator));
  expect(after.map((record) => (record.kind === "user" ? record.text : record.kind))).toEqual(["two"]);
  expect((await reading().coverage(id("sess_a"), after[0]!.locator)).status).toBe("empty");
  await expect(all(reading().read(id("sess_a"), LocatorSchema.parse("elsewhere:1")))).rejects.toThrow("not a locator of this side");
});

test("an unfamiliar or broken part is unknown with what it was, and raw gives the rows whole", async () => {
  writeSession(db, "sess_a", [{ id: "m1", data: { role: "assistant", time: { created: 1, completed: 1 } }, parts: [{ type: "frobnicate", a: 1 }, "{broken"] }]);
  const records = await all(reading().read(id("sess_a")));
  expect(records.map((record) => record.kind)).toEqual(["unknown", "unknown"]);
  expect(records[0]).toMatchObject({ raw: { type: "frobnicate", a: 1 } });
  expect(records[1]).toMatchObject({ raw: "{broken" });
  const raw = await reading().raw(id("sess_a"), records[1]!.locator);
  expect(raw).toMatchObject({ kind: "part", part: "{broken", message: { role: "assistant" } });
  expect(reading().rawSchema.safeParse(raw).success).toBe(true);
  await expect(reading().raw(id("sess_a"), LocatorSchema.parse("zcode:v1:9:9:0"))).rejects.toThrow("no record");
  await expect(reading().raw(id("sess_nope"), records[0]!.locator)).rejects.toThrow("not in the database");
});

/** One row of each part type ZCode writes, as small as it can be, and the records the reading side makes of it. */
const PART_ROWS: Record<(typeof PART_TYPES)[number], { part: Record<string, unknown>; kinds: SessionRecord["kind"][] }> = {
  text: { part: { type: "text", text: "said" }, kinds: ["assistant"] },
  reasoning: { part: { type: "reasoning", text: "thinking" }, kinds: [] },
  file: { part: { type: "file", mime: "image/png", url: "file:///a.png" }, kinds: ["unknown"] },
  agent: { part: { type: "agent", name: "reviewer" }, kinds: ["unknown"] },
  compaction: { part: { type: "compaction", auto: true }, kinds: ["compaction"] },
  timeline: { part: { type: "timeline", timelineType: "model_change", display: "separator" }, kinds: [] },
  subtask: { part: { type: "subtask", prompt: "p", description: "d", agent: "build" }, kinds: ["unknown"] },
  retry: { part: { type: "retry", attempt: 1, error: {}, time: { created: 1 } }, kinds: ["unknown"] },
  "step-start": { part: { type: "step-start" }, kinds: [] },
  "step-finish": { part: { type: "step-finish", reason: "stop", cost: 0, tokens: {} }, kinds: [] },
  snapshot: { part: { type: "snapshot", snapshot: "abc" }, kinds: ["unknown"] },
  patch: { part: { type: "patch", hash: "abc", files: ["a.ts"] }, kinds: ["unknown"] },
  tool: { part: { type: "tool", callID: "call_1", tool: "Bash", state: { status: "completed", input: {}, output: "o", time: { start: 1, end: 2 } } }, kinds: ["tool-call", "tool-result"] },
};

test("every part type ZCode writes has a deliberate mapping: a record, none, or the part kept whole", async () => {
  expect(Object.keys(PART_ROWS).sort()).toEqual([...PART_TYPES].sort());
  for (const [type, { part, kinds }] of Object.entries(PART_ROWS)) {
    writeSession(db, `sess_${type}`, [{ id: `m_${type}`, data: { role: "assistant", time: { created: 1, completed: 1 } }, parts: [part] }]);
    const records = await all(reading().read(id(`sess_${type}`)));
    expect(records.map((record) => record.kind), type).toEqual(kinds);
    // A part kept whole keeps what it was.
    if (kinds[0] === "unknown") expect(records[0], type).toMatchObject({ raw: part });
  }
});

test("the compaction record carries the summary the compaction left", async () => {
  writeSession(db, "sess_a", [
    { id: "ms", data: { role: "user", summary: { body: "the story so far" } }, parts: [{ type: "text", text: "continued from..." }] },
    { id: "mb", data: { role: "assistant", time: { created: 1, completed: 1 } }, parts: [{ type: "compaction", summaryMessageId: "ms" }, { type: "compaction", summaryMessageId: "missing" }] },
  ]);
  const records = await all(reading().read(id("sess_a")));
  expect(records).toMatchObject([{ kind: "compaction", summary: "the story so far" }, { kind: "compaction", summary: "" }]);
});

test("coverage says not-scanned for records unread, and unavailable for a session that is not there", async () => {
  writeSession(db, "sess_a", [user("m1", "one")]);
  writeSession(db, "sess_hidden", [{ id: "h1", data: { role: "user", metadata: { visibility: "model-only" } }, parts: [{ type: "text", text: "x" }] }]);
  expect((await reading().coverage(id("sess_a"))).status).toBe("not-scanned");
  // Only what the harness injected: no record, so nothing to scan.
  expect((await reading().coverage(id("sess_hidden"))).status).toBe("empty");
  expect((await reading().coverage(id("sess_nope"))).status).toBe("unavailable");
});

test("the directory of a session is the one the database has", () => {
  writeSession(db, "sess_a", [user("m1", "one")], { directory: "/work/here" });
  expect(directoryOf(home, "sess_a")).toBe("/work/here");
  expect(directoryOf(home, "sess_nope")).toBeUndefined();
  expect(directoryOf(`${home}/missing`, "sess_a")).toBeUndefined();
});
