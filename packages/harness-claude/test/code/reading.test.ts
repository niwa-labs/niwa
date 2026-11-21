// The Claude Code reading side against small synthetic logs in a temp dir: the mapping of the
// native kinds, the tool names remembered by the id of the call, the subagent that is linked to
// the call that spawned it, and the half-written tail of a running session.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { Locator, SessionRecord } from "@niwa-labs/harness";

import { timestamp } from "@niwa-labs/core";
import { ClaudeCodeReading } from "../../src/code/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";
import type { BlockType } from "../../src/code/format.ts";

import { ADVISOR_CALL, BLOCKS } from "./blocks.ts";

const HARNESS = harnessId("claude-code-test");
const SESSION = "11111111-2222-3333-4444-555555555555";

let home: string;
const reading = () => new ClaudeCodeReading({ harness: HARNESS, home });

beforeEach(() => {
  home = tempDirSync("claude-code-reading");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The directory of the project the logs live in. */
function projectDir(): string {
  const dir = join(home, "projects", "-work-project");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The log of the session. */
function logPath(): string {
  return join(projectDir(), `${SESSION}.jsonl`);
}

const record = (value: object): string => `${JSON.stringify(value)}\n`;

const user = (text: string): string =>
  record({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-07T12:00:00.000Z",
    cwd: "/work/project",
    sessionId: SESSION,
    message: { role: "user", content: text },
  });

const assistant = (blocks: unknown[], model = "claude-test-1"): string =>
  record({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-10-07T12:00:01.000Z",
    cwd: "/work/project",
    sessionId: SESSION,
    message: { role: "assistant", model, content: blocks },
  });

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

const ID = sessionId(HARNESS, SESSION);

test("lists a session with its working directory, its title and its times", async () => {
  writeFileSync(
    logPath(),
    user("hello") + record({ type: "ai-title", aiTitle: "the title", sessionId: SESSION }),
  );
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(1);
  expect(String(infos[0]?.id.native)).toBe(SESSION);
  expect(infos[0]?.cwd).toBe("/work/project");
  expect(infos[0]?.title).toBe("the title");
  expect(infos[0]?.startedAt).toBe(timestamp(Date.parse("2026-10-07T12:00:00.000Z")));
});

test("a listing can be limited to some sessions", async () => {
  writeFileSync(logPath(), user("hello"));
  const natives = async (filter?: { natives: string[] }) => {
    const out: string[] = [];
    for await (const info of reading().list(filter)) out.push(String(info.id.native));
    return out;
  };
  expect(await natives({ natives: [SESSION] })).toEqual([SESSION]);
  expect(await natives({ natives: ["other"] })).toEqual([]);
  expect(await natives()).toEqual([SESSION]);
});

test("a session with no title of its own is titled by the first message of the person, machine tags cut out", async () => {
  writeFileSync(
    logPath(),
    user("<local-command-caveat>Caveat: the command below was run by hand.</local-command-caveat>") +
      user(`<system-reminder>be brief</system-reminder>Please rewrite the reading side of the codex harness so that it streams`),
  );
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos[0]?.title).toBe("Please rewrite the reading side of the codex harness so that…");
});

test("a title keeps the markup the person wrote", async () => {
  writeFileSync(logPath(), user("<task>Review tests</task>"));
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos[0]?.title).toBe("<task>Review tests</task>");
});

test("maps the common kinds: the message, the answer, the call and its answer", async () => {
  writeFileSync(
    logPath(),
    user("go") +
      assistant([
        { type: "text", text: "working" },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
      ]) +
      record({
        type: "user",
        uuid: "u2",
        timestamp: "2026-10-07T12:00:02.000Z",
        sessionId: SESSION,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.txt", is_error: false }],
        },
      }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "assistant", "tool-call", "tool-result"]);
  expect(records[1]).toMatchObject({ text: "working", model: "claude-test-1" });
  expect(records[2]).toMatchObject({ callId: "call_1", name: "Bash", input: { command: "ls" } });
  // The name of the tool is not written in its answer: it is remembered by the id of the call.
  expect(records[3]).toMatchObject({ callId: "call_1", name: "Bash", ok: true });
});

test("a call is named by its category and its target, whatever Claude Code calls the tool", async () => {
  writeFileSync(
    logPath(),
    user("go") +
      assistant([
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "bun   test" } },
        { type: "tool_use", id: "c2", name: "Edit", input: { file_path: "/work/a.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "c3", name: "Grep", input: { pattern: "TODO" } },
        { type: "tool_use", id: "c4", name: "mcp__niwa__session_send", input: {} },
        { type: "mcp_tool_use", id: "c5", name: "create_issue", server_name: "github", input: {} },
        { type: "tool_use", id: "c6", name: "Frobnicate", input: { command: "x" } },
      ]),
  );
  const calls = (await all(reading().read(ID))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(calls.map((c) => [c.category, c.target])).toEqual([
    ["shell", "bun test"],
    ["edit", "/work/a.ts"],
    ["search", "TODO"],
    ["mcp", undefined],
    ["mcp", undefined],
    ["other", undefined],
  ]);
});

test("a TodoWrite call leaves the checklist it wrote, right after the call", async () => {
  const todos = [
    { content: "read the spec", status: "completed", activeForm: "Reading" },
    { content: "write the code", status: "in_progress", activeForm: "Writing" },
    { content: "ship", status: "pending", activeForm: "Shipping" },
  ];
  writeFileSync(
    logPath(),
    user("go") +
      assistant([
        { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos } },
        { type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [{ content: "x", status: "blocked" }] } },
      ]),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "tool-call", "checklist", "tool-call"]);
  expect(records[2]).toMatchObject({
    callId: "t1",
    items: [
      { text: "read the spec", state: "done" },
      { text: "write the code", state: "active" },
      { text: "ship", state: "pending" },
    ],
  });
  // Reading on from the call gives the checklist again, and from the checklist what follows it.
  expect((await all(reading().read(ID, records[1]!.locator))).map((r) => r.kind)).toEqual(["checklist", "tool-call"]);
  expect((await all(reading().read(ID, records[2]!.locator))).map((r) => r.kind)).toEqual(["tool-call"]);
});

/** What each block type of an answer becomes: every type has its deliberate record. */
const BLOCK_KINDS: { readonly [K in BlockType]: SessionRecord["kind"] } = {
  text: "assistant",
  image: "unknown",
  document: "unknown",
  search_result: "unknown",
  thinking: "thinking",
  redacted_thinking: "thinking",
  tool_use: "tool-call",
  server_tool_use: "tool-call",
  mcp_tool_use: "tool-call",
  tool_result: "tool-result",
  mcp_tool_result: "tool-result",
  advisor_tool_result: "tool-result",
  web_search_tool_result: "tool-result",
  web_fetch_tool_result: "tool-result",
  code_execution_tool_result: "tool-result",
  bash_code_execution_tool_result: "tool-result",
  text_editor_code_execution_tool_result: "tool-result",
  tool_search_tool_result: "tool-result",
  container_upload: "unknown",
  compaction: "compaction",
  fallback: "unknown",
  mcp_tool_listing: "unknown",
};

test("every content block type becomes its typed record: a thought, a server tool's call and answer", async () => {
  const blocks = Object.values(BLOCKS);
  writeFileSync(logPath(), assistant(blocks));
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(blocks.map((block) => BLOCK_KINDS[block.type]));
  const byKind = (kind: SessionRecord["kind"]) => records.filter((r) => r.kind === kind);
  expect(byKind("thinking")).toMatchObject([
    { text: "let me see", redacted: false },
    { text: "", redacted: true },
  ]);
  // The advisor is a server tool: its answer is named by its call, and an error answer is not ok.
  expect(records.find((r) => r.kind === "tool-call" && r.name === "advisor")).toMatchObject({ callId: ADVISOR_CALL });
  expect(records.find((r) => r.kind === "tool-result" && r.callId === ADVISOR_CALL)).toMatchObject({
    name: "advisor",
    ok: true,
    output: BLOCKS.advisor_tool_result.content,
  });
  expect(records.find((r) => r.kind === "tool-result" && r.callId === "srvtoolu_wf")).toMatchObject({ ok: false });
  expect(records.find((r) => r.kind === "tool-result" && r.callId === "mcptoolu_1")).toMatchObject({
    name: "lookup",
    ok: false,
  });
  expect(byKind("compaction")).toMatchObject([{ summary: "what came before" }]);
});

test("a block of a type niwa does not know, or one that breaks its type's schema, is unknown with its raw data", async () => {
  const strange = { type: "brand_new_block", payload: 1 };
  const broken = { type: "tool_use", id: "", name: "Bash", input: {} };
  writeFileSync(logPath(), assistant([strange, broken]));
  const records = await all(reading().read(ID));
  expect(records).toMatchObject([
    { kind: "unknown", raw: strange },
    { kind: "unknown", raw: broken },
  ]);
});

test("a record of a kind niwa does not speak about is unknown with its raw data", async () => {
  writeFileSync(logPath(), user("hi") + record({ type: "mode", mode: "plan" }));
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown"]);
  expect(records[1]).toMatchObject({ raw: { type: "mode", mode: "plan" } });
});

test("a compaction is the summary record; the boundary beside it is kept as unknown", async () => {
  writeFileSync(
    logPath(),
    user("hi") +
      record({
        type: "system",
        subtype: "compact_boundary",
        uuid: "s1",
        timestamp: "2026-10-07T12:00:03.000Z",
        sessionId: SESSION,
        content: "Conversation compacted",
      }) +
      record({
        type: "user",
        uuid: "u2",
        isCompactSummary: true,
        timestamp: "2026-10-07T12:00:03.100Z",
        sessionId: SESSION,
        message: { role: "user", content: "what happened so far" },
      }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown", "compaction"]);
  expect(records[1]).toMatchObject({ raw: { subtype: "compact_boundary" } });
  expect(records[2]).toMatchObject({ kind: "compaction", summary: "what happened so far" });
});

test("a subagent is linked to the call that spawned it", async () => {
  const dir = join(projectDir(), SESSION, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-abc.meta.json"),
    JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_01spawn" }),
  );
  writeFileSync(
    join(dir, "agent-abc.jsonl"),
    record({
      type: "user",
      uuid: "u9",
      timestamp: "2026-10-07T12:00:05.000Z",
      cwd: "/work/project",
      sessionId: SESSION,
      agentId: "abc",
      isSidechain: true,
      message: { role: "user", content: "the work" },
    }),
  );
  writeFileSync(
    logPath(),
    user("go") +
      assistant([
        { type: "tool_use", id: "toolu_01spawn", name: "Agent", input: { description: "work" } },
      ]),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "tool-call", "nested"]);
  expect(records[2]).toMatchObject({ child: { harness: HARNESS, native: "subagent-abc" } });

  // The subagent's own log is a session of its own.
  const child = await all(reading().read(sessionId(HARNESS, "subagent-abc")));
  expect(child).toHaveLength(1);
  expect(child[0]).toMatchObject({ kind: "user", text: "the work" });
});

test("H3 a half-written tail is marked incomplete and is not passed as a whole record", async () => {
  const whole = assistant([{ type: "text", text: "the finished answer" }]);
  writeFileSync(logPath(), user("first") + whole.slice(0, whole.length - 12));
  const first = await all(reading().read(ID));
  expect(first.map((r) => r.incomplete)).toEqual([false, true]);
  expect(await reading().coverage(ID, first[0]?.locator)).toEqual({ status: "not-scanned" });

  appendFileSync(logPath(), whole.slice(whole.length - 12));
  const rest = await all(reading().read(ID, first[0]?.locator));
  expect(rest).toHaveLength(1);
  expect(rest[0]).toMatchObject({ kind: "assistant", text: "the finished answer", incomplete: false });
});

test("a locator resumes exactly, and raw gives the harness's own record", async () => {
  writeFileSync(logPath(), user("one") + assistant([{ type: "text", text: "two" }]));
  const full = await all(reading().read(ID));
  expect(full).toHaveLength(2);
  for (let i = 0; i < full.length; i += 1) {
    const rest = await all(reading().read(ID, full[i]?.locator));
    expect(rest.map((r) => r.locator)).toEqual(full.slice(i + 1).map((r) => r.locator));
  }
  expect(await reading().coverage(ID, full[1]?.locator)).toEqual({ status: "empty" });
  expect(await reading().raw(ID, full[0]?.locator as Locator)).toMatchObject({
    type: "user",
    message: { role: "user", content: "one" },
  });
  await expect(reading().raw(ID, "bogus" as Locator)).rejects.toThrow("not of this side");
});

const userBlocks = (blocks: unknown[]): string =>
  record({
    type: "user",
    uuid: "u2",
    timestamp: "2026-10-07T12:00:02.000Z",
    cwd: "/work/project",
    sessionId: SESSION,
    message: { role: "user", content: blocks },
  });

test("a message marks the stretches the harness inserted, and a tag the person typed is not among them", async () => {
  const reminder = "<system-reminder>be brief</system-reminder>\n";
  const command = "<command-name>/review</command-name>\n<command-args></command-args>";
  writeFileSync(
    logPath(),
    userBlocks([
      { type: "text", text: `${reminder}Fix <user-card>x</user-card> now` },
      { type: "text", text: command },
      { type: "text", text: "plain" },
    ]),
  );
  const [first, second, third] = await all(reading().read(ID));
  expect(first).toMatchObject({ kind: "user", text: `${reminder}Fix <user-card>x</user-card> now`, inserted: [{ from: 0, to: reminder.length, origin: "harness" }] });
  expect(second).toMatchObject({ kind: "user", inserted: [{ from: 0, to: command.length, origin: "command" }] });
  // Nothing inserted is an answer too: an empty list, not an absent field.
  expect(third).toMatchObject({ kind: "user", text: "plain", inserted: [] });
});

test("a picture in a message is a mark where it stood, alone or after the text, and its payload is not kept", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  writeFileSync(logPath(), userBlocks([{ type: "text", text: "look at this" }, image]) + userBlocks([image]));
  const [mixed, alone] = await all(reading().read(ID));
  expect(mixed).toMatchObject({ kind: "user", text: "look at this", images: [{ at: 12, mime: "image/png" }] });
  expect(alone).toMatchObject({ kind: "user", text: "", images: [{ at: 0, mime: "image/png" }] });
  expect(JSON.stringify([mixed, alone])).not.toContain("AAAA");
});

test("a picture in a tool result is taken out of its output and marked where it stood", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } };
  writeFileSync(
    logPath(),
    assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.png" } }]) +
      userBlocks([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, image, { type: "text", text: "b" }] }]),
  );
  const result = (await all(reading().read(ID))).find((r) => r.kind === "tool-result");
  expect(result).toMatchObject({ kind: "tool-result", output: [{ type: "text", text: "a" }, { type: "text", text: "b" }], images: [{ at: 1, mime: "image/jpeg" }] });
  expect(JSON.stringify(result)).not.toContain("BBBB");
});

test("a locator from before the file was rewritten starts the read over and its first record says so", async () => {
  writeFileSync(logPath(), user("one") + assistant([{ type: "text", text: "two" }]));
  const before = await all(reading().read(ID));
  expect(before.some((r) => r.reanchored === true)).toBe(false);
  // The file is replaced by another history: the old locator names nothing in it.
  writeFileSync(logPath(), user("other beginning") + assistant([{ type: "text", text: "other" }]) + user("more"));
  const after = await all(reading().read(ID, before[1]?.locator));
  expect(after.map((r) => r.kind)).toEqual(["user", "assistant", "user"]);
  expect(after.map((r) => r.reanchored)).toEqual([true, undefined, undefined]);
  // A locator that still holds follows on without the mark.
  const again = await all(reading().read(ID, after[0]?.locator));
  expect(again.some((r) => r.reanchored === true)).toBe(false);
});
