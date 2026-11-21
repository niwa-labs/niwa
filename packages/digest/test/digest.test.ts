import { expect, test } from "bun:test";

import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";

import { DigestViewSchema, FileIndexSchema, FileIndexer, compress, cutMiddle, readWindow, sourceOf, withoutInsertions } from "../src/index.ts";
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

const briefOf = (view: DigestView) => (view.mode === "brief" ? view.brief : undefined);

test("a brief window is charged for the paths and counters it grows, and keeps nothing a brief does not use", async () => {
  const records: SessionRecord[] = [];
  for (let n = 0; n < 100; n += 1) {
    records.push(call(2 * n + 1, `c${String(n)}`, "edit", `/repo/src/file-${String(n)}.ts`, { file_path: `/repo/src/file-${String(n)}.ts` }));
    records.push(result(2 * n + 2, `c${String(n)}`, "x".repeat(5_000)));
  }
  const window = await readWindow(stream(records), { mode: "brief", budget: 20 });
  expect(window.next).not.toBeNull();
  const brief = briefOf(window.view)!;
  expect(brief.changed.length).toBeGreaterThan(0);
  expect(brief.changed.length).toBeLessThan(100);
  // Paths already named cost nothing more.
  const again = records.map((record, index) => (record.kind === "tool-call" ? call(index + 1, record.callId, "edit", "/repo/same.ts", {}) : record));
  const same = await readWindow(stream(again), { mode: "brief", budget: 20 });
  expect(same.next).toBeNull();
  expect(briefOf(same.view)!.changed).toEqual(["/repo/same.ts"]);
});

test("a message is cut only of the tags harnesses wrap their insertions in, and is otherwise left as it was written", () => {
  expect(withoutInsertions("Render <user-card>Ada</user-card> here")).toBe("Render <user-card>Ada</user-card> here");
  expect(withoutInsertions("  indented\n\n\n\n    code\n")).toBe("  indented\n\n\n\n    code\n");
  expect(withoutInsertions("<system-reminder>x</system-reminder>\n\n\n<user-card/>hi")).toBe("<user-card/>hi");
  const only = user(1, "<user-card>Ada</user-card>");
  expect(entriesOf(compress([only], "digest").view)).toMatchObject([{ kind: "user", text: "<user-card>Ada</user-card>" }]);
  expect(briefOf(compress([only], "brief").view)!.asked).toHaveLength(1);
});

test("a path is replaced where the call names it whole, once, and not inside other words or references", () => {
  const files = new FileIndexer();
  files.name("a", false);
  files.name("b", false);
  expect(files.refer("cat data a b")).toBe("cat data [F1] [F2]");
  expect(files.refer("cat a/b a.txt ab -a")).toBe("cat a/b a.txt ab -a");
  const odd = new FileIndexer();
  odd.name("/p/a", false);
  odd.name("F1", false);
  expect(odd.refer("/p/a F1 [F1]")).toBe("[F1] [F2] [[F2]]");
  const index = new FileIndexer();
  index.name("/repo/x.ts", false);
  expect(index.refer('{"file_path":"/repo/x.ts","other":"/repo/x.tsx"}')).toBe('{"file_path":"[F1]","other":"/repo/x.tsx"}');
});

test("a path with spaces is a path of the index", () => {
  const records = [call(1, "r", "read", "docs/Release Notes.md", {}), call(2, "e", "edit", "docs/Release Notes.md", {})];
  const { view, files } = compress(records, "digest");
  expect(entriesOf(view).map((entry) => (entry as { target: string }).target)).toEqual(["[F1] docs/Release Notes.md", "[F1]"]);
  expect(files.files).toEqual([{ id: 1, path: "docs/Release Notes.md", changed: true }]);
});

test("a file index keeps its ids and paths unique, and goes on after the highest id it holds", () => {
  expect(FileIndexSchema.safeParse({ files: [{ id: 1, path: "a", changed: false }, { id: 1, path: "b", changed: false }] }).success).toBe(false);
  expect(FileIndexSchema.safeParse({ files: [{ id: 1, path: "a", changed: false }, { id: 2, path: "a", changed: false }] }).success).toBe(false);
  const files = new FileIndexer({ files: [{ id: 2, path: "/a", changed: false }] });
  expect(files.name("/b", false)).toBe("[F3] /b");
  expect(files.index().files.map((file) => file.id)).toEqual([2, 3]);
});

test("a cut says how much it removed, and fits the size asked for", () => {
  const text = "line of text\n".repeat(40);
  const sizes = [5, 12, 20, 30, 45, 60, 80, 100, 150];
  for (const keep of sizes) {
    const out = cutMiddle(text, { keep, source: "L12345" });
    expect(out.length).toBeLessThanOrEqual(keep);
    const marker = /…⟨cut (\d+)(?: of (\d+) chars, whole at L12345)?⟩…/.exec(out);
    if (marker === null) continue;
    expect(Number(marker[1])).toBe(text.length - out.replace(marker[0], "").length);
  }
  // The marker with its source does not fit in 20, the one that only counts does.
  expect(/cut \d+⟩/.test(cutMiddle(text, { keep: 20, source: "L12345" }))).toBe(true);
});

test("only the changes that were not refused are in a brief", () => {
  const records = [
    call(1, "a", "edit", "/r/refused.ts", {}),
    result(2, "a", "denied", false),
    call(3, "b", "edit", "/r/done.ts", {}),
    result(4, "b", "ok"),
    call(5, "c", "edit", "/r/again.ts", {}),
    result(6, "c", "no", false),
    call(7, "d", "edit", "/r/again.ts", {}),
    call(8, "e", "edit", "/r/waiting.ts", {}),
  ];
  expect(briefOf(compress(records, "brief").view)!.changed).toEqual(["/r/done.ts", "/r/again.ts", "/r/waiting.ts"]);
});

test("a window that ends inside a turn gives its last message as one the turn may still replace", async () => {
  const records = [user(1, "go"), assistant(2, "checking"), call(3, "c", "shell", "ls", {}), result(4, "c", "x"), assistant(5, "fixed")];
  const whole = briefOf((await readWindow(stream(records), { mode: "brief", budget: 10_000 })).view)!;
  expect(whole.answered.map((said) => said.text)).toEqual(["fixed"]);
  expect(whole.tentative).toBeUndefined();
  const first = await readWindow(stream(records), { mode: "brief", budget: 34 });
  expect(first.next).not.toBeNull();
  const brief = briefOf(first.view)!;
  expect(brief.answered).toEqual([]);
  expect(brief.tentative?.text).toBe("checking");
  // A turn that a message from the person closes is answered.
  const closed = briefOf(compress([user(1, "go"), assistant(2, "done"), user(3, "more")], "brief", { more: true }).view)!;
  expect(closed.answered.map((said) => said.text)).toEqual(["done"]);
  expect(closed.tentative).toBeUndefined();
});


test("a message whose reader marked what was inserted loses exactly those ranges and keeps every other character", () => {
  const text = "<system-reminder>be brief</system-reminder>\n\nFix <user-card>the</user-card> parser";
  const marked: SessionRecord = { kind: "user", text, inserted: [{ from: 0, to: 45, origin: "harness" }], ...base(1) };
  expect(entriesOf(compress([marked], "digest").view)[0]).toMatchObject({ kind: "user", text: "Fix <user-card>the</user-card> parser" });
  // A reader that marked nothing says the whole text was written by the person, even a tag of a harness.
  const typed: SessionRecord = { kind: "user", text: "explain <system-reminder>x</system-reminder> to me", inserted: [], ...base(2) };
  expect(entriesOf(compress([typed], "digest").view)[0]).toMatchObject({ text: "explain <system-reminder>x</system-reminder> to me" });
  // A reader that does not say leaves the tags of the known harnesses to be cut.
  expect(entriesOf(compress([user(3, "<system-reminder>x</system-reminder>hello")], "digest").view)[0]).toMatchObject({ text: "hello" });
});

test("a message that is all insertion leaves nothing, in a digest and in a brief", () => {
  const all: SessionRecord = { kind: "user", text: "preamble", inserted: [{ from: 0, to: 8, origin: "harness" }], ...base(1) };
  expect(compress([all], "digest")).toMatchObject({ view: { entries: [] }, omitted: 1 });
  expect(briefOf(compress([all], "brief").view)?.asked).toEqual([]);
});

test("an image is a marker where it stood, also in a message with no words and in text that had an insertion cut", () => {
  const only: SessionRecord = { kind: "user", text: "", images: [{ at: 0, mime: "image/png" }], ...base(1) };
  const entry = entriesOf(compress([only], "digest").view)[0];
  expect(entry).toMatchObject({ kind: "user", text: "[image image/png]", source: { locator: at(1) } });
  expect(briefOf(compress([only], "brief").view)?.asked).toMatchObject([{ text: "[image image/png]" }]);

  const mixed: SessionRecord = {
    kind: "user",
    text: "see <agent-context>c</agent-context>this and that",
    inserted: [{ from: 4, to: 36, origin: "harness" }],
    images: [{ at: 4 }, { at: 44 }],
    ...base(2),
  };
  expect(entriesOf(compress([mixed], "digest").view)[0]).toMatchObject({ text: "see [image]this and[image] that" });
});

test("an image in a tool result is a marker among its blocks, and the result is told without its payload", () => {
  const call1: SessionRecord = { kind: "tool-call", callId: "c1", name: "read", category: "read", target: "/a.png", ...base(1) };
  const list: SessionRecord = { kind: "tool-result", callId: "c1", output: [{ type: "text", text: "a" }, { type: "text", text: "b" }], images: [{ at: 1 }], ...base(2) };
  const [tool] = entriesOf(compress([call1, list], "digest").view);
  expect(tool).toMatchObject({ kind: "tool", result: '[{"type":"text","text":"a"},"[image]",{"type":"text","text":"b"}]' });
  const alone: SessionRecord = { kind: "tool-result", callId: "c1", images: [{ at: 0, mime: "image/jpeg" }], ...base(2) };
  expect(entriesOf(compress([call1, alone], "digest").view)[0]).toMatchObject({ result: "[image image/jpeg]" });
  const text: SessionRecord = { kind: "tool-result", callId: "c1", output: "ab", images: [{ at: 1 }], ...base(2) };
  expect(entriesOf(compress([call1, text], "digest").view)[0]).toMatchObject({ result: "a[image]b" });
});

test("a call that names several files is all of them in the digest and in the brief, and counts them in the window", async () => {
  const patch: SessionRecord = { kind: "tool-call", callId: "p1", name: "apply_patch", category: "edit", target: "/r/a.ts", paths: ["/r/a.ts", "/r/b.ts"], ...base(1) };
  const done: SessionRecord = { kind: "tool-result", callId: "p1", output: "ok", ok: true, ...base(2) };
  const { view, files } = compress([patch, done], "digest");
  expect(entriesOf(view)[0]).toMatchObject({ target: "[F1] /r/a.ts, [F2] /r/b.ts" });
  expect(files.files.map((file) => [file.path, file.changed])).toEqual([["/r/a.ts", true], ["/r/b.ts", true]]);
  expect(briefOf(compress([patch, done], "brief").view)?.changed).toEqual(["/r/a.ts", "/r/b.ts"]);
  // A refused patch changed neither.
  expect(briefOf(compress([patch, { ...done, ok: false } as SessionRecord], "brief").view)?.changed).toEqual([]);
  const window = await readWindow(
    (async function* () {
      yield patch;
      yield done;
    })(),
    { mode: "brief", budget: 1_000 },
  );
  expect(briefOf(window.view)?.changed).toEqual(["/r/a.ts", "/r/b.ts"]);
});

test("a window says its reading started over when the first record says so, and a record that goes on does not", async () => {
  const first: SessionRecord = { kind: "assistant", text: "from the top", reanchored: true, ...base(1) };
  const read = async (records: SessionRecord[], mode: "digest" | "brief" | "full") =>
    await readWindow(
      (async function* () {
        yield* records;
      })(),
      { mode, budget: 1_000 },
    );
  for (const mode of ["digest", "brief", "full"] as const) {
    expect((await read([first, assistant(2, "more")], mode)).restarted).toBe(true);
    expect((await read([assistant(2, "more")], mode)).restarted).toBe(false);
  }
  expect(compress([first], "digest").restarted).toBe(true);
});
