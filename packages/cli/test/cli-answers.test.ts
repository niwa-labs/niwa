// How the CLI reads what a host answered: by the schemas the host answers with, not by guards of its own.

import { expect, test } from "bun:test";

import { renderAnswer } from "@niwa-labs/cli";

const RECORD = {
  id: "r1",
  seq: 7,
  stream: "main",
  type: "note.written",
  schema: 1,
  data: { text: "hello" },
  actor: { kind: "host" },
  cause: null,
  root: "r1",
  at: 1,
};

test("a read of records is printed as records, with the position to read after", () => {
  const out = renderAnswer({ records: [RECORD], next: 7 }, "text");
  expect(out).toContain("note.written");
  expect(out).toContain("next: 7");
});

test("a trace is printed with the depth of each record", () => {
  const shallow = renderAnswer([{ ...RECORD, depth: 0 }], "text");
  const deep = renderAnswer([{ ...RECORD, depth: 2 }], "text");
  expect(deep).toBe(`    ${shallow}`);
  expect(deep).toContain("note.written");
});

test("a list of records without a depth is printed as records", () => {
  const out = renderAnswer([RECORD], "text");
  expect(out).toContain("note.written");
  expect(out).not.toContain("next:");
});

test("a value that only looks like a read is printed as the value it is", () => {
  const looksLikeRead = { records: [{ id: "r1", seq: "seven", type: 3 }], next: 1 };
  const out = renderAnswer(looksLikeRead, "text");
  expect(out).toBe("records: id: r1\nseq: seven\ntype: 3\nnext: 1");
});

test("a value that only looks like a description is printed as the value it is", () => {
  const out = renderAnswer({ actions: ["a"], types: ["b"] }, "text");
  expect(out).toBe("actions: a\ntypes: b");
});

test("a description is printed as the list of actions and types", () => {
  const description = {
    actions: [
      {
        name: "note.add",
        description: "Adds a note.",
        recovery: "repeat",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        output: { type: "object" },
      },
    ],
    types: [{ name: "note.written", version: 1, schema: { type: "object" } }],
  };
  const out = renderAnswer(description, "text");
  expect(out).toContain("note.add");
  expect(out).toContain("text: string");
  expect(out).toContain("note.written (v1)");
});
