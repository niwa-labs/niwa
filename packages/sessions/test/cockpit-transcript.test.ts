// A transcript as the session page draws it.

import { expect, test } from "bun:test";

import { TranscriptRecord } from "../src/cockpit/actions.ts";
import { itemsOf } from "../src/cockpit/transcript.ts";

test("turns keep their order and say who spoke", () => {
  const items = itemsOf([
    { kind: "user", text: "hi", locator: "1" },
    { kind: "assistant", text: "hello", model: "m", locator: "2" },
  ]);
  expect(items).toMatchObject([
    { kind: "turn", role: "user", text: "hi", key: "1" },
    { kind: "turn", role: "assistant", text: "hello", model: "m" },
  ]);
});

test("chat hides marked metadata and injected text, while preserving the messages and tool output", () => {
  const records = [
    { kind: "unknown", metadata: true },
    { kind: "user", text: "startup", inserted: [{ from: 0, to: 7, origin: "harness" }] },
    { kind: "user", text: "before startup after", inserted: [{ from: 7, to: 15, origin: "harness" }] },
    { kind: "user", text: "context", inserted: [{ from: 0, to: 7, origin: "harness" }], images: [{ at: 7, mime: "image/png" }] },
    { kind: "user", text: "# AGENTS.md instructions copied for review" },
    { kind: "tool-call", callId: "c", name: "exec", input: { cmd: "bun test" } },
    { kind: "tool-result", callId: "c", output: "ok" },
    { kind: "assistant", text: "Done" },
    { kind: "unknown" },
  ].map((record) => TranscriptRecord.parse(record));
  expect(itemsOf(records)).toMatchObject([
    { kind: "turn", role: "user", text: "before after", key: "#2" },
    { kind: "turn", role: "user", text: "[image]" },
    { kind: "turn", role: "user", text: "# AGENTS.md instructions copied for review" },
    { kind: "tool", name: "exec", input: { cmd: "bun test" }, output: "ok" },
    { kind: "turn", role: "assistant", text: "Done" },
    { kind: "note", label: "Unrecognised record" },
  ]);
});

test("a tool result joins its call by id, wherever it lies after it", () => {
  const records: TranscriptRecord[] = [
    { kind: "tool-call", callId: "c1", name: "read", input: { path: "a" } },
    { kind: "tool-call", callId: "c2", name: "write", input: {} },
    { kind: "tool-result", callId: "c2", ok: false, output: "denied" },
    { kind: "tool-result", callId: "c1", output: "text" },
  ];
  expect(itemsOf(records)).toMatchObject([
    { kind: "tool", name: "read", input: { path: "a" }, output: "text", state: "done" },
    { kind: "tool", name: "write", output: "denied", state: "failed" },
  ]);
});

test("a call with no result is running, and a result whose call lies before the window stands alone", () => {
  const items = itemsOf([
    { kind: "tool-result", callId: "early", name: "grep", output: "x" },
    { kind: "tool-call", callId: "late", name: "bash" },
  ]);
  expect(items).toMatchObject([
    { kind: "tool", name: "grep", state: "done", input: undefined },
    { kind: "tool", name: "bash", state: "running" },
  ]);
});

test("notes name the nested session and keep a sealed thought sealed", () => {
  const items = itemsOf([
    { kind: "thinking", text: "secret", redacted: true },
    { kind: "compaction", summary: "so far" },
    { kind: "nested", child: { harness: "claude", native: "abc" } },
    { kind: "unknown" },
  ]);
  expect(items.map((item) => (item.kind === "note" ? [item.label, item.text] : item.kind))).toEqual([
    ["Thinking", "Kept sealed by the harness."],
    ["Compacted", "so far"],
    ["Nested session", "claude/abc"],
    ["Unrecognised record", ""],
  ]);
});

test("a record without a locator is keyed by its place", () => {
  expect(itemsOf([{ kind: "user", text: "a" }, { kind: "user", text: "b" }]).map((item) => item.key)).toEqual(["#0", "#1"]);
});

test("a checklist is drawn as how far it is, and a permission as its tool and outcome", () => {
  const items = itemsOf([
    { kind: "checklist", items: [{ text: "a", state: "done" }, { text: "b", state: "active" }] },
    { kind: "permission", tool: "Bash", outcome: "denied" },
  ]);
  expect(items.map((item) => (item.kind === "note" ? [item.label, item.text] : item.kind))).toEqual([
    ["Checklist", "1 of 2 done"],
    ["Permission", "Bash: denied"],
  ]);
});
