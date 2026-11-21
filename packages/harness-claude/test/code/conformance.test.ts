// The Claude Code reading side passes the conformance suite on its own fixtures.

import { expect, test } from "bun:test";

import { readingConformance } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";

import {
  FIXTURE_HARNESS,
  writeClaudeCodeFixtures,
} from "../../src/code/fixtures.ts";
import { ClaudeCodeReading } from "../../src/code/reading.ts";

test("H1 H3 H8 H10 claude-code passes the reading conformance suite", async () => {
  const report = await readingConformance(
    "claude-code",
    (home) => {
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: "claude-code" as never,
        machine: "machine-1" as never,
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      return { instance, reading: new ClaudeCodeReading({ harness: FIXTURE_HARNESS, home }) };
    },
    writeClaudeCodeFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(30);
});
