import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { unreadable, unsendable } from "../src/index.ts";

describe("what a narrower schema can read of another", () => {
  const written = z.object({ id: z.string(), state: z.enum(["a", "b"]), when: z.number().int(), tags: z.array(z.object({ name: z.string(), extra: z.boolean() })), note: z.string().optional() });

  test("a reader of some of the fields reads it", () => {
    const reader = z.object({ id: z.string(), state: z.enum(["a", "b", "c"]), when: z.number(), tags: z.array(z.object({ name: z.string() })), note: z.string().optional() });
    expect(unreadable(reader, written)).toEqual([]);
  });

  test("a field the writer has not, or may leave out, is not read", () => {
    expect(unreadable(z.object({ gone: z.string() }), written)).toEqual(["$.gone: the writer has no such field"]);
    expect(unreadable(z.object({ note: z.string() }), written)).toEqual(["$.note: the reader needs it, the writer may leave it out"]);
  });

  test("a type that changed, and a value an enum gained, are not read", () => {
    expect(unreadable(z.object({ id: z.number() }), written)[0]).toContain("$.id: the type string is not read as number");
    expect(unreadable(z.object({ state: z.enum(["a"]) }), written)).toEqual(['$.state: the values ["b"] are not read']);
  });

  test("a union is read when each of its variants is", () => {
    const union = z.discriminatedUnion("kind", [z.object({ kind: z.literal("x"), n: z.number() }), z.object({ kind: z.literal("y") })]);
    expect(unreadable(z.object({ kind: z.string() }), union)).toEqual([]);
    expect(unreadable(z.discriminatedUnion("kind", [z.object({ kind: z.literal("x"), n: z.number() })]), union)).not.toEqual([]);
  });

  test("an input is sendable when its fields are the action's, and the action's required ones are sent", () => {
    const real = z.object({ run: z.string(), limit: z.number().optional() });
    expect(unsendable(z.object({ run: z.string() }), real)).toEqual([]);
    expect(unsendable(z.object({ run: z.string(), more: z.string() }), real)).toEqual(["$.more: the action takes no such field"]);
    expect(unsendable(z.object({}), real)).toEqual(["$.run: the action needs it and the module never sends it"]);
  });
});

describe("a field of a union", () => {
  const addresses = z.discriminatedUnion("kind", [z.object({ kind: z.literal("owner") }), z.object({ kind: z.literal("session"), id: z.string() })]);

  test("an optional field some variant lacks is read as absent there", () => {
    expect(unreadable(z.object({ kind: z.string(), id: z.string().optional() }), addresses)).toEqual([]);
  });

  test("a field no variant has is not read", () => {
    expect(unreadable(z.object({ kind: z.string(), harness: z.string().optional() }), addresses)).toEqual(["$.harness: no variant of the writer has such a field"]);
  });

  test("a field a variant may leave out, that the reader needs, is not read", () => {
    expect(unreadable(z.object({ id: z.string() }), addresses)).not.toEqual([]);
  });
});
