import { expect, test } from "bun:test";

import { SessionRecordSchema, ToolCallRecordSchema, UserRecordSchema } from "@niwa-labs/harness";

const base = { locator: "l1", incomplete: false };

test("a user record keeps the ranges that were inserted and the images that stood in it", () => {
  const record = SessionRecordSchema.parse({
    kind: "user",
    text: "look <reminder>x</reminder> here",
    inserted: [{ from: 5, to: 25, origin: "harness" }],
    images: [{ at: 4, mime: "image/png" }],
    ...base,
  });
  expect(record).toMatchObject({ inserted: [{ from: 5, to: 25, origin: "harness" }], images: [{ at: 4, mime: "image/png" }] });
});

test("a user record that says nothing of insertions leaves the field absent, not empty", () => {
  const record = UserRecordSchema.parse({ kind: "user", text: "hi", ...base });
  expect("inserted" in record).toBe(false);
  expect("images" in record).toBe(false);
});

test("an inserted range is never empty or backwards", () => {
  for (const range of [{ from: 3, to: 3 }, { from: 5, to: 2 }]) {
    expect(UserRecordSchema.safeParse({ kind: "user", text: "abcdefgh", inserted: [{ ...range, origin: "hook" }], ...base }).success).toBe(false);
  }
  expect(UserRecordSchema.safeParse({ kind: "user", text: "ab", inserted: [{ from: 0, to: 1, origin: "unknown-origin" }], ...base }).success).toBe(false);
});

test("a call that names several paths keeps all of them", () => {
  const call = ToolCallRecordSchema.parse({ kind: "tool-call", callId: "c1", name: "apply_patch", category: "edit", target: "a.ts", paths: ["a.ts", "b.ts"], ...base });
  expect(call.paths).toEqual(["a.ts", "b.ts"]);
  expect(ToolCallRecordSchema.safeParse({ kind: "tool-call", callId: "c1", name: "x", category: "edit", paths: [], ...base }).success).toBe(false);
});

test("the first record of a read that started over says so", () => {
  const record = SessionRecordSchema.parse({ kind: "assistant", text: "hi", reanchored: true, ...base });
  expect(record.reanchored).toBe(true);
  expect(SessionRecordSchema.safeParse({ kind: "assistant", text: "hi", reanchored: false, ...base }).success).toBe(false);
});
