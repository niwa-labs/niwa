// The ids niwa issues: `<prefix>-<hash>` of the identity of the creating call, the same for a replayed
// step, lengthened on a clash; short forms resolve per kind; list and get share one shape.

import { expect, test } from "bun:test";

import { AmbiguousId, ID_PREFIXES, IdIndex, IdRegistry, UnknownId, getRef, idSchema, issueId, listRef, EntityDescription } from "../src/index.ts";
import type { IdSeed, IssuedId } from "../src/index.ts";
import { z } from "zod";

const seed = (text: string): IdSeed => text as IdSeed;

test("an id is the prefix of its kind and 6 to 8 hex digits", () => {
  for (const kind of Object.keys(ID_PREFIXES) as Array<keyof typeof ID_PREFIXES>) {
    expect(issueId(kind, seed("inv:a/b/k"), [])).toMatch(new RegExp(`^${ID_PREFIXES[kind]}-[0-9a-f]{6}$`));
  }
});

test("the same operation gets the same id, another operation another", () => {
  const first = issueId("task", seed("inv:h:rec_1/0"), []);
  expect(issueId("task", seed("inv:h:rec_1/0"), [])).toBe(first);
  expect(issueId("task", seed("inv:h:rec_1/1"), [])).not.toBe(first);
  expect(issueId("message", seed("inv:h:rec_1/0"), [])).not.toBe(first);
});

test("a replayed seed finds the id it was given, whatever else exists", () => {
  const first = issueId("task", seed("op1"), []);
  const other: IssuedId = { id: issueId("task", seed("op2"), []), seed: "op2" };
  expect(issueId("task", seed("op1"), [other, { id: first, seed: "op1" }])).toBe(first);
});

test("a clash lengthens the hash, then fails at eight digits", () => {
  const short = issueId("task", seed("op1"), []);
  const clash: IssuedId = { id: short, seed: "someone-else" };
  const longer = issueId("task", seed("op1"), [clash]);
  expect(longer).toHaveLength(short.length + 1);
  expect(longer.startsWith(short)).toBe(true);
  const eight = issueId("task", seed("op1"), [clash, { id: longer, seed: "x" }]);
  expect(eight).toHaveLength(short.length + 2);
  expect(() => issueId("task", seed("op1"), [clash, { id: longer, seed: "x" }, { id: eight, seed: "y" }])).toThrow("no free task id");
});

test("the schema of a kind accepts only its own format", () => {
  const task = idSchema("task");
  expect(task.safeParse("task-3fa9c2").success).toBe(true);
  expect(task.safeParse("msg-3fa9c2").success).toBe(false);
  expect(task.safeParse("task-3fa9c").success).toBe(false);
  expect(task.safeParse("task-3fa9c2d41").success).toBe(false);
});

test("a registered kind resolves a prefix, a suffix and the id; several is ambiguous", () => {
  const ids = ["task-aa1111", "task-aa2222", "task-bb3333"];
  const registry = new IdRegistry();
  const index = registry.register("task", () => ids.map((id) => ({ id, seed: id })));
  expect(String(index.resolve("task-bb3333"))).toBe("task-bb3333");
  expect(String(index.resolve("task-bb"))).toBe("task-bb3333");
  expect(String(index.resolve("2222"))).toBe("task-aa2222");
  expect(index.resolve("nothing")).toBeUndefined();
  expect(() => index.resolve("task-aa")).toThrow(AmbiguousId);
  expect(() => index.resolve("task-aa")).toThrow(expect.objectContaining({ candidates: ["task-aa1111", "task-aa2222"] }));
  expect(() => index.require("zzz")).toThrow(UnknownId);
  expect(index.resolve("task-aa1", (id) => id !== "task-aa1111")).toBeUndefined();
  expect(registry.resolve("task-bb")).toEqual({ kind: "task", id: "task-bb3333" });
  expect(registry.resolve("msg-bb")).toBeUndefined();
  expect(() => registry.register("task", () => [])).toThrow("registered already");
});

test("a lengthened id does not make the shorter one ambiguous", () => {
  const index = new IdIndex("task", () => [
    { id: "task-aa1111", seed: "op1" },
    { id: "task-aa111122", seed: "op2" },
  ]);
  expect(String(index.resolve("task-aa1111"))).toBe("task-aa1111");
  expect(String(index.resolve("task-aa11112"))).toBe("task-aa111122");
});

test("the index issues from its live source", () => {
  const held: IssuedId[] = [];
  const index = new IdIndex("run", () => held);
  const id = index.issue(seed("op"));
  held.push({ id, seed: "op" });
  expect(String(index.issue(seed("op")))).toBe(id);
  expect(index.ids().map(String)).toEqual([id]);
});

test("list and get are declared uniformly", () => {
  const list = listRef("task.list", { kind: "task", noun: "task", filter: { open: z.boolean().optional() }, item: { state: z.string() } });
  expect(list.input.parse({})).toEqual({});
  expect(list.output.parse({ items: [{ id: "task-aa1111", description: "Fix the door", state: "open" }] }).items).toHaveLength(1);
  expect(() => list.output.parse({ items: [{ id: "task-aa1111", description: "x", state: "open" }] })).toThrow();
  const get = getRef("task.get", { kind: "task", noun: "task", entity: z.object({ id: idSchema("task"), text: z.string() }) });
  expect(String(get.input.parse({ id: "aa11" }).id)).toBe("aa11");
  expect(get.description).toContain("task");
});

test("a description is a few words on one line", () => {
  expect(EntityDescription.safeParse("Fix the door").success).toBe(true);
  expect(EntityDescription.safeParse("ab").success).toBe(false);
  expect(EntityDescription.safeParse("a".repeat(61)).success).toBe(false);
  expect(EntityDescription.safeParse("two\nlines").success).toBe(false);
});
