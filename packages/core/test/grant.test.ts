// Grants as pure values: a flat allow-list, the longest match wins, and a request wider than the parent is refused, not narrowed.

import { expect, test } from "bun:test";

import { grant, match, narrow, narrowed, rule, ruleText, specsOf } from "../src/index.ts";

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
