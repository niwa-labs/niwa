// The runs of the home page, in blocks by the directory they were started for.

import { expect, test } from "bun:test";

import type { RunEntry } from "../src/cockpit/actions.ts";
import { directoryName, groupByDirectory } from "../src/cockpit/groups.ts";

function entry(run: string, requestedAt: string, directory?: string): RunEntry {
  return { run, name: run, state: "finished", requestedAt, about: "", requests: 0, ...(directory === undefined ? {} : { directory }) };
}

test("a directory is named by its last part", () => {
  expect(directoryName("/work/niwa")).toBe("niwa");
  expect(directoryName("/work/niwa/")).toBe("niwa");
  expect(directoryName("C:\\work\\niwa")).toBe("niwa");
  expect(directoryName("/")).toBe("/");
});

test("runs of one directory are one block, the latest run first", () => {
  const groups = groupByDirectory([entry("a", "2026-01-01T00:00:00Z", "/work/x"), entry("b", "2026-01-03T00:00:00Z", "/work/x"), entry("c", "2026-01-02T00:00:00Z", "/work/x")]);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ directory: "/work/x", name: "x" });
  expect(groups[0]?.runs.map((run) => run.run)).toEqual(["b", "c", "a"]);
});

test("blocks go by their latest run, and the runs with no directory come last", () => {
  const groups = groupByDirectory([
    entry("old", "2026-01-01T00:00:00Z", "/work/old"),
    entry("loose", "2026-01-09T00:00:00Z"),
    entry("new", "2026-01-05T00:00:00Z", "/work/new"),
  ]);
  expect(groups.map((group) => group.directory)).toEqual(["/work/new", "/work/old", undefined]);
  expect(groups.at(-1)?.name).toBe("No directory");
});

test("a trailing separator does not make a second block, and an empty directory is none", () => {
  const groups = groupByDirectory([entry("a", "2026-01-01T00:00:00Z", "/work/x"), entry("b", "2026-01-02T00:00:00Z", "/work/x/"), entry("c", "2026-01-03T00:00:00Z", "")]);
  expect(groups.map((group) => [group.directory, group.runs.length])).toEqual([
    ["/work/x", 2],
    [undefined, 1],
  ]);
});
