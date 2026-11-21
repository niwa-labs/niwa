/** The refusals of the proc module: a call that could not start a command. */

import { CatchableError } from "@niwa-labs/core";

/** Why a call was refused before a command started. */
export type ProcRefusalCode = "bad-cwd" | "not-started";

/** A refusal of the module: the caller's to catch, since nothing ran. */
export class ProcRefusal extends CatchableError {
  override name = "ProcRefusal";
  override readonly code: ProcRefusalCode;

  constructor(code: ProcRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}
