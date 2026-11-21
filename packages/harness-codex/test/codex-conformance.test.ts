// The Codex reading side passes the conformance suite on its own fixtures.

import { expect, test } from "bun:test";

import { readingConformance } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";

import { FIXTURE_HARNESS, writeCodexFixtures } from "../src/fixtures.ts";
import { CodexReading } from "../src/reading.ts";

test("H1 H3 H8 H10 codex passes the reading conformance suite", async () => {
  const report = await readingConformance(
    "codex",
    (home) => {
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: "codex" as never,
        machine: "machine-1" as never,
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      return { instance, reading: new CodexReading({ harness: FIXTURE_HARNESS, home }) };
    },
    writeCodexFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(40);
});
