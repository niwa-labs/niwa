/** A refusal: a session that cannot be started as it was asked for. */
export class SessionRefusal extends Error {
  override name = "SessionRefusal";
  /** The code of the refusal, so a caller can tell one from another. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
