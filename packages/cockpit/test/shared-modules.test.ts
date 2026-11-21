// The modules the client modules of plugins share: what each entry of the app offers must be what a module imports by that name.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { entrySource, SHARED_MODULES, type SharedModule } from "../src/shared-modules.ts";

// Under node_modules, which git ignores, so the entry resolves the packages as the package itself does.
const SCRATCH = join(import.meta.dir, "..", "node_modules", ".scratch");
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Load the generated entry of a shared module as a module of the package would see it. */
async function loadEntry(shared: SharedModule): Promise<Record<string, unknown>> {
  mkdirSync(SCRATCH, { recursive: true });
  const folder = mkdtempSync(join(SCRATCH, "entry-"));
  folders.push(folder);
  const file = join(folder, "entry.ts");
  writeFileSync(file, entrySource(shared));
  return (await import(file)) as Record<string, unknown>;
}

test("a module can import zod by its default export as well as by name, from either specifier", async () => {
  for (const name of ["zod", "zod/v4"]) {
    const shared = SHARED_MODULES.find((one) => one.name === name)!;
    const entry = await loadEntry(shared);
    const z = entry.default as { object: unknown; string: unknown };
    expect(typeof z.object).toBe("function");
    expect(entry.z).toBe(z);
    expect(entry.string).toBe(z.string);
  }
});

test("the compiler runtime of React is shared by name", async () => {
  const shared = SHARED_MODULES.find((one) => one.name === "react/compiler-runtime");
  expect(shared).toBeDefined();
  const entry = await loadEntry(shared!);
  expect(typeof entry.c).toBe("function");
  expect(entry.default).toBeDefined();
});

test("a CommonJS package is offered by default and by each of its names", async () => {
  const entry = await loadEntry(SHARED_MODULES.find((one) => one.name === "react")!);
  expect(typeof entry.useState).toBe("function");
  expect(entry.default).toBeDefined();
});
