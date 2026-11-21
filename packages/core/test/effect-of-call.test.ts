// The class of one call: an action whose effect depends on its input says which class a call has,
// with the input the call is made with, before the grant decides it. The class it declares is the
// most a call can be.

import { expect, test } from "bun:test";
import { z } from "zod";

import { action, grant, grantId } from "../src/index.ts";
import type { Caller, Effect, Standing } from "../src/index.ts";
import { decide, newIntercepts } from "../src/journal.ts";

const caller: Caller = { kind: "host" };
const masked = (rules: string[]): Standing => ({ kind: "limited", id: grantId("g-test"), grant: grant(rules) });

/** CI on a branch: an ordinary branch is a write, a protected branch or a tag cannot be taken back. */
const ci = (classify: (input: { ref: string }) => Effect = ({ ref }) => (ref === "main" || ref.startsWith("v") ? "irreversible" : "write")) =>
  action("forge.ci.run", {
    description: "Runs CI on a ref.",
    input: z.object({ ref: z.string() }),
    output: z.object({ ok: z.boolean() }),
    recovery: "do-not-repeat",
    effect: "irreversible",
    classify,
    run: () => ({ ok: true }),
  });

test("an action that classifies its calls keeps the declared class as the most a call can be", () => {
  expect(() =>
    action("a.b", {
      description: "Does a thing.",
      input: z.object({}),
      output: z.object({}),
      recovery: "repeat",
      effect: "write",
      classify: "write" as never,
      run: () => ({}),
    }),
  ).toThrow('action "a.b": classify must be a function');
  const run = ci();
  expect(run.effect).toBe("irreversible");
  expect(typeof run.classify).toBe("function");
});

test("a mask grants a call that classifies as a write, and not one that classifies as irreversible", async () => {
  const intercepts = newIntercepts();
  const standing = masked(["forge.*"]);
  const branch = await decide({ intercepts, action: ci(), input: { ref: "feature/x" }, caller, standing });
  expect(branch).toMatchObject({ kind: "allowed", effect: "write" });
  const main = await decide({ intercepts, action: ci(), input: { ref: "main" }, caller, standing });
  expect(main).toMatchObject({ kind: "denied", effect: "irreversible" });
  expect(main.kind === "denied" ? main.reason : "").toContain("is irreversible");
  const named = await decide({ intercepts, action: ci(), input: { ref: "main" }, caller, standing: masked(["forge.ci.run"]) });
  expect(named).toMatchObject({ kind: "allowed", effect: "irreversible" });
});

test("the class is taken from the input an adjust leaves, not the one requested", async () => {
  const intercepts = newIntercepts();
  intercepts.adjusts.push(() => ({ ref: "v1.0" }));
  const moved = await decide({ intercepts, action: ci(), input: { ref: "feature/x" }, caller, standing: masked(["forge.*"]) });
  expect(moved).toMatchObject({ kind: "denied", effect: "irreversible" });
});

test("a classifier that throws or says more than the action declares refuses the call", async () => {
  const intercepts = newIntercepts();
  const throwing = ci(() => {
    throw new Error("no branch protection to read");
  });
  const thrown = await decide({ intercepts, action: throwing, input: { ref: "x" }, caller });
  expect(thrown.kind).toBe("denied");
  expect(thrown.kind === "denied" ? thrown.reason : "").toContain("no branch protection to read");
  const above = action("a.b", {
    description: "Does a thing.",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    effect: "write",
    classify: () => "irreversible",
    run: () => ({}),
  });
  const refused = await decide({ intercepts, action: above, input: {}, caller });
  expect(refused.kind).toBe("denied");
  expect(refused.kind === "denied" ? refused.reason : "").toContain('declares at most "write"');
  const unknown = action("a.c", {
    description: "Does a thing.",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    effect: "write",
    classify: () => "delete" as never,
    run: () => ({}),
  });
  expect(await decide({ intercepts, action: unknown, input: {}, caller })).toMatchObject({ kind: "denied" });
});

test("an action that does not classify its calls has the class it declares", async () => {
  const plain = action("a.d", {
    description: "Does a thing.",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    effect: "record",
    run: () => ({}),
  });
  expect(await decide({ intercepts: newIntercepts(), action: plain, input: {}, caller })).toMatchObject({ kind: "allowed", effect: "record" });
});
