// The script package takes nothing from niwa: its types import nothing, and its header reader only zod and typescript.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";

const SRC = join(import.meta.dir, "../src");

const STATEMENT = /^(?:import|export)(?:\s+type)?\b[^;]*?\bfrom\s*"([^"]+)"/gm;

/** Every module specifier a file names in an import or re-export statement. */
function specifiersOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(STATEMENT)].map((match) => match[1] as string);
}

test("the script API file imports nothing", () => {
  expect(specifiersOf(join(SRC, "script-api.ts"))).toEqual([]);
});

test("the files of the package name only zod, typescript and each other", () => {
  for (const name of readdirSync(SRC).filter((entry) => entry.endsWith(".ts"))) {
    const file = join(SRC, name);
    for (const specifier of specifiersOf(file)) {
      const ok = specifier === "zod" || specifier === "typescript" || /^\.\/[a-z-]+\.ts$/.test(specifier);
      expect({ file: relative(SRC, file), specifier, ok }).toEqual({ file: relative(SRC, file), specifier, ok: true });
    }
  }
});
