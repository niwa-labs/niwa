/**
 * Denials: the refusal a guard returns, the error a refused call throws, and the two reasons the
 * owner's question ends in. They are contracts any plugin may use; `decide`, which produces them,
 * lives with the journal runtime in intercept.ts.
 */

import type { Denial, GrantId, RecordId } from "./types.ts";

/** A refusal: what a guard returns to stop a call, and the reason it is recorded with. */
export function deny(reason: string): Denial {
  return { kind: "denial", reason };
}

/**
 * What a refusal by a grant says: whose grant, and the rule it lacks.
 * The caller sees it as `denied { grant, missing }`; `record` is the decision, for `access.explain`.
 */
export interface DeniedDetails {
  readonly grant: GrantId;
  readonly missing: string;
  readonly record?: RecordId;
}

/** The refusal of a call that was made outside an invocation: the code of the error is "Denied". */
export class DeniedError extends Error {
  override name = "Denied";
  readonly code = "Denied";
  /** Why the call was refused. */
  readonly reason: string;
  /** Set when a grant refused it. */
  readonly denied: DeniedDetails | undefined;

  constructor(reason: string, denied?: DeniedDetails) {
    super(reason);
    this.reason = reason;
    this.denied = denied;
  }
}

/** The reason of a call whose question nobody answered: no answer in time, a cancel, or nobody to ask. */
export const NOT_ANSWERED = "not answered";

/** The reason of a call whose question the owner refused. */
export const REFUSED_BY_OWNER = "refused by the owner";
