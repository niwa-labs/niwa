// The Codex reading side against small synthetic rollouts in a temp dir: the two layers of the
// format, the forked session, the compressed copy, resume by locator, and a rewritten file.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, rmSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { Locator, SessionFilter, SessionRecord } from "@niwa-labs/harness";

import { CodexReading } from "../src/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";

let home: string;
const reading = () => new CodexReading({ harness: harnessId("codex-test"), home });

const NATIVE = "00000000-0000-4000-8000-000000000001";
const ID = sessionId(harnessId("codex-test"), NATIVE);

beforeEach(() => {
  home = tempDirSync("codex-reading");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The path of a rollout file, and the text to put in it. */
function rollout(native: string, text: string): string {
  const dir = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-01T00-00-00-${native}.jsonl`);
  writeFileSync(path, text);
  return path;
}

const record = (ordinal: number, type: string, payload: unknown): string =>
  `${JSON.stringify({ timestamp: `2026-01-01T00:00:0${ordinal}.000Z`, ordinal, type, payload })}\n`;

const meta = (native: string, ordinal = 0): string =>
  record(ordinal, "session_meta", {
    id: native,
    session_id: native,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/x",
  });

const message = (ordinal: number, role: string, text: string): string =>
  record(ordinal, "response_item", {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  });

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

test("lists a session from the files, with its cwd and its times", async () => {
  rollout(NATIVE, meta(NATIVE) + message(1, "user", "hello"));
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(1);
  expect(String(infos[0]?.id.native)).toBe(NATIVE);
  expect(infos[0]?.cwd).toBe("/work/x");
  expect(infos[0]?.startedAt).toBeGreaterThan(0 as never);
  const records = await all(reading().read(ID));
  expect(records[0]).toMatchObject({ kind: "user", text: "hello" });
});

test("the title is the name Codex gave the thread, else the first message of the person", async () => {
  const OTHER = "00000000-0000-4000-8000-000000000002";
  const preamble = "# AGENTS.md instructions for /work/x\n\n<INSTRUCTIONS>\nbe kind\n</INSTRUCTIONS>";
  const context = "<environment_context>\n  <cwd>/work/x</cwd>\n</environment_context>";
  rollout(NATIVE, meta(NATIVE) + message(1, "user", preamble) + message(2, "user", context) + message(3, "user", "fix the build"));
  rollout(OTHER, meta(OTHER) + message(1, "user", "hello"));
  writeFileSync(
    join(home, "session_index.jsonl"),
    `${JSON.stringify({ id: OTHER, thread_name: "Old name", updated_at: "2026-01-01T00:00:00Z" })}\n` +
      "not json\n" +
      `${JSON.stringify({ id: OTHER, thread_name: "Fix the reading side", updated_at: "2026-01-02T00:00:00Z" })}\n`,
  );
  const titles = new Map<string, string | undefined>();
  for await (const info of reading().list()) titles.set(String(info.id.native), info.title);
  expect(titles.get(OTHER)).toBe("Fix the reading side");
  expect(titles.get(NATIVE)).toBe("fix the build");
});

/** The titles a reading side lists, by native id. */
async function titlesOf(side: CodexReading, filter?: SessionFilter): Promise<Map<string, string | undefined>> {
  const titles = new Map<string, string | undefined>();
  for await (const info of side.list(filter)) titles.set(String(info.id.native), info.title);
  return titles;
}

test("a title is made once per file: a file that is the same is not read for it again, one that changed is", async () => {
  const path = rollout(NATIVE, meta(NATIVE) + message(1, "user", "first words"));
  const before = statSync(path);
  const side = reading();
  expect((await titlesOf(side)).get(NATIVE)).toBe("first words");

  // The same size and the same time: the file is taken as it was, and its kept title is used.
  writeFileSync(path, meta(NATIVE) + message(1, "user", "other words"));
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
  expect(statSync(path).size).toBe(before.size);
  expect((await titlesOf(side)).get(NATIVE)).toBe("first words");
  // A reading side of its own keeps nothing and reads the file.
  expect((await titlesOf(reading())).get(NATIVE)).toBe("other words");

  // A file that grew is looked into again.
  appendFileSync(path, message(2, "user", "and more"));
  expect((await titlesOf(side)).get(NATIVE)).toBe("other words");

  // A file of another size is looked into again, even when it is stamped with the old time.
  const kept = statSync(path);
  writeFileSync(path, meta(NATIVE) + message(1, "user", "a longer first message than before"));
  utimesSync(path, kept.atimeMs / 1000, kept.mtimeMs / 1000);
  expect((await titlesOf(side)).get(NATIVE)).toBe("a longer first message than before");

  // A file of the same size and another time is looked into again too.
  const now = statSync(path);
  writeFileSync(path, meta(NATIVE) + message(1, "user", "A LONGER FIRST MESSAGE THAN BEFORE"));
  utimesSync(path, now.atimeMs / 1000, now.mtimeMs / 1000 + 100);
  expect(statSync(path).size).toBe(now.size);
  expect((await titlesOf(side)).get(NATIVE)).toBe("A LONGER FIRST MESSAGE THAN BEFORE");
});

test("a session without a title is kept as such, until its file changes", async () => {
  const spoke = meta(NATIVE) + message(1, "user", "somebody spoke");
  // The text of the file as it is now is as long as the one it will be replaced with.
  const silent = meta(NATIVE) + message(1, "assistant", "x");
  const path = rollout(NATIVE, silent.replace('"x"', `"${"x".repeat(1 + spoke.length - silent.length)}"`));
  const before = statSync(path);
  const side = reading();
  expect((await titlesOf(side)).get(NATIVE)).toBeUndefined();
  writeFileSync(path, spoke);
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
  expect(statSync(path).size).toBe(before.size);
  expect((await titlesOf(side)).get(NATIVE)).toBeUndefined();
  appendFileSync(path, message(2, "assistant", "x"));
  expect((await titlesOf(side)).get(NATIVE)).toBe("somebody spoke");
});

test("a listing can be limited to some sessions, and the others are not read", async () => {
  const OTHER = "00000000-0000-4000-8000-000000000002";
  rollout(NATIVE, meta(NATIVE) + message(1, "user", "one"));
  rollout(OTHER, meta(OTHER) + message(1, "user", "two"));
  expect([...(await titlesOf(reading(), { natives: [OTHER] })).keys()]).toEqual([OTHER]);
  expect((await titlesOf(reading(), { natives: [] })).size).toBe(0);
  expect((await titlesOf(reading())).size).toBe(2);
});

test("the conversation layer is read; the event layer repeats are not read twice", async () => {
  rollout(
    NATIVE,
    meta(NATIVE) +
      message(1, "user", "hello") +
      message(2, "assistant", "hi") +
      record(3, "event_msg", {
        type: "item_completed",
        item: { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "hello" }] },
      }) +
      record(4, "event_msg", {
        type: "item_completed",
        item: { type: "AgentMessage", id: "item-2", content: [{ type: "text", text: "hi" }] },
      }),
  );
  const kinds = (await all(reading().read(ID))).map((r) => r.kind);
  expect(kinds).toEqual(["user", "assistant"]);
});

test("a tool call and its result are paired; the result names the tool", async () => {
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "response_item", {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: JSON.stringify({ cmd: "ls" }),
      }) +
      record(2, "response_item", { type: "function_call_output", call_id: "call_1", output: "a.txt" }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["tool-call", "tool-result"]);
  expect(records[0]).toMatchObject({ callId: "call_1", name: "shell", input: { cmd: "ls" } });
  expect(records[1]).toMatchObject({ callId: "call_1", name: "shell", output: "a.txt" });
});

test("a call is named by its category and its target; a patch is about the first file it names", async () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch";
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "bun test" }) }) +
      record(2, "response_item", { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: patch }) +
      record(3, "response_item", { type: "function_call", call_id: "c3", name: "update_plan", arguments: JSON.stringify({ plan: [] }) }) +
      record(4, "response_item", { type: "function_call", call_id: "c4", name: "mcp__niwa__session_send", arguments: "{}" }) +
      record(5, "response_item", { type: "function_call", call_id: "c5", name: "frobnicate", arguments: "{}" }),
  );
  const calls = (await all(reading().read(ID))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(calls.map((c) => [c.category, c.target])).toEqual([
    ["shell", "bun test"],
    ["edit", "src/a.ts"],
    ["plan", undefined],
    ["mcp", undefined],
    ["other", undefined],
  ]);
});

test("an update_plan call leaves the checklist it wrote; arguments Codex would refuse leave none", async () => {
  const plan = [
    { step: "read", status: "completed" },
    { step: "write", status: "in_progress" },
  ];
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "response_item", { type: "function_call", call_id: "p1", name: "update_plan", arguments: JSON.stringify({ plan }) }) +
      record(2, "response_item", { type: "function_call", call_id: "p2", name: "update_plan", arguments: JSON.stringify({ plan: "x" }) }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["tool-call", "checklist", "tool-call"]);
  expect(records[1]).toMatchObject({ callId: "p1", items: [{ text: "read", state: "done" }, { text: "write", state: "active" }] });
});

test("a subagent that was spawned is a nested record; a compaction is its own kind", async () => {
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "event_msg", {
        type: "item_completed",
        item: {
          type: "SubAgentActivity",
          kind: "started",
          id: "call_1",
          agent_thread_id: "00000000-0000-4000-8000-0000000000ff",
        },
      }) +
      record(2, "compacted", { message: "what happened so far" }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["nested", "compaction"]);
  expect(records[0]).toMatchObject({
    child: { native: "00000000-0000-4000-8000-0000000000ff" },
  });
  expect(records[1]).toMatchObject({ summary: "what happened so far" });
});

test("the replayed history of a parent is not this session's own history", async () => {
  rollout(
    NATIVE,
    meta(NATIVE, 0) +
      record(1, "session_meta", { id: "parent", timestamp: "2026-01-01T00:00:00.000Z" }) +
      message(2, "user", "from the parent") +
      record(3, "turn_context", { turn_id: "t1", model: "gpt-x", cwd: "/work/x" }) +
      message(4, "user", "mine"),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user"]);
  expect(records[0]).toMatchObject({ text: "mine" });
});

test("an unfamiliar record is unknown with its raw kept, and reading does not stop at it", async () => {
  rollout(NATIVE, meta(NATIVE) + '{"unfamiliar":"shape"}\n' + message(1, "user", "after"));
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["unknown", "user"]);
  expect(records[0]).toMatchObject({ raw: { unfamiliar: "shape" } });
});

test("H3 a half-written tail is marked incomplete and is delivered again once whole", async () => {
  const whole = message(2, "assistant", "second");
  const path = rollout(NATIVE, meta(NATIVE) + message(1, "user", "first") + whole.slice(0, 20));
  const first = await all(reading().read(ID));
  expect(first.map((r) => r.incomplete)).toEqual([false, true]);
  expect(await reading().coverage(ID, first[0]?.locator)).toEqual({ status: "not-scanned" });

  appendFileSync(path, whole.slice(20));
  const rest = await all(reading().read(ID, first[0]?.locator));
  expect(rest).toHaveLength(1);
  expect(rest[0]).toMatchObject({ kind: "assistant", text: "second", incomplete: false });

  // Resuming from the marked tail reads it again, never past it.
  expect(await all(reading().read(ID, first[1]?.locator))).toHaveLength(1);
});

test("a locator resumes exactly", async () => {
  rollout(NATIVE, meta(NATIVE) + message(1, "user", "u1") + message(2, "assistant", "u2"));
  const full = await all(reading().read(ID));
  expect(full).toHaveLength(2);
  for (let i = 0; i < full.length; i += 1) {
    const rest = await all(reading().read(ID, full[i]?.locator));
    expect(rest.map((r) => r.locator)).toEqual(full.slice(i + 1).map((r) => r.locator));
  }
  expect(await reading().coverage(ID, full[1]?.locator)).toEqual({ status: "empty" });
});

test("a rewritten file is detected: the read restarts and raw refuses the old locator", async () => {
  const path = rollout(NATIVE, meta(NATIVE) + message(1, "user", "one") + message(2, "user", "two"));
  const [, second] = await all(reading().read(ID));
  const old = second?.locator as Locator;

  writeFileSync(path, meta(NATIVE) + message(1, "user", "ONE") + message(2, "user", "TWO"));
  const again = await all(reading().read(ID, old));
  expect(again).toHaveLength(2);
  // The read began again, and the first record says so; the ones after it do not.
  expect(again.map((r) => r.reanchored)).toEqual([true, undefined]);
  expect((await all(reading().read(ID, again[0]?.locator))).some((r) => r.reanchored === true)).toBe(false);
  await expect(reading().raw(ID, old)).rejects.toThrow("does not belong");
});

test("a record rewritten in place far into the file is detected, though the file is as long as before", async () => {
  // The first message is longer than any prefix a revision could be limited to.
  const text = (late: string): string =>
    meta(NATIVE) + message(1, "user", "x".repeat(6000)) + message(2, "user", "two") + message(3, "user", late);
  const path = rollout(NATIVE, text("late one"));
  const [, second, third] = await all(reading().read(ID));
  const [secondAt, thirdAt] = [second?.locator as Locator, third?.locator as Locator];
  expect(await reading().raw(ID, thirdAt)).toMatchObject({ payload: { content: [{ text: "late one" }] } });

  // The same length, at the same place: only the content differs.
  writeFileSync(path, text("LATE ONE"));
  await expect(reading().raw(ID, thirdAt)).rejects.toThrow("does not belong");
  // The locator before the rewritten record is still good, and a read from it delivers the new text.
  const rest = await all(reading().read(ID, secondAt));
  expect(rest).toHaveLength(1);
  expect(rest[0]).toMatchObject({ kind: "user", text: "LATE ONE" });

  // A rewrite of the record the locator names is no longer the position it was.
  writeFileSync(path, text("late one").replace("two", "TWO"));
  await expect(reading().raw(ID, secondAt)).rejects.toThrow("does not belong");
  expect(await all(reading().read(ID, secondAt))).toHaveLength(3);
});

test("a compressed rollout rewritten in place far into the file is detected too", async () => {
  const dir = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-01T00-00-00-${NATIVE}.jsonl.zst`);
  const text = (late: string): string => meta(NATIVE) + message(1, "user", "x".repeat(6000)) + message(2, "user", late);
  writeFileSync(path, Bun.zstdCompressSync(Buffer.from(text("late one"))));
  const [, second] = await all(reading().read(ID));
  const old = second?.locator as Locator;

  writeFileSync(path, Bun.zstdCompressSync(Buffer.from(text("LATE ONE"))));
  await expect(reading().raw(ID, old)).rejects.toThrow("does not belong");
});

test("the compressed copy of a rollout is the same session and is read", async () => {
  const dir = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const text = meta(NATIVE) + message(1, "user", "hello") + message(2, "assistant", "hi");
  const plain = join(dir, `rollout-2026-01-01T00-00-00-${NATIVE}.jsonl`);
  writeFileSync(plain, text);
  // Codex compresses a cold rollout itself: the same JSONL in a zstd container.
  writeFileSync(`${plain}.zst`, Bun.zstdCompressSync(Buffer.from(text)));

  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  // One session, not two: the compressed copy is the same rollout.
  expect(infos).toHaveLength(1);

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "assistant"]);
  expect(records[0]).toMatchObject({ text: "hello" });
});

test("listing reads the head of each rollout and leaves no file open, compressed or not", async () => {
  const FILES = 200;
  const dir = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  // Long rollouts, so the listing stops reading each one long before its end.
  const tail = Array.from({ length: 4_000 }, (_, i) => message(i + 2, "assistant", `line ${i} ${"x".repeat(80)}`)).join("");
  for (let i = 0; i < FILES; i += 1) {
    const native = `00000000-0000-4000-8000-${String(100_000 + i).padStart(12, "0")}`;
    const text = meta(native) + message(1, "user", "hello") + tail;
    const path = join(dir, `rollout-2026-01-01T00-00-00-${native}.jsonl`);
    if (i % 2 === 0) writeFileSync(`${path}.zst`, Bun.zstdCompressSync(Buffer.from(text)));
    else writeFileSync(path, text);
  }
  const open = () => readdirSync("/dev/fd").length;
  const before = open();
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(FILES);
  // Let closed streams settle before counting. Without the fix every compressed rollout keeps a
  // descriptor (FILES / 2 of them), far above the few the runtime itself keeps.
  await Bun.sleep(100);
  expect(open() - before).toBeLessThan(10);
});

test("raw gives the harness's own record whole; coverage states what it does not know", async () => {
  rollout(NATIVE, meta(NATIVE) + message(1, "user", "hi"));
  const [rec] = await all(reading().read(ID));
  expect(await reading().raw(ID, rec?.locator as Locator)).toMatchObject({
    type: "response_item",
    payload: { type: "message", role: "user" },
  });
  const missing = sessionId(harnessId("codex-test"), "00000000-0000-4000-8000-0000000000ee");
  expect((await reading().coverage(missing)).status).toBe("unavailable");
  await expect(reading().raw(ID, "bogus" as Locator)).rejects.toThrow("not of this side");
});

test("a reasoning item is a thinking record: its words, else its summaries, else a sealed thought; the item stays behind raw", async () => {
  const reasoning = (ordinal: number, payload: Record<string, unknown>): string =>
    record(ordinal, "response_item", { type: "reasoning", id: `rs_${ordinal}`, ...payload });
  rollout(
    NATIVE,
    meta(NATIVE) +
      reasoning(1, { summary: [], content: [{ type: "reasoning_text", text: "first the parser" }], encrypted_content: "sealed" }) +
      reasoning(2, { summary: [{ type: "summary_text", text: "Read the parser" }, { type: "summary_text", text: "Fix it" }], encrypted_content: "sealed" }) +
      reasoning(3, { summary: [], content: null, encrypted_content: "sealed" }) +
      reasoning(4, { summary: [] }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["thinking", "thinking", "thinking", "unknown"]);
  expect(records[0]).toMatchObject({ text: "first the parser", redacted: false });
  expect(records[1]).toMatchObject({ text: "Read the parser\nFix it", redacted: false });
  expect(records[2]).toMatchObject({ text: "", redacted: true });
  expect(await reading().raw(ID, records[2]?.locator as Locator)).toMatchObject({
    payload: { type: "reasoning", id: "rs_3", encrypted_content: "sealed" },
  });
});

test("a resumed read keeps what the earlier lines said: the tool's name and the model", async () => {
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "turn_context", { turn_id: "t1", model: "gpt-x" }) +
      record(2, "response_item", { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" }) +
      record(3, "response_item", { type: "function_call_output", call_id: "c1", output: "ok" }) +
      message(4, "assistant", "done"),
  );
  const full = await all(reading().read(ID));
  const resumed = await all(reading().read(ID, full[0]?.locator));
  expect(resumed).toEqual(full.slice(1));
  expect(resumed[0]).toMatchObject({ kind: "tool-result", name: "shell" });
  expect(resumed[1]).toMatchObject({ kind: "assistant", model: "gpt-x" });
});

test("a legacy rollout's subagent event is nested; a compaction is one record, not two", async () => {
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "event_msg", {
        type: "sub_agent_activity",
        event_id: "e1",
        agent_thread_id: "00000000-0000-4000-8000-0000000000ff",
        kind: "started",
      }) +
      record(2, "compacted", { message: "", retained_context: { user_messages: [{ text: "keep me" }] } }) +
      record(3, "event_msg", { type: "context_compacted" }) +
      record(4, "event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "i1" } }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["nested", "compaction"]);
  expect(records[1]).toMatchObject({ summary: "owner: keep me" });
});

test("a session is updated when its file was, and is listed under the id control uses", async () => {
  rollout(NATIVE, meta(NATIVE) + message(1, "user", "hello"));
  const [info] = await (async () => {
    const out = [];
    for await (const i of reading().list()) out.push(i);
    return out;
  })();
  expect(info?.updatedAt).toBeGreaterThan(Date.parse("2026-06-01") as never);
  expect(info?.id).toEqual(ID);
});

test("a line that is not valid UTF-8 does not move the locators of the lines after it", async () => {
  const path = rollout(NATIVE, "");
  const bad = Buffer.concat([Buffer.from('{"type":"x","payload":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
  writeFileSync(path, Buffer.concat([bad, Buffer.from(meta(NATIVE) + message(1, "user", "one") + message(2, "user", "two"))]));
  const full = await all(reading().read(ID));
  const resumed = await all(reading().read(ID, full[1]?.locator));
  expect(resumed).toEqual(full.slice(2));
  expect(await reading().raw(ID, full[2]?.locator as Locator)).toMatchObject({ type: "response_item" });
});

test("a patch that names several files lists every one of them, a move by where the file goes", async () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/c.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** Delete File: src/d.ts\n*** End Patch";
  const single = "*** Begin Patch\n*** Update File: src/only.ts\n@@\n-x\n+y\n*** End Patch";
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "response_item", { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: patch }) +
      record(2, "response_item", { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: single }),
  );
  const [many, one] = (await all(reading().read(ID))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(many).toMatchObject({ target: "src/a.ts", paths: ["src/a.ts", "src/c.ts", "src/b.ts", "src/d.ts"] });
  expect(one?.target).toBe("src/only.ts");
  expect(one?.paths).toBeUndefined();
});

test("a message marks what Codex inserted, and a result and a message keep their pictures as marks", async () => {
  const environment = "<environment_context>\n  <cwd>/work/x</cwd>\n</environment_context>";
  const png = "data:image/png;base64,AAAA";
  rollout(
    NATIVE,
    meta(NATIVE) +
      record(1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: environment }, { type: "input_text", text: "Fix <user-card>x</user-card>" }, { type: "input_image", image_url: png }] }) +
      record(2, "response_item", { type: "function_call", call_id: "c1", name: "view_image", arguments: JSON.stringify({ path: "/a.png" }) }) +
      record(3, "response_item", { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "shown" }, { type: "input_image", image_url: png }] }),
  );
  const [user, , result] = await all(reading().read(ID));
  expect(user).toMatchObject({
    kind: "user",
    text: `${environment}\nFix <user-card>x</user-card>`,
    inserted: [{ from: 0, to: environment.length + 1, origin: "harness" }],
    images: [{ at: environment.length + 1 + "Fix <user-card>x</user-card>".length, mime: "image/png" }],
  });
  expect(result).toMatchObject({ kind: "tool-result", output: "shown", images: [{ at: 5, mime: "image/png" }] });
  expect(JSON.stringify([user, result])).not.toContain("AAAA");
});

test("Codex startup instructions and recognised metadata retain their raw history", async () => {
  const preamble = "# AGENTS.md instructions for /work/x\n\n<INSTRUCTIONS>\nBe kind.\n</INSTRUCTIONS>";
  const environment = "<environment_context>\n  <cwd>/work/x</cwd>\n</environment_context>";
  const startup = {
    type: "message", role: "user",
    content: [preamble, environment, "Fix the build"].map((text) => ({ type: "input_text", text })),
  };
  rollout(NATIVE, meta(NATIVE) +
    record(1, "response_item", { type: "additional_tools", role: "developer" }) +
    message(2, "developer", "Developer instructions") +
    record(3, "response_item", startup) +
    record(4, "world_state", { full: true }) +
    record(5, "token_usage_record", {}) +
    record(6, "inter_agent_communication_metadata", {}) +
    record(7, "a_future_type", { value: 1 }) +
    message(8, "user", preamble));

  const side = reading();
  const records = await all(side.read(ID));
  expect(records.map((r) => r.kind === "unknown" && r.metadata ? "metadata" : r.kind))
    .toEqual(["metadata", "metadata", "user", "metadata", "metadata", "metadata", "unknown", "user"]);
  const injected = `${preamble}\n${environment}\n`;
  expect(records[2]).toMatchObject({
    kind: "user", text: injected + "Fix the build", inserted: [{ from: 0, to: injected.length, origin: "harness" }],
  });
  expect(records[7]).toMatchObject({ kind: "user", text: preamble, inserted: [] });
  expect(await side.raw(ID, records[2]!.locator)).toMatchObject({ payload: startup });
  expect(await side.raw(ID, records[3]!.locator)).toMatchObject({ type: "world_state", payload: { full: true } });
});
