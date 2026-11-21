// The MiniMax Code reading side against small synthetic sessions in a temp dir: running, nested,
// compacted, with a broken line; plus resume by locator and detection of a rewritten file.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { Locator, SessionRecord } from "@niwa-labs/harness";

import { McodeReading } from "../src/mcode/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";

let home: string;
const reading = () => new McodeReading({ harness: harnessId("mcode-test"), home });

beforeEach(() => {
  home = tempDirSync("mcode-reading");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function journalOf(native: string): string {
  const encoded = Buffer.from(native).toString("base64url");
  const dir = join(home, "v2", "sessions", "2026", "10", "07", `12-00-00-000-session_${encoded}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ sessionId: native, createdAtMs: 1000, updatedAtMs: 2000 }),
  );
  return join(dir, "messages.jsonl");
}

const line = (message: object) => `${JSON.stringify({ message_id: "m", message })}\n`;
const user = (text: string) => line({ role: "user", timestamp: 1, content: text });
const assistant = (text: string) =>
  line({ role: "assistant", timestamp: 2, model: "m1", content: [{ type: "text", text }] });

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

const ID = sessionId(harnessId("mcode-test"), "mvs_run1");

test("lists a session from the files, with cwd from the preamble", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(
    path,
    user("<system-reminder>\n<agent-context>\n  YOUR WORKSPACE DIRECTORY: /work/x\n</agent-context>\n</system-reminder>\n\nhello"),
  );
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos).toHaveLength(1);
  expect(String(infos[0]?.id.native)).toBe("mvs_run1");
  expect(infos[0]?.cwd).toBe("/work/x");
  expect(infos[0]?.updatedAt).toBe(2000 as never);
  // MiniMax Code names no session: the title is the first message, the preamble cut out.
  expect(infos[0]?.title).toBe("hello");
  const records = await all(reading().read(ID));
  // What the harness inserted is cut out of the text, so nothing in it is marked as inserted.
  expect(records[0]).toMatchObject({ kind: "user", text: "hello", inserted: [] });
});

test("the title is the one the harness keeps in its runtime state, else the first message", async () => {
  writeFileSync(journalOf("mvs_run1"), user("hello"));
  writeFileSync(journalOf("mvs_run2"), user("plan the release"));
  mkdirSync(join(home, "v2", "sqlite"), { recursive: true });
  const db = new Database(join(home, "v2", "sqlite", "runtime-state.sqlite"));
  db.run("create table local_runtime_sessions (session_id text primary key, record_json text not null, title text)");
  db.run("insert into local_runtime_sessions values ('mvs_run1', '{}', 'Greet the owner')");
  db.run("insert into local_runtime_sessions values ('mvs_run2', '{}', null)");
  db.close();
  const titles = new Map<string, string | undefined>();
  for await (const info of reading().list()) titles.set(String(info.id.native), info.title);
  expect(titles.get("mvs_run1")).toBe("Greet the owner");
  expect(titles.get("mvs_run2")).toBe("plan the release");

  // Asked for some sessions only, the titles are those of the ones asked for.
  const some = new Map<string, string | undefined>();
  for await (const info of reading().list({ natives: ["mvs_run1"] })) some.set(String(info.id.native), info.title);
  expect([...some]).toEqual([["mvs_run1", "Greet the owner"]]);
});

test("a runtime state that is missing, has no such table or is not a database gives no title and no error", async () => {
  writeFileSync(journalOf("mvs_run1"), user("hello"));
  const titles = async () => {
    const out = new Map<string, string | undefined>();
    for await (const info of reading().list()) out.set(String(info.id.native), info.title);
    return out;
  };
  // Missing: the first message stands in.
  expect((await titles()).get("mvs_run1")).toBe("hello");
  mkdirSync(join(home, "v2", "sqlite"), { recursive: true });
  const path = join(home, "v2", "sqlite", "runtime-state.sqlite");
  // A database without the table.
  const db = new Database(path);
  db.run("create table other (a text)");
  db.close();
  expect((await titles()).get("mvs_run1")).toBe("hello");
  // A file that is no database.
  writeFileSync(path, "this is not sqlite");
  expect((await titles()).get("mvs_run1")).toBe("hello");
  // It is read, and never written to.
  expect(readFileSync(path, "utf8")).toBe("this is not sqlite");
});

test("a listing can be limited to some sessions", async () => {
  writeFileSync(journalOf("mvs_run1"), user("one"));
  writeFileSync(journalOf("mvs_run2"), user("two"));
  const natives = async (filter?: { natives: string[] }) => {
    const out: string[] = [];
    for await (const info of reading().list(filter)) out.push(String(info.id.native));
    return out.sort();
  };
  expect(await natives({ natives: ["mvs_run2"] })).toEqual(["mvs_run2"]);
  expect(await natives({ natives: [] })).toEqual([]);
  expect(await natives()).toEqual(["mvs_run1", "mvs_run2"]);
});

test("maps a running session: text, tool call, tool result, nested child", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(
    path,
    user("go") +
      line({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm", thinkingSignature: "abc" },
          { type: "thinking", thinking: "", redacted: true },
          { type: "text", text: "ok" },
          { type: "toolCall", id: "c1", name: "task", arguments: { a: 1 } },
        ],
      }) +
      line({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "task",
        content: 'done session_id="mvs_child9"',
      }),
  );
  const kinds = (await all(reading().read(ID))).map((r) => r.kind);
  expect(kinds).toEqual(["user", "thinking", "thinking", "assistant", "tool-call", "tool-result", "nested"]);
  const thoughts = (await all(reading().read(ID))).filter((r) => r.kind === "thinking");
  expect(thoughts[0]).toMatchObject({ text: "hm", redacted: false });
  expect(thoughts[1]).toMatchObject({ text: "", redacted: true });
  // The sealed block stays whole behind its locator.
  expect(await reading().raw(ID, thoughts[1]!.locator)).toMatchObject({ message: { role: "assistant" } });
  const nested = (await all(reading().read(ID))).find((r) => r.kind === "nested");
  expect(nested).toMatchObject({ child: { native: "mvs_child9" } });
});

test("a call is named by its category and its target, in MiniMax Code's tool names", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(
    path,
    line({
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } },
        { type: "toolCall", id: "c2", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "c3", name: "todowrite", arguments: { todos: [] } },
        { type: "toolCall", id: "c4", name: "task", arguments: { description: "Check docs", prompt: "…" } },
      ],
    }),
  );
  const calls = (await all(reading().read(ID))).flatMap((r) => (r.kind === "tool-call" ? [r] : []));
  expect(calls.map((c) => [c.category, c.target])).toEqual([
    ["shell", "make"],
    ["read", "src/a.ts"],
    ["plan", undefined],
    ["subagent", "Check docs"],
  ]);
});

test("a todowrite call leaves its checklist without the cancelled items; an unknown state leaves none", async () => {
  const path = journalOf("mvs_run1");
  const todo = (content: string, status: string) => ({ content, status, priority: "high" });
  writeFileSync(
    path,
    line({
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "todowrite", arguments: { todos: [todo("a", "completed"), todo("b", "cancelled"), todo("c", "in_progress")] } },
        { type: "toolCall", id: "t2", name: "todowrite", arguments: { todos: [todo("a", "paused")] } },
      ],
    }),
  );
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["tool-call", "checklist", "tool-call"]);
  expect(records[1]).toMatchObject({ callId: "t1", items: [{ text: "a", state: "done" }, { text: "c", state: "active" }] });
});

test("compaction is its own kind; an unfamiliar role is unknown with raw kept", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(
    path,
    line({ role: "compactionSummary", summary: "S" }) + line({ role: "weird", extra: 1 }),
  );
  const [a, b] = await all(reading().read(ID));
  expect(a).toMatchObject({ kind: "compaction", summary: "S" });
  expect(b?.kind).toBe("unknown");
  expect(b).toMatchObject({ raw: { message: { role: "weird", extra: 1 } } });
});

test("a broken line is unknown with its text, not an error; blank lines are skipped", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(path, user("a") + "{not json\n\n" + user("b"));
  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown", "user"]);
  expect(records[1]).toMatchObject({ raw: "{not json", incomplete: false });
});

test("H3 a half-written tail is marked incomplete and is delivered again once whole", async () => {
  const path = journalOf("mvs_run1");
  const whole = assistant("second");
  writeFileSync(path, user("first") + whole.slice(0, 20));
  const first = await all(reading().read(ID));
  expect(first.map((r) => r.incomplete)).toEqual([false, true]);
  expect(await reading().coverage(ID, first[0]?.locator)).toEqual({ status: "not-scanned" });

  appendFileSync(path, whole.slice(20));
  const rest = await all(reading().read(ID, first[0]?.locator));
  expect(rest).toHaveLength(1);
  expect(rest[0]).toMatchObject({ kind: "assistant", text: "second", incomplete: false });

  // Resuming from the marked tail also reads it again, never past it.
  const again = await all(reading().read(ID, first[1]?.locator));
  expect(again).toHaveLength(1);
});

test("a locator resumes exactly, inside a multi-record line too", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(
    path,
    user("u1") +
      line({
        role: "assistant",
        content: [
          { type: "text", text: "t" },
          { type: "toolCall", id: "c", name: "n" },
        ],
      }) +
      user("u2"),
  );
  const full = await all(reading().read(ID));
  expect(full).toHaveLength(4);
  for (let i = 0; i < full.length; i += 1) {
    const rest = await all(reading().read(ID, full[i]?.locator));
    expect(rest.map((r) => r.locator)).toEqual(full.slice(i + 1).map((r) => r.locator));
  }
  expect(await reading().coverage(ID, full[3]?.locator)).toEqual({ status: "empty" });
});

test("a rewritten or truncated file is detected: read restarts, raw refuses the old locator", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(path, user("one") + user("two"));
  const [, second] = await all(reading().read(ID));
  const old = second?.locator as Locator;

  writeFileSync(path, user("ONE") + user("TWO") + user("THREE"));
  const restarted = await all(reading().read(ID, old));
  expect(restarted).toHaveLength(3);
  expect(restarted.map((r) => r.reanchored)).toEqual([true, undefined, undefined]);
  expect((await all(reading().read(ID, restarted[0]?.locator))).some((r) => r.reanchored === true)).toBe(false);
  await expect(reading().raw(ID, old)).rejects.toThrow("does not belong");

  writeFileSync(path, user("ONE"));
  expect(await all(reading().read(ID, old))).toHaveLength(1);
});

test("raw gives the harness's own record whole; coverage states what it does not know", async () => {
  const path = journalOf("mvs_run1");
  writeFileSync(path, user("hi"));
  const [rec] = await all(reading().read(ID));
  expect(await reading().raw(ID, rec?.locator as Locator)).toMatchObject({
    message: { role: "user", content: "hi" },
  });
  const missing = sessionId(harnessId("mcode-test"), "mvs_none");
  expect((await reading().coverage(missing)).status).toBe("unavailable");
  writeFileSync(path, "");
  expect(await reading().coverage(ID)).toEqual({ status: "empty" });
  await expect(reading().raw(ID, "bogus" as Locator)).rejects.toThrow("not of this side");
});
