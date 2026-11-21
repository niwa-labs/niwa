// What the package composes: the plugins a composition file exports, the port of `niwa web`, the
// kinds that read skills, and the names the package re-exports.

import { expect, test } from "bun:test";

import { plugin } from "@niwa-labs/plugin";

import * as niwa from "../src/index.ts";
import { pluginsOf } from "../src/serve.ts";
import { portOf } from "../src/web.ts";

test("a composition exports plugins as a default, as named exports or as arrays, in the order of the exports", () => {
  const one = plugin("one", () => {});
  const two = plugin("two", () => {});
  const three = plugin("three", () => {});
  expect(pluginsOf({ default: [one, two], three, unrelated: 1, nothing: null }).map((found) => String(found.name))).toEqual(["one", "two", "three"]);
  expect(pluginsOf({ answer: 42 })).toEqual([]);
});

test("niwa web takes no port, --port N or --port=N, and refuses anything else", () => {
  expect(portOf([])).toBe(0);
  expect(portOf(["--port", "8080"])).toBe(8080);
  expect(portOf(["--port=0"])).toBe(0);
  expect(portOf(["--port", "70000"])).toBeUndefined();
  expect(portOf(["--port", "1.5"])).toBeUndefined();
  expect(portOf(["--port"])).toBeUndefined();
  expect(portOf(["8080"])).toBe(8080);
  expect(portOf(["--port", "1", "2"])).toBeUndefined();
});

test("the kinds that read skills are the six harness kinds that have a place for them", () => {
  expect(niwa.KINDS_WITH_SKILLS.map((skills) => skills.kind)).toEqual(["claude-code", "codex", "mcode", "ncode", "pi", "zcode"]);
});

test("the package re-exports the foundation, the plugins and the kinds", () => {
  for (const name of ["createNiwa", "connect", "plugin", "action", "sessions", "workflow", "requests", "claudeCode", "codex", "pi", "serveComposition", "NIWA_CLI"]) {
    expect(name in niwa).toBe(true);
  }
});
