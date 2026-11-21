// The pi reading side against small synthetic sessions in a temp dir: the defects the review
// found, each of them turned into a check that fails without the fix.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";

import { timestamp } from "@niwa-labs/core";
import { piSession } from "../src/insert/index.ts";
import { piReading } from "../src/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";
import { ENTRY_FIXTURES, MESSAGE_FIXTURES, REAL_MESSAGE_LINES } from "./wire-fixtures.ts";

let home: string;
const reading = () => piReading({ harness: harnessId("pi-test"), sessionsRoot: home });

const PROJECT = "--work--";
const HARNESS = harnessId("pi-test");

beforeEach(() => {
  home = tempDirSync("pi-reading");
  mkdirSync(join(home, PROJECT), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const header = (native: string): string =>
  `${JSON.stringify({
    type: "session",
    version: 3,
    id: native,
    timestamp: "2026-10-27T09:15:00.000Z",
    cwd: "/work",
  })}\n`;

const user = (text: string, id = "u1"): string =>
  `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-27T09:15:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;

const assistant = (text: string, id = "a1"): string =>
  `${JSON.stringify({
    type: "message",
    id,
    parentId: "u1",
    timestamp: "2026-10-27T09:15:02.000Z",
    message: { role: "assistant", model: "pi-1", content: [{ type: "text", text }] },
  })}\n`;

/** The file of a session of a project. */
function sessionFile(native: string): string {
  return join(home, PROJECT, `2026-10-27T09-15-00-000Z_${native}.jsonl`);
}

/** The file of a session of a run of subagents of a session. */
function runFile(parent: string, child: string, run: number): string {
  const dir = join(home, PROJECT, `2026-10-27T09-15-00-000Z_${parent}`, "run-1", `run-${run}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  writeFileSync(file, header(child) + user("work in the child"));
  return file;
}

const idOf = (native: string) => sessionId(HARNESS, native);

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const record of iter) out.push(record);
  return out;
}

test("resuming from a nested child keeps the other nested children", async () => {
  writeFileSync(sessionFile("parent"), header("parent") + user("hello"));
  runFile("parent", "child-a", 0);
  runFile("parent", "child-b", 1);
  runFile("parent", "child-c", 2);

  const full = await all(reading().read(idOf("parent")));
  const nested = full.filter((record) => record.kind === "nested");
  expect(nested).toHaveLength(3);

  // Reading from any of them gives exactly what follows it.
  for (const [index, record] of full.entries()) {
    const resumed = await all(reading().read(idOf("parent"), record.locator));
    expect(resumed.map((r) => r.locator)).toEqual(full.slice(index + 1).map((r) => r.locator));
  }
});

test("a locator of another session is refused by name", async () => {
  writeFileSync(sessionFile("one"), header("one") + user("first"));
  writeFileSync(sessionFile("two"), header("two") + user("second"));
  const [first] = await all(reading().read(idOf("one")));
  expect(first?.locator).toBeDefined();

  let refusal: unknown;
  try {
    await all(reading().read(idOf("two"), first!.locator));
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(String((refusal as Error).message)).toContain("another session");
});

test("a locator whose file was rewritten is refused, not answered with the whole session", async () => {
  const file = sessionFile("rewritten");
  writeFileSync(file, header("rewritten") + user("hello"));
  const [first] = await all(reading().read(idOf("rewritten")));
  expect(first?.locator).toBeDefined();

  writeFileSync(file, header("rewritten") + user("something else entirely now"));
  let refusal: unknown;
  try {
    await all(reading().read(idOf("rewritten"), first!.locator));
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(String((refusal as Error).message)).toContain("no longer names a record");
});

test("coverage of a session that holds only spawned sessions is not empty", async () => {
  writeFileSync(sessionFile("only-children"), header("only-children"));
  runFile("only-children", "child", 0);

  const records = await all(reading().read(idOf("only-children")));
  expect(records).toHaveLength(1);
  expect(records[0]?.kind).toBe("nested");

  const coverage = await reading().coverage(idOf("only-children"));
  expect(coverage.status).toBe("not-scanned");
});

test("the copies of the prompt cache are not sessions", async () => {
  writeFileSync(sessionFile("real"), header("real") + user("hello"));
  writeFileSync(
    join(home, PROJECT, "2026-10-27T09-15-00-000Z_cache.jsonl.pass1.jsonl"),
    `${JSON.stringify({ type: "block", schemaVersion: 3 })}\n`,
  );

  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos.map((info) => String(info.id.native))).toEqual(["real"]);
});

test("the title is the name the owner gave the session, else the first message of the person", async () => {
  writeFileSync(sessionFile("named"), header("named") + user("hello") + `${JSON.stringify({ type: "session_info", name: "the release" })}\n`);
  writeFileSync(sessionFile("unnamed"), header("unnamed") + user("  plan the\n release  "));
  const titles = new Map<string, string | undefined>();
  for await (const info of reading().list()) titles.set(String(info.id.native), info.title);
  expect(titles.get("named")).toBe("the release");
  expect(titles.get("unnamed")).toBe("plan the release");
});

test("a title made from the first message is kept per file, and made again when the file changed", async () => {
  const titles = async (side: ReturnType<typeof reading>) => {
    const out = new Map<string, string | undefined>();
    for await (const info of side.list()) out.set(String(info.id.native), info.title);
    return out;
  };
  const path = sessionFile("kept");
  writeFileSync(path, header("kept") + user("first words"));
  const before = statSync(path);
  const side = reading();
  expect((await titles(side)).get("kept")).toBe("first words");
  // The same size and time: the file is taken as it was.
  writeFileSync(path, header("kept") + user("other words"));
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
  expect(statSync(path).size).toBe(before.size);
  expect((await titles(side)).get("kept")).toBe("first words");
  expect((await titles(reading())).get("kept")).toBe("other words");
  // A file that grew is looked into again.
  appendFileSync(path, assistant("done"));
  expect((await titles(side)).get("kept")).toBe("other words");
});

test("a listing can be limited to some sessions", async () => {
  writeFileSync(sessionFile("one"), header("one") + user("first"));
  writeFileSync(sessionFile("two"), header("two") + user("second"));
  const natives = async (filter?: { natives: string[] }) => {
    const out: string[] = [];
    for await (const info of reading().list(filter)) out.push(String(info.id.native));
    return out.sort();
  };
  // A session of a run takes its id from its header, so it is left out only once that is read.
  runFile("one", "child-a", 0);
  runFile("one", "child-b", 1);
  expect(await natives({ natives: ["child-b"] })).toEqual(["child-b"]);
  expect(await natives({ natives: ["two"] })).toEqual(["two"]);
  expect(await natives({ natives: [] })).toEqual([]);
  expect(await natives()).toEqual(["child-a", "child-b", "one", "two"]);
});

test("the start time in the name of the file is read", async () => {
  writeFileSync(sessionFile("timed"), header("timed") + user("hello"));
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos[0]?.startedAt).toBe(timestamp(Date.parse("2026-10-27T09:15:00.000Z")));
});

test("a session is named by pi's own id, the one the insert reports", async () => {
  writeFileSync(sessionFile("s-1"), header("s-1") + user("hello"));
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(1);
  const insertId = piSession("s-1");
  expect(infos[0]?.id.native).toBe(insertId.native);
  // The reading side is bound to the installation it was opened for, which the insert does not know.
  expect(infos[0]?.id.harness).toBe(HARNESS);
  expect(await all(reading().read(sessionId(HARNESS, insertId.native)))).toHaveLength(1);
});

test("an id that two projects carry names the session written last, in the list and in read", async () => {
  const other = "--other--";
  mkdirSync(join(home, other), { recursive: true });
  const older = join(home, PROJECT, "2026-10-27T09-15-00-000Z_dup.jsonl");
  const newer = join(home, other, "2026-10-28T09-15-00-000Z_dup.jsonl");
  writeFileSync(older, header("dup") + user("old"));
  writeFileSync(newer, header("dup") + user("new"));
  utimesSync(older, 1_000, 1_000);
  utimesSync(newer, 2_000, 2_000);

  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(1);
  const records = await all(reading().read(idOf("dup")));
  expect(records[0]).toMatchObject({ kind: "user", text: "new" });
});

test("both branches of a session tree are read, in the order pi wrote them", async () => {
  const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string) =>
    `${JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-27T09:15:01.000Z",
      message: { role, content: [{ type: "text", text }] },
    })}\n`;
  // u1 - a1 - u2 (abandoned), and u1 - a1 - u3 (the branch pi went on with).
  const file = sessionFile("tree");
  writeFileSync(
    file,
    header("tree") +
      entry("u1", null, "user", "ask") +
      entry("a1", "u1", "assistant", "answer") +
      entry("u2", "a1", "user", "first follow-up"),
  );
  const before = await all(reading().read(idOf("tree")));
  appendFileSync(file, entry("u3", "a1", "user", "second follow-up"));

  const after = await all(reading().read(idOf("tree")));
  expect(after.map((r) => (r.kind === "user" || r.kind === "assistant" ? r.text : r.kind))).toEqual([
    "ask",
    "answer",
    "first follow-up",
    "second follow-up",
  ]);
  // The locators given before the branch began still mean the same records, and resuming works.
  expect(after.slice(0, before.length).map((r) => r.locator)).toEqual(before.map((r) => r.locator));
  const resumed = await all(reading().read(idOf("tree"), before[before.length - 1]!.locator));
  expect(resumed.map((r) => r.locator)).toEqual([after[3]!.locator]);
  // The tree is still in the raw entry.
  expect(await reading().raw(idOf("tree"), after[3]!.locator)).toMatchObject({ id: "u3", parentId: "a1" });
});

test("a locator taken before an append stays valid after it", async () => {
  const file = sessionFile("grows");
  writeFileSync(file, header("grows") + user("hello"));
  const [first] = await all(reading().read(idOf("grows")));
  appendFileSync(file, assistant("hi there"));
  const resumed = await all(reading().read(idOf("grows"), first!.locator));
  expect(resumed.map((r) => r.kind)).toEqual(["assistant"]);
  expect(await reading().raw(idOf("grows"), first!.locator)).toMatchObject({ id: "u1" });
});

test("entries pi writes that have no common kind are kept whole", async () => {
  const lines = [
    { type: "model_change", id: "m1", parentId: null, provider: "p", modelId: "m" },
    { type: "branch_summary", id: "b1", parentId: "m1", fromId: "x", summary: "left branch" },
    { type: "custom", id: "c1", parentId: "b1", customType: "ext", data: { a: 1 } },
  ];
  writeFileSync(
    sessionFile("kinds"),
    header("kinds") + lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  );
  const records = await all(reading().read(idOf("kinds")));
  expect(records.map((r) => r.kind)).toEqual(["unknown", "unknown", "unknown"]);
  expect(records.map((r) => (r.kind === "unknown" ? r.raw : null))).toEqual(lines);
});

test("compaction entries come back as compactions with their summary", async () => {
  writeFileSync(
    sessionFile("compacted"),
    header("compacted") +
      `${JSON.stringify({
        type: "compaction",
        id: "k1",
        parentId: null,
        timestamp: "2026-10-27T09:15:03.000Z",
        summary: "so far",
        firstKeptEntryId: "u1",
        tokensBefore: 10,
      })}\n`,
  );
  const records = await all(reading().read(idOf("compacted")));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: "compaction", summary: "so far" });
});

test("reasoning is a thinking record, and an empty answer is kept whole, not dropped", async () => {
  const message = (id: string, content: unknown) =>
    `${JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-10-27T09:15:02.000Z",
      message: { role: "assistant", content },
    })}\n`;
  writeFileSync(
    sessionFile("quiet"),
    header("quiet") +
      message("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done" }]) +
      message("a2", []),
  );
  const records = await all(reading().read(idOf("quiet")));
  expect(records.map((r) => r.kind)).toEqual(["thinking", "assistant", "unknown"]);
  expect(records[0]).toMatchObject({ kind: "thinking", text: "hmm", redacted: false });
});

test("a call without an id or a name is kept whole", async () => {
  writeFileSync(
    sessionFile("bad-call"),
    header("bad-call") +
      `${JSON.stringify({
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-10-27T09:15:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "", name: "", arguments: {} }],
        },
      })}\n`,
  );
  const records = await all(reading().read(idOf("bad-call")));
  expect(records).toHaveLength(1);
  expect(records[0]?.kind).toBe("unknown");
});

test("a call is named by its category and its target; a tool of an MCP server is mcp, one an extension adds is other", async () => {
  const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
  writeFileSync(
    sessionFile("tools"),
    header("tools") +
      `${JSON.stringify({
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-10-27T09:15:02.000Z",
        message: {
          role: "assistant",
          content: [call("c1", "bash", { command: "ls -la" }), call("c2", "write", { path: "a.md", content: "x" }), call("c3", "mcp__x__y", {}), call("c4", "cbmem_search", {})],
        },
      })}\n`,
  );
  const calls = (await all(reading().read(idOf("tools")))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(calls.map((c) => [c.category, c.target])).toEqual([
    ["shell", "ls -la"],
    ["edit", "a.md"],
    ["mcp", undefined],
    ["other", undefined],
  ]);
});

test("the words of the owner are not rewritten", async () => {
  const text = "<system-reminder>this is what the owner typed</system-reminder>";
  writeFileSync(sessionFile("verbatim"), header("verbatim") + user(text));
  const records = await all(reading().read(idOf("verbatim")));
  expect(records).toMatchObject([{ kind: "user", text }]);
});

test("a half-written line that is not even an object does not throw", async () => {
  const file = sessionFile("cut");
  writeFileSync(file, header("cut") + user("hello") + '{"type":"mess');
  const records = await all(reading().read(idOf("cut")));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown"]);
  expect(records[1]?.incomplete).toBe(true);
  expect((await reading().coverage(idOf("cut"))).status).toBe("not-scanned");
});

test("H3 the half-written last line is marked and is not delivered twice", async () => {
  const file = sessionFile("running");
  const whole = user("hello");
  const half = assistant("the finished answer");
  writeFileSync(file, header("running") + whole + half.slice(0, 20));

  const before = await all(reading().read(idOf("running")));
  expect(before.filter((record) => record.incomplete)).toHaveLength(1);
  const tail = before[before.length - 1]!;

  // Resuming from the half-written line gives what follows it: nothing.
  const resumed = await all(reading().read(idOf("running"), tail.locator));
  expect(resumed).toHaveLength(0);

  // Once the line is whole, it comes back as the answer it is.
  appendFileSync(file, half.slice(20));
  const after = await all(reading().read(idOf("running")));
  expect(after.every((record) => !record.incomplete)).toBe(true);
  expect(after[after.length - 1]).toMatchObject({ kind: "assistant", text: "the finished answer" });
});

/* -------------------------------------------- one fixture for every variant */

test("every entry type and every message role of pi's file is mapped on purpose: to a common kind, or whole under unknown", async () => {
  const entry = (fixture: object): string => `${JSON.stringify(fixture)}\n`;
  const withRole = (role: string): object => ({
    ...ENTRY_FIXTURES.message,
    message: MESSAGE_FIXTURES[role],
  });

  const kindsOf = async (native: string, body: string): Promise<string[]> => {
    writeFileSync(sessionFile(native), header(native) + body);
    return (await all(reading().read(idOf(native)))).map((record) => record.kind);
  };

  // The entries: the header is no record, a message and a compaction have kinds, the rest are kept whole.
  const entryKinds: Record<string, string[]> = {
    session: [],
    message: ["user"],
    compaction: ["compaction"],
    model_change: ["unknown"],
    thinking_level_change: ["unknown"],
    usage: ["unknown"],
    branch_summary: ["unknown"],
    custom: ["unknown"],
    custom_message: ["unknown"],
    context_edit: ["unknown"],
    label: ["unknown"],
    session_info: ["unknown"],
  };
  expect(Object.keys(entryKinds).sort()).toEqual(Object.keys(ENTRY_FIXTURES).sort());
  for (const [type, kinds] of Object.entries(entryKinds)) {
    expect(await kindsOf(`entry-${type}`, entry(ENTRY_FIXTURES[type]!)), type).toEqual(kinds);
  }

  // The roles: the person, the model and the tool have kinds; the others are kept whole.
  const roleKinds: Record<string, string[]> = {
    system: ["unknown"],
    user: ["user"],
    assistant: ["assistant"],
    toolResult: ["tool-result"],
    bashExecution: ["unknown"],
    custom: ["unknown"],
    branchSummary: ["unknown"],
    compactionSummary: ["unknown"],
  };
  expect(Object.keys(roleKinds).sort()).toEqual(Object.keys(MESSAGE_FIXTURES).sort());
  for (const [role, kinds] of Object.entries(roleKinds)) {
    expect(await kindsOf(`role-${role}`, entry(withRole(role))), role).toEqual(kinds);
  }

  // The blocks of what the model said: text and calls have kinds; reasoning and a block pi grew are
  // kept whole, the latter as it came, and neither takes the text beside it.
  const blocks = [
    { type: "thinking", thinking: "hm", thinkingSignature: "reasoning" },
    { type: "text", text: "said" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    { type: "audio", data: "AAA" },
  ];
  writeFileSync(
    sessionFile("blocks"),
    header("blocks") + entry({ ...ENTRY_FIXTURES.message, message: { ...MESSAGE_FIXTURES.assistant, content: blocks } }),
  );
  const records = await all(reading().read(idOf("blocks")));
  expect(records.map((record) => record.kind)).toEqual(["thinking", "assistant", "tool-call", "unknown"]);
  expect(records[0]).toMatchObject({ text: "hm", redacted: false });
  // The signature of the protocol stays in the record pi wrote, which is still there to be asked for.
  expect(await reading().raw(idOf("blocks"), records[0]!.locator)).toMatchObject({ type: "message" });
  expect(records[3]).toMatchObject({ raw: blocks[3] });

  // A line pi really wrote.
  writeFileSync(sessionFile("real"), header("real") + `${REAL_MESSAGE_LINES.assistantThinkingText}\n`);
  expect((await all(reading().read(idOf("real")))).map((record) => record.kind)).toEqual(["thinking", "assistant"]);

  // A line that is none of pi's entries stays whole under unknown, as before.
  expect(await kindsOf("alien", entry({ type: "hologram", id: "z" }))).toEqual(["unknown"]);
});

test("a locator taken from a half-written line yields the line's records once it is whole", async () => {
  const file = sessionFile("growing");
  const half = assistant("the finished answer");
  writeFileSync(file, header("growing") + user("hello") + half.slice(0, 20));

  const tail = (await all(reading().read(idOf("growing")))).at(-1)!;
  expect(tail.incomplete).toBe(true);

  appendFileSync(file, half.slice(20));
  // The tail stood for nothing final: the whole line is read from its first record.
  const resumed = await all(reading().read(idOf("growing"), tail.locator));
  expect(resumed).toMatchObject([{ kind: "assistant", text: "the finished answer", incomplete: false }]);
});

test("a complete object that only lacks its line feed keeps its place when the feed comes", async () => {
  const file = sessionFile("unfed");
  const whole = assistant("done");
  writeFileSync(file, header("unfed") + user("hello") + whole.trimEnd());

  const records = await all(reading().read(idOf("unfed")));
  expect(records.map((record) => [record.kind, record.incomplete])).toEqual([
    ["user", false],
    ["assistant", true],
  ]);
  appendFileSync(file, "\n");
  // The record was delivered whole, as the one record of its line: nothing follows it.
  expect(await all(reading().read(idOf("unfed"), records[1]!.locator))).toEqual([]);
});

/** The file of a session of a run of subagents that began at `at`. */
function lateRunFile(parent: string, child: string, at: string): void {
  const dir = join(home, PROJECT, `2026-10-27T09-15-00-000Z_${parent}`, "run-1", "run-0");
  mkdirSync(dir, { recursive: true });
  const stamped = header(child).replace("2026-10-27T09:15:00.000Z", at);
  writeFileSync(join(dir, "session.jsonl"), stamped + user("work in the child"));
}

test("a session spawned after the reader has gone past the parent is read from the place it left", async () => {
  writeFileSync(sessionFile("parent-late"), header("parent-late") + user("hello") + assistant("on it"));
  const seen = await all(reading().read(idOf("parent-late")));
  expect(seen.map((record) => record.kind)).toEqual(["user", "assistant"]);
  const saved = seen.at(-1)!.locator;

  lateRunFile("parent-late", "child-late", "2026-10-27T09:15:03.000Z");

  const resumed = await all(reading().read(idOf("parent-late"), saved));
  expect(resumed).toMatchObject([{ kind: "nested", child: idOf("child-late") }]);
  expect((await reading().coverage(idOf("parent-late"), saved)).status).toBe("not-scanned");
  // A read from the start sees the same session in the order it happened.
  expect((await all(reading().read(idOf("parent-late")))).map((record) => record.kind)).toEqual(["user", "assistant", "nested"]);
  // And once the reader has the child, it gets nothing twice.
  const again = (await all(reading().read(idOf("parent-late")))).at(-1)!;
  expect(await all(reading().read(idOf("parent-late"), again.locator))).toEqual([]);
});

test("a session spawned between two lines sits between their records", async () => {
  writeFileSync(sessionFile("parent-mid"), header("parent-mid") + user("hello") + assistant("on it"));
  lateRunFile("parent-mid", "child-mid", "2026-10-27T09:15:01.500Z");

  const records = await all(reading().read(idOf("parent-mid")));
  expect(records.map((record) => record.kind)).toEqual(["user", "nested", "assistant"]);
  // Reading on from the user's record gives the child and the answer; from the child, the answer alone.
  expect((await all(reading().read(idOf("parent-mid"), records[0]!.locator))).map((record) => record.kind)).toEqual(["nested", "assistant"]);
  expect((await all(reading().read(idOf("parent-mid"), records[1]!.locator))).map((record) => record.kind)).toEqual(["assistant"]);
});

const message = (id: string, body: object): string =>
  `${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-27T09:15:03.000Z", message: body })}\n`;

test("a message of an image alone is a user record with a mark, and a mixed one marks where the picture stood", async () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  writeFileSync(
    sessionFile("pictures"),
    header("pictures") +
      message("u1", { role: "user", content: [image] }) +
      message("u2", { role: "user", content: [{ type: "text", text: "look" }, image, { type: "text", text: "closely" }] }),
  );
  const records = await all(reading().read(idOf("pictures")));
  expect(records).toMatchObject([
    { kind: "user", text: "", images: [{ at: 0, mime: "image/png" }] },
    { kind: "user", text: "look\nclosely", images: [{ at: 4, mime: "image/png" }] },
  ]);
  expect(JSON.stringify(records)).not.toContain("AAAA");
  // A message with nothing in it is still kept whole.
  writeFileSync(sessionFile("blank"), header("blank") + message("u1", { role: "user", content: [] }));
  expect((await all(reading().read(idOf("blank"))))[0]?.kind).toBe("unknown");
});

test("a picture in the result of a tool is a mark among its blocks, not an encoded payload in its output", async () => {
  const image = { type: "image", data: "BBBB", mimeType: "image/jpeg" };
  writeFileSync(
    sessionFile("shot"),
    header("shot") +
      message("r1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "a" }, image, { type: "text", text: "b" }], isError: false }) +
      message("r2", { role: "toolResult", toolCallId: "c2", toolName: "read", content: [image], isError: false }),
  );
  const [first, second] = await all(reading().read(idOf("shot")));
  expect(first).toMatchObject({ kind: "tool-result", output: [{ type: "text", text: "a" }, { type: "text", text: "b" }], images: [{ at: 1, mime: "image/jpeg" }] });
  expect(second).toMatchObject({ kind: "tool-result", images: [{ at: 0, mime: "image/jpeg" }] });
  expect(second && "output" in second ? second.output : undefined).toBeUndefined();
  expect(JSON.stringify([first, second])).not.toContain("BBBB");
});
