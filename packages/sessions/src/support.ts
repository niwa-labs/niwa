/**
 * "Can harness X do capability Y": the question as an action.
 *
 * A harness declares what each of its sides can do (`capabilities.ts`). That declaration is a
 * fact about the installation, known before any call, and a client (a script, an agent, a person at
 * the CLI) needs to ask it without holding the registry. `harness.supports` answers it from the
 * registry the plugin was given.
 *
 * The answer is the declaration, nothing more: `true` means the side declares the ability,
 * `false` means it does not, or the side does not exist. Whether the installation can serve it
 * right now is a different fact, and it is `Unavailable` at the call, not here. An id that is
 * not registered is not "no": it is an error that lists the ids there are.
 */

import { z } from "zod";

import { action, actionRef } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import {
  ControlCapabilitiesSchema,
  InsertCapabilitiesSchema,
  ReadingCapabilitiesSchema,
  supports,
} from "@niwa-labs/harness";
import type { Harness, HarnessInstanceRegistry } from "@niwa-labs/harness";

/** The question, one variant per side: the ability must be one the side has. */
const SupportsInput = z.discriminatedUnion("side", [
  z.object({
    harness: z.string().min(1),
    side: z.literal("reading"),
    ability: z.enum(ReadingCapabilitiesSchema.keyof().options),
  }),
  z.object({
    harness: z.string().min(1),
    side: z.literal("control"),
    ability: z.enum(ControlCapabilitiesSchema.omit({ launch: true, tools: true }).keyof().options),
  }),
  z.object({
    harness: z.string().min(1),
    side: z.literal("insert"),
    ability: z.enum(InsertCapabilitiesSchema.keyof().options),
  }),
]);

/** The answer: the question again, and whether the side declares the ability. */
const SupportsOutput = z.object({
  harness: z.string().min(1),
  side: z.enum(["reading", "control", "insert"]),
  ability: z.string().min(1),
  supported: z.boolean(),
});

/** Can this harness do this? The typed reference a caller imports to ask. */
export const harnessSupports = actionRef("harness.supports", {
  description:
    "Whether a harness declares an ability on one of its sides (reading, control, insert). It answers what the instance declares; whether the installation can serve it right now is known at the call.",
  input: SupportsInput,
  output: SupportsOutput,
});

/** Whether the instance declares what the question asks; the side narrows the ability. */
function declares(instance: Harness, question: z.output<typeof SupportsInput>): boolean {
  switch (question.side) {
    case "reading":
      return supports(instance, "reading", question.ability);
    case "control":
      return supports(instance, "control", question.ability);
    case "insert":
      return supports(instance, "insert", question.ability);
  }
}

/** The plugin that serves `harness.supports` from a registry of instances. */
export function harnessSupport(registry: HarnessInstanceRegistry): Plugin {
  return plugin("harness-support", (api) => {
    api.action(
      action(harnessSupports, {
        // A read of a declaration: it may be made again.
        recovery: "repeat",
        run: (input) => ({
          harness: input.harness,
          side: input.side,
          ability: input.ability,
          supported: declares(registry.resolve(input.harness), input),
        }),
      }),
    );
  });
}
