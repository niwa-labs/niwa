// The MiniMax Code reading side passes the conformance suite on its own fixtures.

import { expect, test } from "bun:test";

import { machineId, readingConformance } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";

import { FIXTURE_HARNESS, writeMcodeFixtures } from "../src/mcode/fixtures.ts";
import { McodeReading } from "../src/mcode/reading.ts";
import { ncodeKind } from "../src/ncode/index.ts";

test("H1 H3 H8 H10 mcode passes the reading conformance suite", async () => {
  const report = await readingConformance(
    "mcode",
    (home) => {
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: "mcode" as never,
        machine: "machine-1" as never,
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      return { instance, reading: new McodeReading({ harness: FIXTURE_HARNESS, home }) };
    },
    writeMcodeFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(40);
});

test("H1 H3 H8 H10 the ncode kind reads the same store: its reading side passes the same suite", async () => {
  const report = await readingConformance(
    "ncode",
    (home) => {
      const kind = ncodeKind.bind({ id: FIXTURE_HARNESS, home });
      const instance: Harness = {
        id: FIXTURE_HARNESS,
        kind: kind.instance.kind,
        machine: machineId("machine-1"),
        home,
        sides: { reading: { list: true, read: true, watch: false } },
      };
      if (kind.reading === undefined) throw new Error("the kind has no reading side");
      return { instance, reading: kind.reading };
    },
    writeMcodeFixtures,
  )();
  const failed = report.results.filter((result) => !result.passed);
  expect(failed.map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
  expect(report.results.length).toBeGreaterThan(40);
});
