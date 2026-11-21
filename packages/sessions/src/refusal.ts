import { NotSent } from "@niwa-labs/core";

/** A refusal: a session that cannot be started as it was asked for. Nothing was sent to its harness. */
export class SessionRefusal extends NotSent {
  override name = "SessionRefusal";
  /** The code of the refusal, so a caller can tell one from another. */
  override readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
