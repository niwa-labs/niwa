// The OpenCode reading side passes the conformance suite on its own fixtures: the data files the
// fake server serves, one fake of its own per scenario, and none left running after the suite.

import { expect, test } from "bun:test";

import { harnessKind, machineId, readingConformance } from "@niwa-labs/harness";
import type { ConformanceSides, FixtureWriter, Harness } from "@niwa-labs/harness";

import { FIXTURE_HARNESS, writeOpencodeFixtures } from "./fixtures/opencode-fixtures.ts";
import { startFakeServer } from "./fixtures/serve.ts";
import type { FakeServer } from "./fixtures/serve.ts";
import { OpenCodeReading } from "../src/reading.ts";

/** The fakes the scenarios started, by the directory each serves. */
const servers = new Map<string, FakeServer>();

/** Writes the scenario's data, and a server of its own that serves it: the side opens on the same directory. */
const writer: FixtureWriter = async (dir, scenario) => {
  const written = await writeOpencodeFixtures(dir, scenario);
  servers.set(dir, await startFakeServer({ cwd: dir, dataDir: dir }));
  return written;
};

function open(dir: string): ConformanceSides {
  const server = servers.get(dir);
  if (server === undefined) throw new Error(`no fake server was started for ${dir}`);
  const instance: Harness = {
    id: FIXTURE_HARNESS,
    kind: harnessKind("opencode"),
    machine: machineId("machine-1"),
    home: dir,
    sides: { reading: { list: true, read: true, watch: false } },
  };
  return {
    instance,
    reading: new OpenCodeReading({ harness: FIXTURE_HARNESS, server: { url: server.url, password: server.password } }),
  };
}

test("opencode passes the reading conformance suite", async () => {
  try {
    const report = await readingConformance("opencode", open, writer)();
    expect(report.results.filter((result) => !result.passed).map((result) => `${result.name}: ${result.detail ?? ""}`)).toEqual([]);
    expect(report.results.length).toBeGreaterThan(40);
  } finally {
    for (const server of servers.values()) await server.stop();
    servers.clear();
  }
});
