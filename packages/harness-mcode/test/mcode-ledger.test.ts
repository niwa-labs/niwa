// The MiniMax Code reading side against sessions that kept their history in the ledger: the
// sessions that have no journal of their own, and the ones whose journal holds nothing.
//
// The fixtures are the shapes a real ledger holds (small, anonymised): an entry of the history the
// agent was given, an entry of what the user saw, and the bookkeeping entries between them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { Locator, SessionRecord } from "@niwa-labs/harness";

import { McodeReading } from "../src/mcode/reading.ts";
import { tempDirSync } from "@niwa-labs/testing";

let home: string;
const reading = () => new McodeReading({ harness: harnessId("mcode-test"), home });

beforeEach(() => {
  home = tempDirSync("mcode-ledger");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The directory of a session: it holds the manifest, and maybe a journal and a ledger. */
function sessionDir(native: string): string {
  const encoded = Buffer.from(native).toString("base64url");
  const dir = join(home, "v2", "sessions", "2026", "10", "07", `12-00-00-000-session_${encoded}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ sessionId: native, createdAtMs: 1000, updatedAtMs: 2000 }),
  );
  return dir;
}

/** An entry of the ledger, as the ledger writes it. */
const entry = (event: object): string => `${JSON.stringify(event)}\n`;

/** The entry that says the session was made. */
const created = (native: string): string =>
  entry({
    kind: "session.created",
    sessionId: native,
    record: { sessionId: native, workspaceDir: "/work/ledger", sessionType: "root" },
    schemaVersion: 1,
    seq: 1,
    createdAtMs: 1000,
  });

/** The entry that says the session was snapshotted: bookkeeping, it carries no turn. */
const snapshot = (seq: number): string =>
  entry({
    kind: "session.snapshot_created",
    sessionId: "mvs_led",
    snapshotId: "snapshot_1",
    schemaVersion: 1,
    seq,
    createdAtMs: 2000,
  });

/** The entry that carries a piece of the history the agent was given. */
const history = (messages: object[], seq: number): string =>
  entry({
    kind: "message.pi_history_appended",
    sessionId: "mvs_led",
    messages,
    schemaVersion: 1,
    seq,
    createdAtMs: 3000,
  });

/** The entry that carries what the user saw. */
const display = (message: object, seq: number): string =>
  entry({
    kind: "message.display_upserted",
    sessionId: "mvs_led",
    message,
    schemaVersion: 1,
    seq,
    createdAtMs: 4000,
  });

async function all(iter: AsyncIterable<SessionRecord>): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

const ID = sessionId(harnessId("mcode-test"), "mvs_led");

test("a session with no journal is read from its ledger", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      snapshot(2) +
      history(
        [
          {
            role: "user",
            content: [{ type: "text", text: "how do I read a ledger" }],
            timestamp: 1000,
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "the ledger holds the turns" },
              { type: "text", text: "read it line by line" },
              { type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "/x" } },
            ],
            timestamp: 2000,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "the bytes" }],
            isError: false,
            timestamp: 3000,
          },
        ],
        3,
      ),
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual([
    "user",
    "unknown",
    "assistant",
    "tool-call",
    "tool-result",
  ]);
  expect(records[0]).toMatchObject({ kind: "user", text: "how do I read a ledger", at: 1000 });
  expect(records[2]).toMatchObject({ kind: "assistant", text: "read it line by line" });
  expect(records[3]).toMatchObject({ kind: "tool-call", callId: "call_1", name: "read" });
  expect(records[4]).toMatchObject({ kind: "tool-result", callId: "call_1", ok: true });

  // The session states the directory it runs in.
  const infos = [];
  for await (const info of reading().list()) infos.push(info);
  expect(infos[0]?.cwd).toBe("/work/ledger");
});

test("an empty journal falls back to the ledger of the session", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(join(dir, "messages.jsonl"), "");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history([{ role: "user", content: [{ type: "text", text: "only in the ledger" }], timestamp: 1000 }], 2),
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "only in the ledger" });
});

test("a journal with records in it is never read together with the ledger", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "messages.jsonl"),
    `${JSON.stringify({
      message_id: "m",
      message: { role: "user", timestamp: 1, content: "from the journal" },
    })}\n`,
  );
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history([{ role: "user", content: [{ type: "text", text: "from the ledger" }], timestamp: 1 }], 2),
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "from the journal" });
});

test("a ledger of display entries is read when it holds no history", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      display(
        {
          msg_id: "umsg_1",
          role: "user",
          msg_type: 1,
          msg_content: "what is the weather",
          timestamp: 1000,
        },
        2,
      ) +
      display(
        {
          msg_id: "msg_1",
          role: "assistant",
          msg_type: 2,
          msg_content: "it is warm",
          thinking_content: "the answer is short",
          timestamp: 2000,
          tool_calls: [
            {
              tool_name: "bash",
              tool_call_id: "call_9",
              tool_call_args: '{"command":"weather"}',
              tool_call_status: 2,
            },
          ],
        },
        3,
      ),
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown", "assistant", "tool-call"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "what is the weather" });
  expect(records[2]).toMatchObject({ kind: "assistant", text: "it is warm" });
  expect(records[3]).toMatchObject({
    kind: "tool-call",
    callId: "call_9",
    name: "bash",
    input: { command: "weather" },
  });
});

test("a replaced history replaces what came before it", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history([{ role: "user", content: [{ type: "text", text: "before" }], timestamp: 1000 }], 2) +
      entry({
        kind: "message.pi_history_replaced",
        sessionId: "mvs_led",
        messages: [{ role: "user", content: [{ type: "text", text: "after" }], timestamp: 2000 }],
        schemaVersion: 1,
        seq: 3,
        createdAtMs: 3000,
      }),
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user"]);
  expect(records[0]).toMatchObject({ kind: "user", text: "after", at: 2000 });
});

test("a locator of the ledger resumes exactly, and raw gives the entry whole", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history(
        [
          { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
          { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2000 },
        ],
        2,
      ),
  );

  const full = await all(reading().read(ID));
  expect(full).toHaveLength(2);
  for (let i = 0; i < full.length; i += 1) {
    const rest = await all(reading().read(ID, full[i]?.locator));
    expect(rest.map((r) => r.locator)).toEqual(full.slice(i + 1).map((r) => r.locator));
  }
  expect(await reading().coverage(ID, full[1]?.locator)).toEqual({ status: "empty" });
  expect(await reading().coverage(ID)).toEqual({ status: "not-scanned" });

  const raw = await reading().raw(ID, full[0]?.locator as Locator);
  expect(raw).toMatchObject({ kind: "message.pi_history_appended" });
});

test("a line of the ledger that is not JSON is unknown with its text", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history([{ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 }], 2) +
      "not json at all\n",
  );

  const records = await all(reading().read(ID));
  expect(records.map((r) => r.kind)).toEqual(["user", "unknown"]);
  expect(records[1]).toMatchObject({ raw: "not json at all" });
});

test("a session with an empty journal and no ledger holds nothing", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(join(dir, "messages.jsonl"), "");
  expect(await all(reading().read(ID))).toHaveLength(0);
  expect(await reading().coverage(ID)).toEqual({ status: "empty" });
});

test("a ledger that is there but cannot be read fails instead of reading as empty", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(join(dir, "messages.jsonl"), "");
  // A directory where the ledger should be: it exists, and it cannot be read as a file.
  mkdirSync(join(dir, "ledger.jsonl"));
  await expect(all(reading().read(ID))).rejects.toThrow();
});

const message = (role: "user" | "assistant", text: string, at: number) => ({
  role,
  content: [{ type: "text", text }],
  timestamp: at,
});

test("a read from a checkpoint in the ledger gives only what came after it, across entries", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") +
      history([message("user", "one", 1000)], 2) +
      history([message("assistant", "two", 2000)], 3) +
      history([message("user", "three", 3000)], 4),
  );

  const full = await all(reading().read(ID));
  expect(full.map((r) => (r.kind === "user" || r.kind === "assistant" ? r.text : r.kind))).toEqual([
    "one",
    "two",
    "three",
  ]);
  const second = await all(reading().read(ID, full[1]?.locator));
  expect(second.map((r) => (r.kind === "user" ? r.text : r.kind))).toEqual(["three"]);
  expect(await reading().coverage(ID, full[1]?.locator)).toEqual({ status: "not-scanned" });
  expect(await reading().coverage(ID, full[2]?.locator)).toEqual({ status: "empty" });
  expect(await all(reading().read(ID, full[2]?.locator))).toEqual([]);
});

test("a checkpoint of a ledger that was rewritten starts the read over", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") + history([message("user", "one", 1000)], 2) + history([message("user", "two", 2000)], 3),
  );
  const [, second] = await all(reading().read(ID));
  writeFileSync(
    join(dir, "ledger.jsonl"),
    created("mvs_led") + history([message("user", "other", 1000)], 2) + history([message("user", "again", 2000)], 3),
  );
  const again = await all(reading().read(ID, second?.locator));
  expect(again.map((r) => (r.kind === "user" ? r.text : r.kind))).toEqual(["other", "again"]);
});

test("the coverage of a ledger that cannot be read is failed, not an error", async () => {
  const dir = sessionDir("mvs_led");
  writeFileSync(join(dir, "messages.jsonl"), "");
  mkdirSync(join(dir, "ledger.jsonl"));
  expect((await reading().coverage(ID)).status).toBe("failed");
});
