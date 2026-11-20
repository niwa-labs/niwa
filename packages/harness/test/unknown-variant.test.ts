// The signs of a message a protocol snapshot does not know: the typed unknown, and an activity so
// that the message is still a sign of life.

import { expect, test } from "bun:test";

import { LifeEventSchema, ProtocolNameSchema, VariantNameSchema, rawJson, unknownVariantSigns } from "@niwa-labs/harness";

const PROTOCOL = ProtocolNameSchema.parse("test proto");
const VARIANT = VariantNameSchema.parse("novel/thing");

test("an unknown message is the typed unknown and an activity, both valid signs of life", () => {
  const signs = unknownVariantSigns(5, PROTOCOL, VARIANT, { method: "novel/thing", n: 1 });
  expect(signs).toEqual([
    { kind: "unknown-variant", at: 5, protocol: PROTOCOL, variant: VARIANT, raw: { method: "novel/thing", n: 1 } },
    { kind: "activity", at: 5, detail: "novel/thing" },
  ]);
  for (const sign of signs) expect(LifeEventSchema.safeParse(sign).success).toBe(true);
  expect(unknownVariantSigns(5, PROTOCOL, VARIANT, {}, "said it")[1]).toEqual({ kind: "activity", at: 5, detail: "said it" });
});

test("a message put together from parts keeps what JSON keeps: a missing params is no reason to lose the message", () => {
  expect(rawJson({ method: "x", params: undefined })).toEqual({ method: "x" });
  expect(rawJson({ a: [1, undefined] })).toEqual({ a: [1, null] });
  expect(rawJson(undefined)).toBeNull();
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  expect(rawJson(cycle)).toBeNull();
});
