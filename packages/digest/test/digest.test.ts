import { expect, test } from "bun:test";

import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";

import { DigestViewSchema, compress, cutMiddle, readWindow, sourceOf, withoutInsertions } from "../src/index.ts";
import type { DigestEntry, DigestView } from "../src/index.ts";

const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const base = (n: number) => ({ locator: at(n), incomplete: false });

const user = (n: number, text: string): SessionRecord => ({ kind: "user", text, ...base(n) });
const assistant = (n: number, text: string): SessionRecord => ({ kind: "assistant", text, ...base(n) });
const call = (n: number, callId: string, category: "shell" | "read" | "edit", target: string, input: unknown): SessionRecord => ({
  kind: "tool-call",
  callId,
  name: category === "shell" ? "Bash" : category === "read" ? "Read" : "Edit",
  category,
  target,
  input: input as never,
  ...base(n),
});
const result = (n: number, callId: string, output: string, ok = true): SessionRecord => ({ kind: "tool-result", callId, output, ok, ...base(n) });

const SESSION: SessionRecord[] = [
  user(1, "<system-reminder>be brief</system-reminder>\nFix the parser"),
  { kind: "thinking", text: "The parser is in src/parse.ts", redacted: false, ...base(2) },
  call(3, "c1", "read", "/repo/src/parse.ts", { file_path: "/repo/src/parse.ts" }),
  result(4, "c1", "export function parse() {}"),
  call(5, "c2", "edit", "/repo/src/parse.ts", { file_path: "/repo/src/parse.ts", old: "a", new: "b" }),
  result(6, "c2", "ok"),
  call(7, "c3", "shell", "bun test", { command: "bun test" }),
  result(8, "c3", "1 fail\nerror: expected 1", false),
  { kind: "checklist", items: [{ text: "read", state: "done" }, { text: "fix", state: "active" }], ...base(9) },
  assistant(10, "Fixed the parser."),
  { kind: "unknown", raw: { odd: true }, ...base(11) },
];

const entriesOf = (view: DigestView): DigestEntry[] => (view.mode === "digest" ? view.entries : []);

test("full keeps every record as the reading side gave it", () => {
  const { view, omitted } = compress(SESSION, "full");
  expect(view).toEqual({ mode: "full", records: SESSION });
  expect(omitted).toBe(0);
});

test("a digest keeps the messages whole, puts each call on one entry with its result, and drops what it cannot read", () => {
  const { view, files, omitted } = compress(SESSION, "digest");
  expect(DigestViewSchema.parse(view)).toEqual(view);
  const entries = entriesOf(view);
  expect(entries.map((entry) => entry.kind)).toEqual(["user", "thinking", "tool", "tool", "tool", "checklist", "assistant"]);
  // The harness's own insertion is not what the person said.
  expect(entries[0]).toMatchObject({ kind: "user", text: "Fix the parser" });
  // A path is written once, then referred to; the edit marks it changed.
  expect(entries[2]).toMatchObject({ category: "read", target: "[F1] /repo/src/parse.ts", status: "done", result: "export function parse() {}" });
  expect(entries[3]).toMatchObject({ category: "edit", target: "[F1]", status: "done" });
  expect((entries[3] as { args: string }).args).toContain('"file_path":"[F1]"');
  expect(entries[4]).toMatchObject({ category: "shell", target: "bun test", status: "failed" });
  expect(entries[5]).toMatchObject({ kind: "checklist", done: 1, total: 2 });
  expect(files).toEqual({ files: [{ id: 1, path: "/repo/src/parse.ts", changed: true }] });
  // Every entry names its record, and the result its own.
  expect(entries[2]).toMatchObject({ source: sourceOf(SESSION[2]!), resultSource: sourceOf(SESSION[3]!) });
  expect(omitted).toBe(1);
});

test("a digest cuts long arguments at 220 characters and long results in the middle, naming where they are whole", () => {
  const long = "x".repeat(1_000);
  const records = [call(1, "c", "shell", "echo", { command: long }), result(2, "c", `${"head\n".repeat(400)}${"tail\n".repeat(400)}`)];
  const [entry] = entriesOf(compress(records, "digest", { resultChars: 300 }).view) as Array<Extract<DigestEntry, { kind: "tool" }>>;
  expect(entry!.args!.length).toBe(220);
  expect(entry!.result!.startsWith("head\n")).toBe(true);
  expect(entry!.result!.endsWith("tail\n")).toBe(true);
  expect(entry!.result).toContain("whole at L2");
  expect(entry!.result!.length).toBeLessThanOrEqual(300);
});

test("a result that ends in an error keeps more of its end than its start", () => {
  const text = `${"a".repeat(2_000)}\n${"b".repeat(2_000)} error: boom`;
  const cut = cutMiddle(text, { keep: 400, source: "L1" });
  const [head, tail] = cut.split(/…⟨cut \d+ of \d+ chars, whole at L1⟩…/);
  expect(tail!.length).toBeGreaterThan(head!.length);
  expect(cut.endsWith("error: boom")).toBe(true);
  // A text that fits is left whole.
  expect(cutMiddle("short", { keep: 400, source: "L1" })).toBe("short");
});

test("a result whose call came before the reading is an entry of its own", () => {
  const entries = entriesOf(compress([result(9, "early", "done")], "digest").view);
  expect(entries).toEqual([{ kind: "result", callId: "early", status: "done", result: "done", source: sourceOf(result(9, "early", "done")) }]);
});

test("a brief says what was asked and answered, what changed, how many calls of each kind, the last checklist and the outcome", () => {
  const { view } = compress(SESSION, "brief");
  expect(view).toEqual({
    mode: "brief",
    brief: {
      asked: [{ text: "Fix the parser", source: sourceOf(SESSION[0]!) }],
      answered: [{ text: "Fixed the parser.", source: sourceOf(SESSION[9]!) }],
      changed: ["/repo/src/parse.ts"],
      calls: { read: 1, edit: 1, shell: 1 },
      failed: 1,
      checklist: { done: 1, total: 2, items: [{ text: "read", state: "done" }, { text: "fix", state: "active" }] },
      outcome: "answered",
    },
  });
  expect(compress([user(1, "go"), call(2, "c", "shell", "ls", {})], "brief").view).toMatchObject({ brief: { outcome: "working" } });
  expect(compress([], "brief").view).toMatchObject({ brief: { outcome: "empty", asked: [] } });
});

test("only a tag a harness wraps its insertions in is cut from what the person said", () => {
  expect(withoutInsertions("<environment_context>cwd</environment_context>hi <b>there</b>")).toBe("hi <b>there</b>");
});

async function* stream(records: readonly SessionRecord[]): AsyncIterable<SessionRecord> {
  yield* records;
}

test("windows fit the budget, never split records that share a locator, and carry the file index on", async () => {
  const shared: SessionRecord = { kind: "checklist", items: [{ text: "x", state: "pending" }], ...base(3) };
  const records = [
    call(1, "a", "read", "/r/a.ts", {}),
    result(2, "a", "y".repeat(400)),
    call(3, "b", "read", "/r/a.ts", {}),
    shared,
    result(4, "b", "z".repeat(400)),
  ];
  const first = await readWindow(stream(records), { mode: "digest", budget: 150 });
  expect(first.next).toBe(at(2));
  expect(entriesOf(first.view).map((entry) => entry.kind)).toEqual(["tool"]);

  const rest = records.slice(2);
  const second = await readWindow(stream(rest), { mode: "digest", budget: 20, files: first.files });
  // The call and the checklist share a locator: they are taken together, over the budget.
  expect(entriesOf(second.view).map((entry) => entry.kind)).toEqual(["tool", "checklist"]);
  expect(entriesOf(second.view)[0]).toMatchObject({ target: "[F1]" });
  expect(second.next).toBe(at(3));

  const last = await readWindow(stream(records.slice(4)), { mode: "digest", budget: 40, files: second.files });
  expect(last.next).toBeNull();
  expect(last.upto).toBe(at(4));
});

test("a window ends before a half-written record and does not move past it", async () => {
  const records = [user(1, "go"), { ...assistant(2, "hal"), incomplete: true }];
  const window = await readWindow(stream(records), { mode: "digest", budget: 10_000 });
  expect(entriesOf(window.view).map((entry) => entry.kind)).toEqual(["user"]);
  expect(window.next).toBe(at(1));
});

test("a nested session and a permission are entries of the digest", () => {
  const child = sessionId(harnessId("h"), "child");
  const entries = entriesOf(
    compress([{ kind: "nested", child, ...base(1) }, { kind: "permission", tool: "Bash", outcome: "denied", ...base(2) }], "digest").view,
  );
  expect(entries).toMatchObject([{ kind: "nested", child }, { kind: "permission", tool: "Bash", outcome: "denied" }]);
});

test("a record read again in another key order, with an absent field or without its raw data, has the same digest", () => {
  const record: SessionRecord = { kind: "tool-call", callId: "c", name: "Bash", category: "shell", target: "ls", input: { b: 1, a: 2 } as never, locator: at(1), incomplete: false };
  const again = { locator: at(1), incomplete: false, input: { a: 2, b: 1 }, target: "ls", category: "shell", name: "Bash", callId: "c", kind: "tool-call", at: undefined } as unknown as SessionRecord;
  expect(sourceOf(again)).toEqual(sourceOf(record));
  const unknown: SessionRecord = { kind: "unknown", raw: { whatever: true }, locator: at(2), incomplete: false };
  expect(sourceOf({ ...unknown, raw: undefined } as unknown as SessionRecord)).toEqual(sourceOf(unknown));
  expect(sourceOf({ ...record, target: "pwd" })).not.toEqual(sourceOf(record));
});
