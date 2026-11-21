/**
 * Visible actions: which niwa actions a session sees and which harness tools are switched off.
 *
 * They are set at start and do not change under the session. Nothing is implied: a session that
 * is given nothing sees no niwa action at all.
 */

import { z } from "zod";

import { NO_VISIBLE_ACTIONS } from "@niwa-labs/harness";
import type { VisibleActions } from "@niwa-labs/harness";

/** What a caller gives when it starts a session. */
export const VisibleActionsInputSchema = z.object({
  /** The niwa actions the session sees. */
  actions: z.array(z.string().min(1)).optional(),
  /** The harness tools that are switched off for the session. */
  disabledTools: z.array(z.string().min(1)).optional(),
});

export type VisibleActionsInput = z.output<typeof VisibleActionsInputSchema>;

/** The visible actions of a session, from what the caller gave. */
export function visibleActionsOf(input?: VisibleActionsInput): VisibleActions {
  if (input === undefined) return NO_VISIBLE_ACTIONS;
  return { actions: input.actions ?? [], disabledTools: input.disabledTools ?? [] };
}
