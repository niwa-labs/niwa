/**
 * The mode a session starts in when neither the call nor the instance names one.
 *
 * The default comes from what the kind declares: a kind is never given a mode it cannot apply.
 */

import { expect, test } from "bun:test";

import { DEFAULT_SESSION_MODE, modeOf, requireLaunch } from "../src/index.ts";
import type { LaunchCapabilities } from "../src/index.ts";
import { harnessId } from "../src/index.ts";

const ALL: LaunchCapabilities = { model: false, effort: [], modes: ["ask", "auto", "full"] };
const FULL_ONLY: LaunchCapabilities = { model: false, effort: [], modes: ["full"] };
const ASK_FULL: LaunchCapabilities = { model: false, effort: [], modes: ["ask", "full"] };
const NONE: LaunchCapabilities = { model: false, effort: [], modes: [] };

test("a kind that has the default mode starts in it", () => {
  expect(modeOf(undefined, undefined, ALL)).toBe(DEFAULT_SESSION_MODE);
});

test("a kind with one mode starts in that mode when none is chosen", () => {
  const mode = modeOf(undefined, undefined, FULL_ONLY);
  expect(mode).toBe("full");
  expect(() => requireLaunch(harnessId("one-mode"), FULL_ONLY, { mode })).not.toThrow();
});

test("a kind without the default mode starts in the first mode it declares", () => {
  expect(modeOf(undefined, undefined, ASK_FULL)).toBe("ask");
});

test("the call's mode, else the instance's, wins over the kind's default", () => {
  expect(modeOf("ask", "full", ALL)).toBe("ask");
  expect(modeOf(undefined, "ask", FULL_ONLY)).toBe("ask");
});

test("a kind that declares no modes falls back to the default mode", () => {
  expect(modeOf(undefined, undefined, NONE)).toBe(DEFAULT_SESSION_MODE);
});
