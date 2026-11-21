// The ZCode reading side passes the conformance suite on its own fixtures.

import { expect, test } from "bun:test";

import { harnessKind, machineId, readingConformance } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";

import { FIXTURE_HARNESS, writeZcodeFixtures } from "../src/fixtures.ts";
import { ZcodeReading } from "../src/reading.ts";

test("zcode passes the reading conformance suite", async () => {
  const report = await readingConformance(
    "zcode",
    (home) => {
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: harnessKind("zcode"),
        machine: machineId("machine-1"),
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      return { instance, reading: new ZcodeReading({ harness: FIXTURE_HARNESS, home }) };
    },
    writeZcodeFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(40);
});
