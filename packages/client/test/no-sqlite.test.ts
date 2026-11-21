import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SQLITE = "bun:sqlite";
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Edge {
  kind: string;
  from: string;
  specifier: string;
}

/** Every import the client entry reaches by loading, followed through workspace files. */
function reachable(entry: string): { files: Set<string>; edges: Edge[] } {
  const files = new Set<string>();
  const edges: Edge[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const { kind, path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      edges.push({ kind, from: file, specifier: path });
      if (kind !== "import-statement" || path.startsWith("node:") || path.startsWith("bun:")) continue;
      const resolved = Bun.resolveSync(path, dirname(file));
      if (!resolved.includes("/node_modules/")) queue.push(resolved);
    }
  }
  return { files, edges };
}

/** Whether a file calls `require("bun:sqlite")` or `import("bun:sqlite")` where the module loads, outside any function. */
function loadsSqliteAtModuleLevel(file: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  let found = false;
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (ts.isCallExpression(node) && !insideFunction) {
      const callee = node.expression;
      const named = ts.isIdentifier(callee) && callee.text === "require";
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if ((named || dynamic) && first !== undefined && ts.isStringLiteralLike(first) && first.text === SQLITE) found = true;
    }
    const entersFunction = ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
    ts.forEachChild(node, (child) => visit(child, insideFunction || entersFunction));
  };
  visit(source, false);
  return found;
}

describe("the client entry", () => {
  const { files, edges } = reachable(ENTRY);

  test("follows the entry into the contracts of core", () => {
    expect([...files].some((file) => file.endsWith("/core/src/index.ts"))).toBe(true);
  });

  test("never loads bun:sqlite, itself or through a package it imports", () => {
    const loading = edges.filter((edge) => edge.kind === "import-statement" && edge.specifier === SQLITE);
    expect(loading).toEqual([]);
  });

  test("never requires bun:sqlite where a module loads, in any file it reaches", () => {
    expect([...files].filter(loadsSqliteAtModuleLevel)).toEqual([]);
  });

  test("does not reach the journal entry of core", () => {
    expect([...files].filter((file) => file.endsWith("/core/src/journal.ts") || file.includes("/core/src/journal/"))).toEqual([]);
  });

  test("opens the database only inside the holder probe, when it runs", () => {
    const lazy = edges.filter((edge) => edge.specifier === SQLITE);
    expect(lazy.map((edge) => [edge.kind, edge.from.replace(/^.*\/packages\//, "")])).toEqual([["require-call", "client/src/holder.ts"]]);
  });
});
