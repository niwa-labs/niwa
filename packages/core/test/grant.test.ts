// Grants as pure values: a flat allow-list, the longest match wins, and a request wider than the parent is refused, not narrowed.

import { expect, test } from "bun:test";

import { grant, match, narrow, narrowed, rule, ruleText, specsOf } from "../src/index.ts";
import type { Grant, RuleSpec } from "../src/index.ts";

test("a rule is verb:name[@target], with call as the default verb and an optional ask", () => {
  expect(rule("task.create")).toMatchObject({ verb: "call", name: "task.create", ask: false });
  expect(rule("emit:wf.*")).toMatchObject({ verb: "emit", name: "wf.*", ask: false });
  expect(rule({ do: "rin.decide@money", ask: true })).toMatchObject({ verb: "call", name: "rin.decide", target: "money", ask: true });
  expect(ruleText(rule("net:registry.npmjs.org"))).toBe("net:registry.npmjs.org");
  expect(() => rule("task.*.x")).toThrow("not a mask");
  expect(() => rule("hover:x")).toThrow("not a mask");
});

test("what is not listed is forbidden, and the longest match wins", () => {
  const own = grant(["task.*", "task.create", { do: "rin.*", ask: true }, "rin.note", "emit:wf.*", "*"]);
  expect(match(own, "call", "task.create")).toMatchObject({ name: "task.create" });
  expect(match(own, "call", "task.finish")).toMatchObject({ name: "task.*" });
  // The exact rule is longer than `rin.*`, so the note is free and the rest asks.
  expect(match(own, "call", "rin.note")?.ask).toBe(false);
  expect(match(own, "call", "rin.self.propose")?.ask).toBe(true);
  // `*` is the call verb only.
  expect(match(own, "call", "anything.else")).toMatchObject({ name: "*" });
  expect(match(own, "emit", "wf.step")).toMatchObject({ verb: "emit" });
  expect(match(own, "emit", "request.answered")).toBeUndefined();
  expect(match(grant(["task.create"]), "call", "task.finish")).toBeUndefined();
  expect(match(grant(["task.create"]), "tool", "task.create")).toBeUndefined();
});

test("a rule with a target says nothing about a call without one", () => {
  const own = grant(["rin.decide@build", { do: "rin.decide@money", ask: true }, "rin.*"]);
  expect(match(own, "call", "rin.decide", "build")).toMatchObject({ target: "build", ask: false });
  expect(match(own, "call", "rin.decide", "money")).toMatchObject({ ask: true });
  expect(match(own, "call", "rin.decide", "other")).toMatchObject({ name: "rin.*" });
  expect(match(own, "call", "rin.decide")).toMatchObject({ name: "rin.*" });
  expect(match(grant(["rin.decide@build"]), "call", "rin.decide")).toBeUndefined();
  expect(match(grant(["plugin.install@rin/*"]), "call", "plugin.install", "rin/memory")).toBeDefined();
  expect(match(grant(["plugin.install@rin/*"]), "call", "plugin.install", "other/x")).toBeUndefined();
});

test("narrow gives the rules the parent has, inheriting ask", () => {
  const parent = grant(["rin.*", { do: "rin.self.*", ask: true }, "task.create"]);
  const got = narrow(parent, ["rin.note", "rin.self.propose", "task.create"]);
  expect(got).toEqual({
    rules: grant(["rin.note", { do: "rin.self.propose", ask: true }, "task.create"]),
  });
});

test("asking for more than the parent has is refused with the masks, never narrowed", () => {
  const parent = grant(["rin.*", "task.create"]);
  expect(narrow(parent, ["rin.note", "gitlab.push"])).toEqual({ refused: ["call:gitlab.push"] });
  // A wider mask than the parent's, a wider verb, a target the parent does not hold.
  expect(narrow(parent, ["*"])).toEqual({ refused: ["call:*"] });
  expect(narrow(parent, ["emit:wf.*"])).toEqual({ refused: ["emit:wf.*"] });
  expect(narrow(grant(["rin.decide@build"]), ["rin.decide"])).toEqual({ refused: ["call:rin.decide"] });
  expect(narrow(grant(["rin.decide@build"]), ["rin.decide@money"])).toEqual({ refused: ["call:rin.decide@money"] });
  expect(narrow(grant([]), ["task.create"])).toEqual({ refused: ["call:task.create"] });
});

test("a wide request cannot lift an ask the parent set on a part of it", () => {
  const parent = grant(["rin.*", { do: "rin.self.*", ask: true }]);
  const got = narrow(parent, ["rin.*"]);
  if (!("rules" in got)) throw new Error("expected rules");
  expect(match(got.rules, "call", "rin.note")?.ask).toBe(false);
  expect(match(got.rules, "call", "rin.self.propose")?.ask).toBe(true);
  // The same through a target: the parent asks for one area.
  const areas = grant(["rin.*", { do: "rin.decide@money", ask: true }]);
  const wide = narrow(areas, ["rin.decide"]);
  if (!("rules" in wide)) throw new Error("expected rules");
  expect(match(wide.rules, "call", "rin.decide", "money")?.ask).toBe(true);
  expect(match(wide.rules, "call", "rin.decide", "build")?.ask).toBe(false);
});

test("a request that asks is kept asking even where the parent does not", () => {
  const got = narrow(grant(["task.*"]), [{ do: "task.create", ask: true }]);
  expect(got).toEqual({ rules: grant([{ do: "task.create", ask: true }]) });
});

test("a grant that lost a rule or gained an ask is narrowed; one that only gained is widened", () => {
  const before = grant(["task.*", "message.send"]);
  expect(narrowed(before, grant(["task.*"]))).toBe(true);
  expect(narrowed(before, grant(["task.*", { do: "message.send", ask: true }]))).toBe(true);
  expect(narrowed(before, grant(["task.create", "message.send"]))).toBe(true);
  expect(narrowed(before, grant(["task.*", "message.send", "emit:wf.*"]))).toBe(false);
  expect(narrowed(before, grant(["*"]))).toBe(false);
  expect(narrowed(before, before)).toBe(false);
});

test("rules are stored as text and read back the same", () => {
  const own = grant(["task.*", { do: "rin.self.*", ask: true }, "emit:wf.*", "plugin.install@rin/*"]);
  expect(grant(specsOf(own))).toEqual(own);
  // The same line twice is one rule, and the one that asks stands.
  expect(grant(["task.x", { do: "task.x", ask: true }]).rules).toHaveLength(1);
  expect(grant(["task.x", { do: "task.x", ask: true }]).rules[0]?.ask).toBe(true);
});

/** How closed a call is under a grant: 0 passes, 1 asks, 2 is refused. */
function closedness(of: Grant, name: string, target?: string): number {
  const found = match(of, "call", name, target);
  if (found === undefined) return 2;
  return found.ask ? 1 : 0;
}

const NAMES = ["*", "a.*", "a.b", "a.c", "b.d"];
const TARGETS = [undefined, "*", "x/*", "x/y"];
const SPECS: RuleSpec[] = NAMES.flatMap((name) =>
  TARGETS.flatMap((target) => {
    const text = target === undefined ? name : `${name}@${target}`;
    return [text, { do: text, ask: true as const }];
  }),
);
const CALL_NAMES = ["a.b", "a.c", "a.d", "b.d", "c.x"];
const CALL_TARGETS = [undefined, "x/y", "x/z", "w"];

/** Every call the rules above can tell apart: whether a grant answers it does not depend on anything else. */
function* calls(): Generator<[string, string | undefined]> {
  for (const name of CALL_NAMES) for (const target of CALL_TARGETS) yield [name, target];
}

/** A violation of what a narrowed grant owes its parent, or nothing. */
function violation(parent: Grant, requested: RuleSpec, child: Grant): string | undefined {
  const asked = rule(requested);
  for (const [name, target] of calls()) {
    const at = `${name}${target === undefined ? "" : `@${target}`}`;
    const now = closedness(child, name, target);
    if (now < closedness(parent, name, target)) return `${at} is less closed than under the parent`;
    const inRequest = match({ rules: [{ ...asked, ask: false }] }, "call", name, target) !== undefined;
    if (now < 2 && !inRequest) return `${at} is outside the request`;
  }
  return undefined;
}

test("narrowing never leaves a call less closed than the parent has it, over every pair of parent rules", () => {
  const failures: string[] = [];
  for (const first of SPECS) {
    for (const second of SPECS) {
      const parent = grant([first, second]);
      for (const requested of SPECS) {
        const got = narrow(parent, [requested]);
        if ("refused" in got) continue;
        const bad = violation(parent, requested, got.rules);
        if (bad !== undefined) failures.push(`${JSON.stringify([first, second])} narrowed by ${JSON.stringify(requested)}: ${bad}`);
      }
    }
  }
  expect(failures.slice(0, 5)).toEqual([]);
});

test("narrowing never leaves a call less closed than the parent has it, over parents of four rules", () => {
  // A fixed generator: the same rules on every run.
  let state = 20260101;
  const next = (below: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
  const pick = (): RuleSpec => SPECS[next(SPECS.length)]!;
  const failures: string[] = [];
  for (let round = 0; round < 3000; round++) {
    const parent = grant([pick(), pick(), pick(), pick()]);
    const wanted = [pick(), pick()];
    const got = narrow(parent, wanted);
    if ("refused" in got) continue;
    for (const requested of wanted) {
      const bad = violation(parent, requested, got.rules);
      // Two requests share one child: a call in both is judged by the child as a whole, so only
      // what the parent owes is held against it.
      if (bad?.endsWith("under the parent") === true) failures.push(`${JSON.stringify(specsOf(parent))} narrowed by ${JSON.stringify(wanted)}: ${bad}`);
    }
  }
  expect(failures.slice(0, 5)).toEqual([]);
});

test("a parent rule that asks on a target is still asked when the request narrows the name only", () => {
  const parent = grant(["*", { do: "a.*@secret/*", ask: true }]);
  const got = narrow(parent, ["a.b@*"]);
  if (!("rules" in got)) throw new Error("expected rules");
  expect(match(got.rules, "call", "a.b", "secret/x")?.ask).toBe(true);
  expect(match(got.rules, "call", "a.b", "open/x")?.ask).toBe(false);
});

test("a grant that now asks on part of what a rule of the old one let through is narrowed", () => {
  const before = grant(["a.b@*"]);
  expect(narrowed(before, grant(["*", { do: "a.*@secret/*", ask: true }]))).toBe(true);
  expect(narrowed(before, grant(["*", { do: "a.*@secret/*" }]))).toBe(false);
});

test("a grant is not narrowed by itself, and one that only drops asks or adds rules is not either", () => {
  const failures: string[] = [];
  const check = (rules: RuleSpec[]): void => {
    const own = grant(rules);
    if (narrowed(own, own)) failures.push(`${JSON.stringify(rules)} is narrowed by itself`);
    // The same rules without their asks, and with a rule on top, hold everything the grant has.
    const open = grant(rules.map((spec) => (typeof spec === "string" ? spec : spec.do)));
    if (narrowed(own, open)) failures.push(`${JSON.stringify(rules)} is narrowed by dropping its asks`);
    if (narrowed(own, grant([...rules, "emit:wf.*"]))) failures.push(`${JSON.stringify(rules)} is narrowed by gaining a rule`);
  };
  for (const first of SPECS) for (const second of SPECS) check([first, second]);
  let state = 7;
  const next = (below: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
  for (let round = 0; round < 3000; round++) check([0, 1, 2, 3].map(() => SPECS[next(SPECS.length)]!));
  expect(failures.slice(0, 5)).toEqual([]);
});

test("a grant that gives up an ask is widened, whatever rules sit under it", () => {
  const before = grant([{ do: "a.*", ask: true }, "a.b"]);
  expect(narrowed(before, grant(["a.*", "a.b"]))).toBe(false);
  const own = grant([{ do: "a.*@x/*", ask: true }, "a.b@*"]);
  expect(narrowed(own, own)).toBe(false);
});

test("a mask never grants an irreversible action: only a rule that names it does", () => {
  const masks = grant(["*", "forge.*", "forge.pr.*@git.example.com/acme/billing/pr/*"]);
  expect(match(masks, "call", "forge.pr.merge", "git.example.com/acme/billing/pr/7")).toBeDefined();
  expect(match(masks, "call", "forge.pr.merge", "git.example.com/acme/billing/pr/7", { irreversible: true })).toBeUndefined();
  const named = grant(["forge.*", "forge.pr.merge@git.example.com/acme/billing/pr/*"]);
  expect(match(named, "call", "forge.pr.merge", "git.example.com/acme/billing/pr/7", { irreversible: true })).toMatchObject({ name: "forge.pr.merge" });
  expect(match(named, "call", "forge.pr.merge", "git.example.com/acme/other/pr/7", { irreversible: true })).toBeUndefined();
});

test("a child cannot name an irreversible action its parent holds only by a mask", () => {
  const irreversible = (name: string): boolean => name === "forge.pr.merge";
  expect(narrow(grant(["forge.*"]), ["forge.pr.merge"], { irreversible })).toEqual({ refused: ["call:forge.pr.merge"] });
  expect(narrow(grant(["*"]), ["forge.pr.merge@h/p/pr/1"], { irreversible })).toEqual({ refused: ["call:forge.pr.merge@h/p/pr/1"] });
  // The parent names it: the child may have it, as narrow as it asks.
  const named = narrow(grant(["forge.*", "forge.pr.merge@h/p/pr/*"]), ["forge.pr.merge@h/p/pr/1"], { irreversible });
  expect("rules" in named && specsOf(named.rules)).toEqual(["call:forge.pr.merge@h/p/pr/1"]);
  // A mask the child asks for does not carry the parent's rule that names it.
  const masked = narrow(grant(["forge.*", "forge.pr.merge@h/p/pr/*"]), ["forge.*"], { irreversible });
  expect("rules" in masked && specsOf(masked.rules)).toEqual(["call:forge.*"]);
  // An action that is not irreversible is held by a mask as before.
  expect("rules" in narrow(grant(["forge.*"]), ["forge.pr.read"], { irreversible })).toBe(true);
});
