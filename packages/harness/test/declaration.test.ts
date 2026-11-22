import { expect, test } from "bun:test";

import {
  ADMITTED,
  CapabilityExceeded,
  HarnessInstanceRegistry,
  HarnessKindRegistry,
  NO_CONTROL,
  NO_READING,
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
import type { Harness, HarnessSide, KindCapabilities, SessionControl, SessionReading, SideCapabilities } from "@niwa-labs/harness";

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

/** A profile that names nothing: these kinds are never started in a box. */
const NO_PROFILE = { status: "admitted", of: () => ({}) } as const;

// The sides are never called here: only their presence matters.
const reading = {} as SessionReading;
const control = {} as SessionControl;

/** A kind with code for the reading and the control side, bound to whatever installation asks. */
function probe(capabilities: KindCapabilities = DECLARED, sides: readonly HarnessSide[] = ["reading", "control"]) {
  return defineHarnessKind({
    name: "probe",
    capabilities,
    implements: sides,
    home: () => "/tmp/probe",
    profile: NO_PROFILE,
    bind: () => ({ ...(sides.includes("reading") ? { reading } : {}), ...(sides.includes("control") ? { control } : {}) }),
  });
}

const kind = () => probe();

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
  expect(() => probe({ ...DECLARED, reading: reading2 } as unknown as KindCapabilities)).toThrow();
  // A supported ability has a status; a bare `true` is not a decision.
  expect(() => probe({ ...DECLARED, reading: { ...DECLARED.reading, watch: { supported: true } } } as unknown as KindCapabilities)).toThrow();
});

test("a kind cannot support abilities of a side it has no code for", () => {
  expect(() => probe(DECLARED, ["reading"])).toThrow(/control/);
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

test("the control conformance suite does not put a question to a side that answers through submit-answer", async () => {
  const asked: string[] = [];
  const answering = {
    start: async () => ({ session: { harness: harnessId("probe-1"), native: "s1" } }),
    ask: async () => {
      asked.push("ask");
      throw new Error("this side has no ask of its own");
    },
    life: async function* () {},
    state: async () => "idle",
  } as unknown as SessionControl;
  const claims = sidesOf(DECLARED);
  // `ask` is declared, `structuredOutput` is not: the question goes to the session as a request.
  expect(claims.control).toMatchObject({ ask: true, structuredOutput: false });
  const report = await controlConformance("probe", { instance: instance(claims), control: answering, declared: DECLARED })();
  expect(asked).toEqual([]);
  expect(report.results.filter((result) => result.name.startsWith("ask"))).toEqual([]);
});

test("a tool mode or a launch choice alone is a control side the kind must have code for", () => {
  const onlyNested = { ...DECLARED, reading: NO_READING, control: { ...NO_CONTROL, tools: { niwaOnly: ADMITTED, allow: UNSUPPORTED } } };
  expect(sidesOf(onlyNested).control).toBeDefined();
  expect(() => probe(onlyNested, [])).toThrow(/control/);
  const onlyModel = { ...DECLARED, reading: NO_READING, control: { ...NO_CONTROL, launch: { model: VERIFIED, effort: [], modes: [] } } };
  expect(() => probe(onlyModel, [])).toThrow(/control/);
  const onlyModes = { ...DECLARED, reading: NO_READING, control: { ...NO_CONTROL, launch: { model: UNSUPPORTED, effort: ["low"], modes: ["auto" as const] } } };
  expect(() => probe(onlyModes, [])).toThrow(/control/);
  // With the code for the side, the same declaration registers.
  expect(() => probe(onlyNested, ["control"])).not.toThrow();
});

test("the registry of instances checks an installation against its registered kind", () => {
  const kinds = new HarnessKindRegistry();
  kinds.register(kind());
  const registry = new HarnessInstanceRegistry(kinds);
  const base = sidesOf(DECLARED);
  expect(() => registry.register(instance({ ...base, control: { ...base.control!, interrupt: true } }))).toThrow(CapabilityExceeded);
  expect(registry.ids()).toEqual([]);
  expect(() => registry.register({ ...instance(base), kind: harnessKind("other") })).toThrow(/not registered/);
  registry.register(instance(base));
  expect(registry.ids()).toEqual(["probe-1"]);
  // Without the kinds, the registry only keeps ids unique.
  expect(() => new HarnessInstanceRegistry().register(instance({ ...base, control: { ...base.control!, interrupt: true } }))).not.toThrow();
});

test("a kind binds each installation to its own id, home and model, with the sides the kind gives by default", () => {
  const seen: Array<{ id: string; home: string }> = [];
  const kind = defineHarnessKind({
    name: "probe",
    capabilities: DECLARED,
    implements: ["reading", "control"],
    home: () => "/tmp/probe-default",
    profile: NO_PROFILE,
    bind: ({ id, home }) => {
      seen.push({ id, home });
      return { reading, control };
    },
  });
  const one = kind.bind({ id: "probe-a", model: "small" });
  const two = kind.bind({ id: "probe-b", home: "/tmp/probe-b", machine: "m2" });
  expect(seen).toEqual([
    { id: "probe-a", home: "/tmp/probe-default" },
    { id: "probe-b", home: "/tmp/probe-b" },
  ]);
  expect(one.instance).toEqual({ id: harnessId("probe-a"), kind: harnessKind("probe"), machine: machineId("local"), home: "/tmp/probe-default", model: "small", sides: sidesOf(DECLARED) });
  expect(two.instance).toMatchObject({ id: "probe-b", machine: "m2", home: "/tmp/probe-b" });
  expect(two.instance.model).toBeUndefined();
  expect(one.reading).toBe(reading);
  expect(one.control).toBe(control);
});

test("an installation cannot claim what its kind cannot serve: wider sides, a model on a kind that takes none, a side without code", () => {
  const base = sidesOf(DECLARED);
  expect(() => kind().bind({ id: "probe-1", sides: { ...base, control: { ...base.control!, interrupt: true } } })).toThrow(CapabilityExceeded);
  // What a machine shows may narrow the sides.
  expect(kind().bind({ id: "probe-1", sides: { reading: base.reading! } }).instance.sides).toEqual({ reading: base.reading });
  const noModel = probe({ ...DECLARED, control: { ...DECLARED.control, launch: { ...DECLARED.control.launch, model: UNSUPPORTED } } });
  expect(() => noModel.bind({ id: "probe-1", model: "big" })).toThrow(/control\.launch\.model/);
  const forgetful = defineHarnessKind({ name: "probe", capabilities: DECLARED, implements: ["reading", "control"], home: () => "/tmp/probe", profile: NO_PROFILE, bind: () => ({ reading }) });
  expect(() => forgetful.bind({ id: "probe-1" })).toThrow(/without its control side/);
  // Default sides beyond the declaration are a kind that does not register.
  expect(() =>
    defineHarnessKind({ name: "probe", capabilities: DECLARED, implements: ["reading", "control"], sides: { ...base, control: { ...base.control!, interrupt: true } }, home: () => "/tmp/probe", profile: NO_PROFILE, bind: () => ({ reading, control }) }),
  ).toThrow(/control\.interrupt/);
});

test("the registry of instances keeps each installation with its own sides", () => {
  const registry = new HarnessInstanceRegistry();
  const otherControl = {} as SessionControl;
  const twin = defineHarnessKind({
    name: "probe",
    capabilities: DECLARED,
    implements: ["reading", "control"],
    home: () => "/tmp/probe",
    profile: NO_PROFILE,
    bind: ({ id }) => ({ reading, control: id === "probe-b" ? otherControl : control }),
  });
  registry.register(twin.bind({ id: "probe-a" }));
  registry.register(twin.bind({ id: "probe-b" }));
  expect(registry.ofKind("probe").map((one) => String(one.id))).toEqual(["probe-a", "probe-b"]);
  expect(registry.bindingOf("probe-a").control).toBe(control);
  expect(registry.bindingOf("probe-b").control).toBe(otherControl);
  expect(registry.bindings().map((one) => String(one.instance.id))).toEqual(["probe-a", "probe-b"]);
});

test("a kind that says nothing of what its sessions need inside a box does not register", () => {
  const spec = { name: "probe", capabilities: DECLARED, implements: ["reading", "control"] as const, home: () => "/tmp/probe", bind: () => ({ reading, control }) };
  // A kind written without the type's help: the profile is not there, or not whole.
  expect(() => defineHarnessKind(spec as unknown as Parameters<typeof defineHarnessKind>[0])).toThrow(/declares no profile/);
  expect(() => defineHarnessKind({ ...spec, profile: { status: "maybe", of: () => ({}) } } as unknown as Parameters<typeof defineHarnessKind>[0])).toThrow(/declares no profile/);
  const { profile: _profile, ...bare } = probe();
  expect(() => new HarnessKindRegistry().register(bare as unknown as ReturnType<typeof probe>)).toThrow(/declares no profile/);
});

test("an installation's profile is its kind's, from its own options, with the hosts the owner gave it", () => {
  const kind = defineHarnessKind({
    name: "probe",
    capabilities: DECLARED,
    implements: ["reading", "control"],
    home: () => "/tmp/probe-default",
    profile: { status: "verified", of: ({ id, home }) => ({ write: [home], read: [`/opt/${id}`], net: ["api.example.com"] }) },
    bind: () => ({ reading, control }),
  });
  expect(kind.profile.status).toBe("verified");
  expect(kind.bind({ id: "probe-a" }).profile).toEqual({ write: ["/tmp/probe-default"], read: ["/opt/probe-a"], net: ["api.example.com"] });
  expect(kind.bind({ id: "probe-b", home: "/tmp/b", net: ["127.0.0.1:10081"] }).profile).toEqual({
    write: ["/tmp/b"],
    read: ["/opt/probe-b"],
    net: ["api.example.com", "127.0.0.1:10081"],
  });
});

test("a host can replace or clear either network field without changing a kind's directories", () => {
  const listen = { host: "127.0.0.1", port: 0 } as const;
  const inherited = { read: ["/opt/tool"], write: ["/tmp/state"], net: ["api.example.com"], listen };
  const kind = defineHarnessKind({
    name: "probe-profile",
    capabilities: DECLARED,
    implements: ["reading", "control"],
    home: () => "/tmp/state",
    profile: { status: "admitted", of: () => () => inherited },
    bind: () => ({ reading, control }),
  });
  const paths = (options: Parameters<typeof kind.bind>[0]) => {
    const profile = kind.bind(options).profile;
    if (typeof profile !== "function") throw new Error("the profile must be a function");
    return profile({ home: "/tmp", env: {}, bin: () => [] });
  };
  expect(paths({ id: "defaults" })).toEqual(inherited);
  expect(paths({ id: "custom", boxProfile: { net: ["proxy.example.com"] } })).toEqual({ ...inherited, net: ["proxy.example.com"] });
  expect(paths({ id: "prevent", net: ["legacy.example.com"], boxProfile: { net: [] } })).toEqual({ ...inherited, net: [] });
  expect(paths({ id: "port", boxProfile: { listen: { host: "::1", port: 3000 } } })).toEqual({
    ...inherited,
    listen: { host: "::1", port: 3000 },
  });
  expect(paths({ id: "clear-listener", boxProfile: { listen: null } })).toEqual({
    read: inherited.read, write: inherited.write, net: inherited.net,
  });
  expect(paths({ id: "pattern", boxProfile: { net: ["*.example.com"] } })).toEqual({ ...inherited, net: ["*.example.com"] });
  for (const host of ["*", "*.", "*.sub.*.example.com", "https://proxy.example.com/v1", "proxy.example.com:443"]) {
    expect(() => paths({ id: "invalid-host", boxProfile: { net: [host] } })).toThrow(/use a hostname, IP address, or subdomain pattern/);
  }
});
