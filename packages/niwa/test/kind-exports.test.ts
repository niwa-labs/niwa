/**
 * The kinds the umbrella exports.
 *
 * Every kind is exported the same way: the kind, which binds an installation of it, a shorthand for
 * one installation with every default, and the sides it has by default. A kind that is missing one
 * of them cannot be wired the way the others are.
 */

import { expect, test } from "bun:test";

import * as kinds from "../src/kinds.ts";

/** Each kind, with the names it is exported under. */
const KINDS = {
  "claude-code": { kind: "claudeCodeKind", shorthand: "claudeCode", sides: "claudeCodeSides" },
  "claude-sdk": { kind: "claudeSdkKind", shorthand: "claudeSdk", sides: "claudeSdkSides" },
  codex: { kind: "codexKind", shorthand: "codex", sides: "codexSides" },
  mcode: { kind: "mcodeKind", shorthand: "mcode", sides: "mcodeSides" },
  ncode: { kind: "ncodeKind", shorthand: "ncode", sides: "ncodeSides" },
  opencode: { kind: "opencodeKind", shorthand: "opencode", sides: "opencodeSides" },
  pi: { kind: "piKind", shorthand: "pi", sides: "piSides" },
  zcode: { kind: "zcodeKind", shorthand: "zcode", sides: "zcodeSides" },
} as const;

const exported: Record<string, unknown> = { ...kinds };

for (const [kind, names] of Object.entries(KINDS)) {
  test(`the umbrella exports the kind, its shorthand and the sides of ${kind}`, () => {
    const definition = exported[names.kind] as { kind?: unknown; bind?: unknown };
    expect(String(definition.kind)).toBe(kind);
    expect(typeof definition.bind).toBe("function");
    expect(typeof exported[names.shorthand]).toBe("function");
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
