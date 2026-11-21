// The pi reading side passes the conformance suite on its own fixtures.

import { expect, test } from "bun:test";

import { harnessKind, machineId, readingConformance } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";

import { FIXTURE_HARNESS, writePiFixtures } from "../src/fixtures.ts";
import { piReading } from "../src/reading.ts";

test("H1 H3 H8 H10 pi passes the reading conformance suite", async () => {
  const report = await readingConformance(
    "pi",
    (home) => {
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: harnessKind("pi"),
        machine: machineId("machine-1"),
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      return { instance, reading: piReading({ harness: FIXTURE_HARNESS, sessionsRoot: home }) };
    },
    writePiFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(40);
});
