import { expect, test } from "bun:test";

import { LifeEventSchema } from "@niwa-labs/harness";

test("the end of a turn may say how it ended, in the three words the harness has for it", () => {
  for (const outcome of ["completed", "failed", "unknown"]) {
    expect(LifeEventSchema.safeParse({ kind: "turn-ended", turn: 1, outcome }).success).toBe(true);
  }
  expect(LifeEventSchema.safeParse({ kind: "turn-ended", turn: 1 }).success).toBe(true);
  expect(LifeEventSchema.safeParse({ kind: "turn-ended", turn: 1, outcome: "done" }).success).toBe(false);
});
