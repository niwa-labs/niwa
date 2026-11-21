// The class of an action's effect: declared with the action, checked when it is declared, and
// carried by the action itself.

import { expect, test } from "bun:test";
import { z } from "zod";

import { action, actionRef } from "../src/index.ts";

const base = {
  description: "Does a thing.",
  input: z.object({}),
  output: z.object({}),
  recovery: "repeat" as const,
  run: () => ({}),
};

test("an action carries the effect and the world it declares", () => {
  const merge = action("forge.pr.merge", { ...base, effect: "irreversible", world: "external", recovery: "do-not-repeat" });
  expect(merge.effect).toBe("irreversible");
  expect(merge.world).toBe("external");
  expect("idempotent" in merge).toBe(false);
  expect("destructive" in merge).toBe(false);
  const note = action("plan.set", { ...base, effect: "record", idempotent: true });
  expect(note.effect).toBe("record");
  expect("world" in note).toBe(false);
  expect(note.idempotent).toBe(true);
});

test("an action built from a reference declares its effect too", () => {
  const ref = actionRef("thing.read", { description: "Reads a thing.", input: z.object({}), output: z.object({}) });
  const read = action(ref, { recovery: "repeat", effect: "read", world: "niwa", run: () => ({}) });
  expect(read.effect).toBe("read");
  expect(read.world).toBe("niwa");
});

test("an action without an effect, or with an unknown one, is refused when it is declared", () => {
  expect(() => action("a.b", { ...base } as never)).toThrow('action "a.b": effect must be one of read, record, write, irreversible');
  expect(() => action("a.b", { ...base, effect: "delete" } as never)).toThrow("effect must be one of");
  expect(() => action("a.b", { ...base, effect: "read", world: "cloud" } as never)).toThrow('action "a.b": world must be one of niwa, local, external');
  expect(() => action("a.b", { ...base, effect: "read", idempotent: "yes" } as never)).toThrow("idempotent must be a boolean");
});

test("an irreversible action cannot say it destroys nothing", () => {
  expect(() => action("a.b", { ...base, effect: "irreversible", destructive: false })).toThrow("an irreversible action is destructive");
});
