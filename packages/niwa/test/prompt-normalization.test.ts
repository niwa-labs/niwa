// The prompt is normalized by the input schema, so intercepts see sections, never raw text.

import { expect, test } from "bun:test";

import { action, deny } from "@niwa-labs/core";
import { z } from "zod";

import { decide, newIntercepts } from "@niwa-labs/core/journal";
import { PromptInputSchema } from "@niwa-labs/sessions";

const Take = action("prompt-norm.take", {
  description: "Takes a prompt.",
  input: z.object({ prompt: PromptInputSchema }),
  output: z.object({}),
  recovery: "repeat",
  effect: "write",
  run: () => ({}),
});

const CALLER = { kind: "host" } as const;
const SECTIONS = { sections: [{ id: "prompt", tier: "volatile" as const, text: "hello" }] };

test("plain text reaches the adjusts and the guards as sections, and the decision stays JSON-stable", async () => {
  const intercepts = newIntercepts();
  const seenByAdjust: unknown[] = [];
  const seenByGuard: unknown[] = [];
  intercepts.adjusts.push((input: { prompt: unknown }) => {
    seenByAdjust.push(input.prompt);
  });
  intercepts.guards.push((input: { prompt: unknown }) => {
    seenByGuard.push(input.prompt);
    return undefined;
  });

  const decision = await decide({ intercepts, action: Take, input: { prompt: "hello" }, caller: CALLER });

  expect(seenByAdjust).toEqual([SECTIONS]);
  expect(seenByGuard).toEqual([SECTIONS]);
  expect(decision.kind).toBe("allowed");
  if (decision.kind !== "allowed") return;
  expect(decision.requested).toEqual({ prompt: SECTIONS });
  expect(decision.final).toEqual({ prompt: SECTIONS });
  // What the journal holds survives a round trip, and the normalized input is a fixed point.
  expect(JSON.parse(JSON.stringify(decision.final))).toEqual(decision.final);
  expect(Take.input.parse(decision.final)).toEqual(decision.final);
});

test("a guard that denies on a section sees the text it would have denied", async () => {
  const intercepts = newIntercepts();
  intercepts.guards.push((input: { prompt: { sections: Array<{ text: string }> } }) =>
    input.prompt.sections.some((section) => section.text.includes("forbidden")) ? deny("no") : undefined,
  );
  const decision = await decide({ intercepts, action: Take, input: { prompt: "a forbidden word" }, caller: CALLER });
  expect(decision.kind).toBe("denied");
});

test("sections with a repeated id are an invalid input, not a throw inside the run", async () => {
  const section = { id: "x", tier: "volatile", text: "t" };
  const decision = await decide({
    intercepts: newIntercepts(),
    action: Take,
    input: { prompt: { sections: [section, section] } },
    caller: CALLER,
  });
  expect(decision.kind).toBe("invalid");
});

test("the schema of the input is still a JSON schema that takes text or sections, and the output is a fixed point", () => {
  const schema = z.toJSONSchema(Take.input, { io: "input", unrepresentable: "any" }) as unknown as {
    properties: { prompt: { anyOf: Array<{ type: string }> } };
  };
  expect(schema.properties.prompt.anyOf.map((branch) => branch.type).sort()).toEqual(["object", "string"]);
  // Parsing what was parsed changes nothing: a replay that reads the stored input again agrees.
  const once = Take.input.parse({ prompt: "hello" });
  expect(Take.input.parse(once)).toEqual(once);
  const sections = Take.input.parse({ prompt: SECTIONS });
  expect(Take.input.parse(sections)).toEqual(sections);
});
