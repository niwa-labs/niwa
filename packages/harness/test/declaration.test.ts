import { expect, test } from "bun:test";

import {
  ADMITTED,
  CapabilityExceeded,
  NO_INSERT,
  UNSUPPORTED,
  VERIFIED,
  admitInstance,
  controlConformance,
  defineHarnessKind,
  harnessId,
  harnessKind,
  machineId,
  narrowSides,
  sidesOf,
} from "@niwa-labs/harness";
import type { Harness, KindCapabilities, SessionControl, SessionReading, SideCapabilities } from "@niwa-labs/harness";

const DECLARED: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: ADMITTED,
    send: VERIFIED,
    interrupt: UNSUPPORTED,
    ask: VERIFIED,
    structuredOutput: UNSUPPORTED,
    launch: { model: VERIFIED, effort: ["low", "high"], modes: ["ask", "auto"] },
    tools: { niwaOnly: ADMITTED, allow: UNSUPPORTED },
  },
  insert: NO_INSERT,
};

// The sides are never called here: only their presence matters.
const reading = {} as SessionReading;
const control = {} as SessionControl;

const kind = () => defineHarnessKind({ name: "probe", reading, control, capabilities: DECLARED });

function instance(sides: SideCapabilities): Harness {
  return { id: harnessId("probe-1"), kind: harnessKind("probe"), machine: machineId("m"), home: "/tmp/probe", sides };
}

test("the default sides of a kind are its supported abilities, and a side with none is absent", () => {
  expect(sidesOf(DECLARED)).toEqual({
    reading: { list: true, read: true, watch: false },
    control: {
      start: true,
      resume: true,
      send: true,
      interrupt: false,
      ask: true,
      structuredOutput: false,
      launch: { model: true, effort: ["low", "high"], modes: ["ask", "auto"] },
      tools: { niwaOnly: true, allow: false },
    },
  });
  expect(() => admitInstance(instance(sidesOf(DECLARED)), kind())).not.toThrow();
});

test("a declaration that leaves an ability out does not register", () => {
  const { watch: _left, ...reading2 } = DECLARED.reading;
  expect(() =>
    defineHarnessKind({ name: "probe", reading, control, capabilities: { ...DECLARED, reading: reading2 } as unknown as KindCapabilities }),
  ).toThrow();
  // A supported ability has a status; a bare `true` is not a decision.
  expect(() =>
    defineHarnessKind({
      name: "probe",
      reading,
      control,
      capabilities: { ...DECLARED, reading: { ...DECLARED.reading, watch: { supported: true } } } as unknown as KindCapabilities,
    }),
  ).toThrow();
});

test("a kind cannot support abilities of a side it has no code for", () => {
  expect(() => defineHarnessKind({ name: "probe", reading, capabilities: DECLARED })).toThrow(/control/);
});

test("an installation that claims more than its kind is refused, each excess named", () => {
  const base = sidesOf(DECLARED);
  const control0 = base.control!;
  const wider = instance({
    ...base,
    control: {
      ...control0,
      interrupt: true,
      structuredOutput: true,
      launch: { model: true, effort: ["low", "max"], modes: ["ask", "full"] },
      tools: { niwaOnly: true, allow: true },
    },
    insert: { nested: false, compaction: true, manualOpen: false, permission: false, end: false },
  });
  let refused: unknown;
  try {
    admitInstance(wider, kind());
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(CapabilityExceeded);
  expect((refused as CapabilityExceeded).excess).toEqual([
    "insert (the kind has no insert side)",
    "insert.compaction",
    "control.interrupt",
    "control.structuredOutput",
    "control.tools.allow",
    'control.launch.effort "max"',
    'control.launch.modes "full"',
  ]);
});

test("what a machine shows may narrow the declared sides, never widen them", () => {
  const implemented = { reading: true, control: true, insert: false };
  const narrower: SideCapabilities = { reading: { list: true, read: false, watch: false } };
  expect(narrowSides(harnessId("probe-1"), "probe", DECLARED, narrower, implemented)).toEqual(narrower);
  expect(() =>
    narrowSides(harnessId("probe-1"), "probe", DECLARED, { reading: { list: true, read: true, watch: true } }, implemented),
  ).toThrow(CapabilityExceeded);
});

test("the control conformance suite fails an installation that claims more than its kind declares", async () => {
  const claims = sidesOf(DECLARED);
  const wider = instance({ ...claims, control: { ...claims.control!, structuredOutput: true } });
  // A side that cannot start ends the suite early; the declaration is checked before that.
  const report = await controlConformance("probe", { instance: { ...wider, sides: { ...wider.sides, control: { ...wider.sides.control!, start: false } } }, control, declared: DECLARED })();
  expect(report.results.find((r) => r.name.startsWith("capabilities:"))).toMatchObject({ passed: false, detail: "control.structuredOutput" });
});
