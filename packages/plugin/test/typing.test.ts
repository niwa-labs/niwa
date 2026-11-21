// What the types of the package refuse: the fixture marks every line that must not compile.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(import.meta.dir, "fixtures/typing.ts");

/** The lines of the fixture the compiler refuses, as the compiler reports them. */
function refusedLines(): number[] {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.base.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram([FIXTURE], { ...parsed.options, typeRoots: [join(ROOT, "node_modules/@types")] });
  const source = program.getSourceFile(FIXTURE);
  if (source === undefined) throw new Error("the fixture is not in the program");
  const reported = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  const lines = reported.map((diagnostic) => source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1);
  return [...new Set(lines)].sort((a, b) => a - b);
}

test("a setup that may return a promise, a timer with no schedule or two, an agent on both a harness and a role or on neither, a trigger with an offer of another type, an offered trigger without its definition, and a subscriber query literal with a position of its own do not compile", () => {
  const marked = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .flatMap((line, index) => (line.endsWith("// error") ? [index + 1] : []));
  expect(marked.length).toBeGreaterThan(0);
  const refused = refusedLines();
  expect(refused).toEqual(marked);
  expect(dirname(FIXTURE)).toContain("fixtures");
}, 60_000);
