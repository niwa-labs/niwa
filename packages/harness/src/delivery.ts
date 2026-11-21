/**
 * What became of an input sent into a session: accepted, never sent, or possibly sent.
 *
 * A message that a side failed to write is safe to send again; a message that was written and
 * whose answer never came may already be running as a turn, and sending it again would start a
 * second one. A control side says which by the error it fails with: `InputNotSent` when nothing
 * reached the harness or the harness refused it, `InputPossiblySent` when it may have taken it.
 * Any other failure of a send is read as possibly sent: an input is never sent twice on a guess.
 */

import { NotSent } from "@niwa-labs/core";
import { z } from "zod";

import { Unsupported } from "./capabilities.ts";
import { DeliveryReceiptSchema } from "./control.ts";
import type { DeliveryReceipt } from "./control.ts";
import type { Harness } from "./instance.ts";

/**
 * How far a request to a harness got before it failed: never written (`unsent`), answered with a
 * refusal (`refused`), or written and never answered (`uncertain`).
 */
export type Dispatch = "unsent" | "refused" | "uncertain";

/** The input did not reach the harness, or the harness refused it: sending it again is safe. */
export class InputNotSent extends NotSent {
  override name = "InputNotSent";
  override readonly code = "InputNotSent";

  constructor(
    readonly harness: Harness["id"],
    readonly ability: string,
    detail: string,
  ) {
    super(`harness "${harness}" did not take the input of ${ability}: ${detail}`);
  }
}

/** The input may have reached the harness: it is never sent again by itself. */
export class InputPossiblySent extends Error {
  override name = "InputPossiblySent";
  readonly code = "InputPossiblySent";

  constructor(
    readonly harness: Harness["id"],
    readonly ability: string,
    detail: string,
  ) {
    super(`harness "${harness}" may have taken the input of ${ability}, and it is not sent again: ${detail}`);
  }
}

/** The error of a request that failed, by how far it got. */
export function inputFailure(harness: Harness["id"], ability: string, dispatch: Dispatch, detail: string): InputNotSent | InputPossiblySent {
  return dispatch === "uncertain" ? new InputPossiblySent(harness, ability, detail) : new InputNotSent(harness, ability, detail);
}

/** What became of an input. */
export const InputOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), receipt: DeliveryReceiptSchema }),
  z.object({ status: z.literal("unsent"), reason: z.string() }),
  z.object({ status: z.literal("possibly-sent"), reason: z.string() }),
]);
export type InputOutcome = z.output<typeof InputOutcomeSchema>;

/** The outcome of a send, by what it gave or failed with. */
export async function outcomeOf(sending: Promise<DeliveryReceipt>): Promise<InputOutcome> {
  try {
    return { status: "accepted", receipt: await sending };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A refusal by name is made before anything is sent.
    if (error instanceof InputNotSent || error instanceof Unsupported) return { status: "unsent", reason };
    return { status: "possibly-sent", reason };
  }
}
