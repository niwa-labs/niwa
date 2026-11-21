/**
 * The kinds the umbrella exports.
 *
 * Every kind is exported the same way: its factory, and the sides it has by default. A kind that
 * is missing one of them cannot be wired the way the others are.
 */

import { expect, test } from "bun:test";

import * as kinds from "../src/kinds.ts";

/** Each kind, with the names it is exported under. */
const KINDS = {
  "claude-code": { factories: ["claudeCode", "claudeCodeKind"], sides: "claudeCodeSides" },
  "claude-sdk": { factories: ["claudeSdkKind"], sides: "claudeSdkSides" },
  codex: { factories: ["codex", "codexKind"], sides: "codexSides" },
  mcode: { factories: ["mcode", "mcodeKind"], sides: "mcodeSides" },
  ncode: { factories: ["ncode", "ncodeKind"], sides: "ncodeSides" },
  pi: { factories: ["pi"], sides: "piSides" },
  zcode: { factories: ["zcode", "zcodeKind"], sides: "zcodeSides" },
} as const;

const exported: Record<string, unknown> = { ...kinds };

for (const [kind, names] of Object.entries(KINDS)) {
  test(`the umbrella exports the factory and the sides of ${kind}`, () => {
    for (const factory of names.factories) expect(typeof exported[factory]).toBe("function");
    const sides = exported[names.sides];
    expect(sides).toBeDefined();
    expect(sides).toHaveProperty("control");
  });
}

test("every sides export of the umbrella belongs to a listed kind", () => {
  const listed = Object.values(KINDS).map((names) => names.sides).sort();
  const found = Object.keys(exported).filter((name) => name.endsWith("Sides")).sort();
  expect(found).toEqual(listed);
});
