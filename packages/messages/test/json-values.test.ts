// The values that are JSON by contract are JSON for the type and for the parse: a value that is not JSON is refused
// where it comes in, not carried on as `unknown`.

import { expect, test } from "bun:test";

import { JsonSchemaValue, JsonValueSchema, jsonOf } from "@niwa-labs/core";
import { ToolCallRecordSchema, ToolResultRecordSchema, manifestVersion } from "@niwa-labs/testing";
import { z } from "zod";

import { MessageBody } from "../src/index.ts";

const BASE = { locator: "loc", incomplete: false };

test("a message carries JSON data and refuses data that is not JSON", () => {
  expect(MessageBody.safeParse({ type: "update", text: "x", data: { a: [1, "b", null], c: { d: true } } }).success).toBe(true);
  expect(MessageBody.safeParse({ type: "update", text: "x", data: { when: new Date() } }).success).toBe(false);
  expect(MessageBody.safeParse({ type: "result", text: "x", data: { n: Number.NaN } }).success).toBe(false);
  expect(MessageBody.safeParse({ type: "failure", text: "x", data: { gone: undefined } }).success).toBe(false);
  expect(MessageBody.safeParse({ type: "answer", text: "x" }).success).toBe(true);
});

test("the input of a tool call and the output of its result are JSON", () => {
  const call = { kind: "tool-call", callId: "c1", name: "Read", category: "read", ...BASE };
  expect(ToolCallRecordSchema.safeParse({ ...call, input: { path: "a" } }).success).toBe(true);
  expect(ToolCallRecordSchema.safeParse({ ...call }).success).toBe(true);
  expect(ToolCallRecordSchema.safeParse({ ...call, input: () => 1 }).success).toBe(false);
  const result = { kind: "tool-result", callId: "c1", ...BASE };
  expect(ToolResultRecordSchema.safeParse({ ...result, output: ["x"] }).success).toBe(true);
  expect(ToolResultRecordSchema.safeParse({ ...result, output: { big: 10n } }).success).toBe(false);
});

test("a JSON Schema is what z.toJSONSchema makes, and a member that is not JSON is refused", () => {
  const made = z.toJSONSchema(z.object({ text: z.string() }));
  expect(JsonSchemaValue.parse(made)).toEqual(JSON.parse(JSON.stringify(made)));
  expect(JsonSchemaValue.safeParse({ type: "object", default: undefined }).success).toBe(false);
  expect(JsonSchemaValue.safeParse({ type: "object", default: new Date() }).success).toBe(false);
  expect(JsonSchemaValue.safeParse([]).success).toBe(false);
});

test("jsonOf leaves out what a journal leaves out and refuses what has no JSON form", () => {
  expect(jsonOf({ a: 1, b: undefined, c: [undefined] })).toEqual({ a: 1, c: [null] });
  expect(jsonOf(undefined)).toBeNull();
  expect(jsonOf(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  expect(() => jsonOf({ n: 1n })).toThrow();
  expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
});

test("the version of a package is a non-empty text, and any other version is none", () => {
  expect(manifestVersion({ name: "p", version: "1.2.3" })).toBe("1.2.3");
  expect(manifestVersion({ name: "p", version: 3 })).toBeUndefined();
  expect(manifestVersion({ name: "p", version: "" })).toBeUndefined();
  expect(manifestVersion({ name: "p" })).toBeUndefined();
  expect(manifestVersion(null)).toBeUndefined();
  expect(manifestVersion("1.0.0")).toBeUndefined();
});
