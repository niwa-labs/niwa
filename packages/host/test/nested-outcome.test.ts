// What a direct call made from inside an action says about its outcome. A call that is refused
// before its body starts cannot have had an effect; one whose body ran and whose answer was not
// valid may have.

import { expect, test } from "bun:test";

import { action } from "@niwa-labs/core";
import type { Outcome } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Wrong = action("nested-outcome.wrong", {
  description: "Does its work and answers with something its output does not allow.",
  input: z.object({}),
  output: z.object({ n: z.number() }),
  recovery: "repeat",
  effect: "write",
  run: async () => ({ n: "not a number" }) as unknown as { n: number },
});

const Strict = action("nested-outcome.strict", {
  description: "Needs a number.",
  input: z.object({ n: z.number() }),
  output: z.object({}),
  recovery: "repeat",
  effect: "write",
  run: async () => ({}),
});

const Outer = action("nested-outcome.outer", {
  description: "Calls the other two and reports their outcomes.",
  input: z.object({}),
  output: z.object({ wrong: z.unknown(), badInput: z.unknown() }),
  recovery: "repeat",
  effect: "write",
  run: async (_input, ctx) => ({
    wrong: await ctx.step.outcome(Wrong, {}),
    badInput: await ctx.step.outcome(Strict, { n: "x" } as unknown as { n: number }),
  }),
});

test("a nested call whose output is not valid may have had an effect; one whose input is not valid cannot", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("nested-outcome", (api) => {
    api.action(Wrong);
    api.action(Strict);
    api.action(Outer);
  }));
  await niwa.serve();
  try {
    const { wrong, badInput } = (await niwa.call(Outer, {})) as { wrong: Outcome<unknown>; badInput: Outcome<unknown> };
    expect(wrong).toMatchObject({ status: "failed", effectPossible: true });
    expect(badInput).toMatchObject({ status: "failed", effectPossible: false });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
