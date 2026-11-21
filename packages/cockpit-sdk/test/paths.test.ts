import { describe, expect, test } from "bun:test";

import { matchPath, pathFor, pathProblem, pathShape } from "../src/index.ts";

describe("paths", () => {
  test("valid and invalid patterns", () => {
    expect(pathProblem("/")).toBeUndefined();
    expect(pathProblem("/runs/$runId")).toBeUndefined();
    expect(pathProblem("runs")).toContain("start");
    expect(pathProblem("/runs/")).toContain("end");
    expect(pathProblem("/runs/$id/$id")).toContain("repeats");
    expect(pathProblem("/a b")).toContain("invalid segment");
  });

  test("patterns that match the same paths share a shape", () => {
    expect(pathShape("/runs/$runId")).toBe(pathShape("/runs/$id"));
    expect(pathShape("/runs/new")).not.toBe(pathShape("/runs/$id"));
    expect(pathShape("/Rin")).toBe(pathShape("/rin"));
  });

  test("an address from a pattern, its parameters escaped, with a query", () => {
    expect(pathFor("/runs/$runId", { runId: "run-1f3a9c" })).toBe("/runs/run-1f3a9c");
    expect(pathFor("/prs/$ref", { ref: "owner/repo#12" }, { tab: "diff", none: undefined })).toBe(
      "/prs/owner%2Frepo%2312?tab=diff",
    );
    expect(() => pathFor("/runs/$runId", { runId: "" })).toThrow("runId");
  });

  test("matching an address back to its parameters", () => {
    expect(matchPath("/runs/$runId", "/runs/run-1?tab=plan")).toEqual({ runId: "run-1" });
    expect(matchPath("/prs/$ref", "/prs/owner%2Frepo%2312")).toEqual({ ref: "owner/repo#12" });
    expect(matchPath("/runs/$runId", "/runs")).toBeUndefined();
    expect(matchPath("/runs/$runId", "/tasks/x")).toBeUndefined();
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/runs/$runId", "/runs/%E0%A4%A")).toBeUndefined();
  });
});
