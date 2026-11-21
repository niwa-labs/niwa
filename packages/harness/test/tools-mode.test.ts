// The tool mode of a session: its schema, the refusal of a mode an installation cannot hold, and
// the rows of the control conformance suite that check a kind refuses what it declares it cannot.

import { expect, test } from "bun:test";

import {
  ADMITTED,
  NO_INSERT,
  NO_READING,
  ToolsModeSchema,
  UNSUPPORTED,
  Unsupported,
  VERIFIED,
  controlConformance,
  harnessId,
  harnessKind,
  machineId,
  requireTools,
  sidesOf,
} from "@niwa-labs/harness";
import type { Harness, KindCapabilities, SessionControl, SessionId, StartOptions } from "@niwa-labs/harness";

const HARNESS = harnessId("probe-1");

test("a tool mode is all, niwa-only or an allow-list of names, and nothing else", () => {
  expect(ToolsModeSchema.parse("all")).toBe("all");
  expect(ToolsModeSchema.parse("niwa-only")).toBe("niwa-only");
  expect(ToolsModeSchema.parse({ allow: ["Read"] })).toEqual({ allow: ["Read"] });
  expect(ToolsModeSchema.safeParse("none").success).toBe(false);
  expect(ToolsModeSchema.safeParse({ allow: [""] }).success).toBe(false);
  expect(ToolsModeSchema.safeParse({ allow: [], deny: ["Bash"] }).success).toBe(false);
});

test("a mode the control side does not hold is refused as Unsupported; all never is", () => {
  expect(() => requireTools(HARNESS, undefined, "all")).not.toThrow();
  expect(() => requireTools(HARNESS, undefined, undefined)).not.toThrow();
  expect(() => requireTools(HARNESS, undefined, "niwa-only")).toThrow(Unsupported);
  expect(() => requireTools(HARNESS, { niwaOnly: false, allow: true }, "niwa-only")).toThrow(/tools niwa-only/);
  expect(() => requireTools(HARNESS, { niwaOnly: false, allow: true }, { allow: ["Read"] })).not.toThrow();
  expect(() => requireTools(HARNESS, { niwaOnly: true, allow: false }, { allow: ["Read"] })).toThrow(/tools allow \[Read\]/);
});

const DECLARED: KindCapabilities = {
  reading: NO_READING,
  control: {
    start: VERIFIED,
    resume: UNSUPPORTED,
    send: UNSUPPORTED,
    interrupt: UNSUPPORTED,
    ask: UNSUPPORTED,
    structuredOutput: UNSUPPORTED,
    launch: { model: UNSUPPORTED, effort: [], modes: [] },
    tools: { niwaOnly: UNSUPPORTED, allow: ADMITTED },
  },
  insert: NO_INSERT,
};

const instance: Harness = { id: HARNESS, kind: harnessKind("probe"), machine: machineId("m"), home: "/tmp/probe", sides: sidesOf(DECLARED) };

/** A side that starts every session it is asked for, and counts the prompts it sent. */
function probe(refuses: boolean): { control: SessionControl; sent: () => number } {
  let sent = 0;
  const session: SessionId = { harness: HARNESS, native: "probe-session" as never };
  const control: SessionControl = {
    async start(options: StartOptions) {
      if (refuses && options.tools === "niwa-only") throw new Unsupported(HARNESS, "control", "start", "tools niwa-only");
      sent += 1;
      return { session, first: { status: "started", turn: 1 } };
    },
    async resume() {},
    async send() {
      return { status: "started" };
    },
    async interrupt() {},
    async ask<T>() {
      return { session, value: "ok" as T, at: 0 as never };
    },
    async *life() {},
    async state() {
      return "idle";
    },
  };
  return { control, sent: () => sent };
}

const rowsOf = async (control: SessionControl, sent: () => number) =>
  (await controlConformance("probe", { instance, control, declared: DECLARED, dispatched: async () => sent() })()).results.filter(
    (result) => result.name.startsWith("tools:"),
  );

test("the control suite fails a side that starts a session with a tool mode its kind declares it cannot hold", async () => {
  const { control, sent } = probe(false);
  const rows = await rowsOf(control, sent);
  expect(rows.map((row) => [row.name, row.passed])).toEqual([
    ["tools: tools niwa-only is refused by the side when the kind cannot hold it", false],
    ["tools: a refused tools niwa-only sends nothing to the harness", false],
  ]);
});

test("the control suite passes a side that refuses the mode by name and sends nothing", async () => {
  const { control, sent } = probe(true);
  const rows = await rowsOf(control, sent);
  expect(rows.map((row) => [row.name, row.passed])).toEqual([
    ["tools: tools niwa-only is refused by the side when the kind cannot hold it", true],
    ["tools: a refused tools niwa-only sends nothing to the harness", true],
  ]);
});
