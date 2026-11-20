// The package has two entries. This reads the source text: what each entry loads at run time, that
// only the journal runtime pulls `bun:sqlite`, and that nothing leaves the package.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { expect, test } from "bun:test";

const PACKAGE = join(import.meta.dir, "..");
const SRC = join(PACKAGE, "src");

/** The contracts root and the `./journal` entry, as the package exports them. */
const ROOT_ENTRY = join(SRC, "index.ts");
const JOURNAL_ENTRY = join(SRC, "journal.ts");
const JOURNAL_DIR = join(SRC, "journal");

const STATEMENT = /^(import|export)(\s+type)?\b[^;]*?\bfrom\s*"([^"]+)"|^import\s*"([^"]+)"/gm;

interface Edge {
  readonly spec: string;
  readonly typeOnly: boolean;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

function edgesOf(file: string): Edge[] {
  const edges: Edge[] = [];
  for (const match of readFileSync(file, "utf8").matchAll(STATEMENT)) {
    const spec = match[3] ?? match[4];
    if (spec !== undefined) edges.push({ spec, typeOnly: match[2] !== undefined });
  }
  return edges;
}

/** Every module a module loads at run time, itself included, and the bare packages it reaches. */
function closureOf(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const edge of edgesOf(file)) {
      if (edge.typeOnly) continue;
      if (edge.spec.startsWith(".")) todo.push(normalize(join(dirname(file), edge.spec)));
      else packages.add(edge.spec);
    }
  }
  return { files, packages };
}

function isJournalFile(file: string): boolean {
  return file === JOURNAL_ENTRY || file.startsWith(JOURNAL_DIR + "/");
}

test("the exports map names the contracts root and the journal entry", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { exports: Record<string, string> };
  expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./journal": "./src/journal.ts" });
});

test("the contracts do not import the journal runtime, which reaches the contracts directly", () => {
  const violations: string[] = [];
  for (const file of filesUnder(SRC)) {
    if (isJournalFile(file)) continue;
    for (const edge of edgesOf(file)) {
      if (!edge.spec.startsWith(".")) continue;
      const target = normalize(join(dirname(file), edge.spec));
      if (isJournalFile(target)) violations.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
  }
  expect(violations).toEqual([]);
});

test("the contracts root does not load bun:sqlite", () => {
  const { files, packages } = closureOf(ROOT_ENTRY);
  expect(packages.has("bun:sqlite")).toBe(false);
  expect([...files].filter(isJournalFile)).toEqual([]);
});

test("the journal entry is the one that loads bun:sqlite", () => {
  const { files, packages } = closureOf(JOURNAL_ENTRY);
  expect(packages.has("bun:sqlite")).toBe(true);
  const holders = [...files].filter((file) => edgesOf(file).some((edge) => edge.spec === "bun:sqlite"));
  expect(holders.map((file) => relative(SRC, file))).toEqual(["journal/journal.ts"]);
});

test("nothing leaves the package: no file outside src and no other niwa package", () => {
  const violations: string[] = [];
  for (const file of filesUnder(SRC)) {
    for (const edge of edgesOf(file)) {
      if (edge.spec.startsWith(".")) {
        const target = normalize(join(dirname(file), edge.spec));
        if (!target.startsWith(SRC + "/")) violations.push(`${relative(SRC, file)} -> ${edge.spec}`);
      } else if (edge.spec === "niwa" || edge.spec.startsWith("niwa/") || edge.spec.startsWith("@niwa-labs/")) {
        violations.push(`${relative(SRC, file)} -> ${edge.spec}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
