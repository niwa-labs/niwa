/**
 * Who is looking, and what they may call.
 *
 * The web surface is one client of the host and holds one grant: the owner's, when the page speaks for the owner, or the
 * grant of a plain client. The host decides every call by that grant; this only reads it, so the page can hide what it
 * could not call. Reading it is not a check: a call is allowed or refused by the host, whatever this says.
 */

import { z } from "zod";

import { accessMine, grant, match, principalSchema, RuleSpecSchema } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";
import { HostError } from "@niwa-labs/client";

/** What the cockpit's SDK builds a viewer from. */
export interface Viewer {
  /** The id the host knows this client by. */
  readonly id: string;
  /** The viewer speaks for the owner. */
  readonly owner: boolean;
  /** The actions the viewer may call, by name. */
  readonly actions: readonly string[];
}

const Mine = z.object({
  principal: principalSchema.optional(),
  unlimited: z.boolean(),
  closed: z.string().optional(),
  rules: z.array(RuleSpecSchema),
});

/**
 * The viewer of this connection: the principal it acts as, and the actions its grant lets it call.
 *
 * A rule that asks the owner at the moment of the call counts: the action is callable. A grant that was closed, or a client
 * that may not read its own rules, may call nothing as far as this can tell.
 */
export async function viewerOf(api: NiwaApi, fallbackId: string): Promise<Viewer> {
  const everything = (await api.describe()).actions.map(({ name }) => String(name));
  let mine: z.output<typeof Mine>;
  try {
    mine = Mine.parse(await api.call(accessMine, {}));
  } catch (error) {
    if (error instanceof HostError && error.denied !== undefined) return { id: fallbackId, owner: false, actions: [] };
    throw error;
  }
  const id = mine.principal === undefined ? fallbackId : String(mine.principal.id);
  const owner = mine.principal?.kind === "owner";
  if (mine.closed !== undefined) return { id, owner, actions: [] };
  if (mine.unlimited) return { id, owner, actions: everything.sort() };
  const rules = grant(mine.rules);
  return { id, owner, actions: everything.filter((name) => match(rules, "call", name) !== undefined).sort() };
}

