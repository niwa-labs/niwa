// A session reference is a non-empty string that carries its own brand.

import { expect, test } from "bun:test";

import { SessionRefSchema } from "../src/index.ts";
import type { SessionRef } from "../src/index.ts";

test("a session reference is a non-empty string", () => {
  const ref: SessionRef = SessionRefSchema.parse("claude 3fa9c2");
  expect(ref).toBe("claude 3fa9c2");
  expect(SessionRefSchema.safeParse("").success).toBe(false);
  expect(SessionRefSchema.safeParse(7).success).toBe(false);
});
