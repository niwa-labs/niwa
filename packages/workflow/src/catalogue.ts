/**
 * The actions a script may use: what the host describes, narrowed to what the caller may call.
 *
 * `callableBy` is the one place that decides which actions a caller can call: the ones its grant
 * lets it call, an action it must ask for included. The check and the guide both ask it.
 */

import { z } from "zod";

import { JsonSchemaValue, actionName, actionRef } from "@niwa-labs/core";
import { match } from "@niwa-labs/core";
import type { ActionContext, ActionDescription, ActionName, Grant } from "@niwa-labs/core";
import type { OptionsBlock } from "@niwa-labs/harness";
import { harnessList } from "@niwa-labs/sessions/records";

/** niwa's description of itself, as far as a script needs it. */
const describeRef = actionRef("niwa.describe", {
  description: "What niwa is: its actions and its record types, with their schemas.",
  input: z.object({}),
  output: z.object({
    actions: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        recovery: z.enum(["repeat", "repeat-with-key", "do-not-repeat"]),
        effect: z.enum(["read", "record", "write", "irreversible"]),
        world: z.enum(["niwa", "local", "external"]).optional(),
        idempotent: z.boolean().optional(),
        destructive: z.boolean().optional(),
        input: JsonSchemaValue,
        output: JsonSchemaValue,
      }),
    ),
  }),
});

/** The actions the caller may call, out of the names the host serves. */
export function callableBy(
  names: readonly ActionName[],
  rights: Grant | "unlimited",
): ActionName[] {
  return rights === "unlimited" ? [...names] : names.filter((name) => match(rights, "call", name) !== undefined);
}

/** The options block of each harness, by its name, out of what `harness.list` answers: a harness with none is not in it. */
function blocksByHarness(answer: { items: ReadonlyArray<{ name: string; block?: OptionsBlock }> }): Map<string, OptionsBlock> {
  return new Map(answer.items.flatMap((one) => (one.block === undefined ? [] : [[one.name, one.block] as const])));
}

/**
 * The actions of the host, the ones of them the caller may call, and the options block of each harness as the sessions
 * module binds it. A host with no sessions module binds no harness, so no harness takes a block.
 */
export async function catalogueFor(
  ctx: ActionContext,
  held: Grant | "unlimited",
): Promise<{ actions: ActionDescription[]; callable: ActionName[]; rights: Grant | "unlimited"; blocks: ReadonlyMap<string, OptionsBlock> }> {
  const described = await ctx.step(describeRef, {});
  const actions = described.actions.map((action): ActionDescription => ({ ...action, name: actionName(action.name) }));
  const blocks = actions.some((action) => action.name === harnessList.name) ? blocksByHarness(await ctx.step(harnessList, {})) : new Map<string, OptionsBlock>();
  return { actions, callable: callableBy(actions.map((action) => action.name), held), rights: held, blocks };
}
