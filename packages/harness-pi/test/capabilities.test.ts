// What the pi kind declares of its insert side matches what a live pi has shown.

import { expect, test } from "bun:test";

import { PI_CAPABILITIES } from "../src/index.ts";

test("the end of a session is declared verified: a live pi's installed insert reports it to the host", () => {
  expect(PI_CAPABILITIES.insert?.end).toEqual({ supported: true, status: "verified" });
});

test("a compaction is only admitted: reporting one needs a model run that no live check makes", () => {
  expect(PI_CAPABILITIES.insert?.compaction).toEqual({ supported: true, status: "admitted" });
});
