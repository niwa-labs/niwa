/**
 * What a host keeps outside the journal, and how a record points at it.
 *
 * The journal holds whole what niwa did and decided, as long as it is small. Data larger than
 * `ARTIFACT_THRESHOLD` is kept as an artifact: immutable bytes named by their digest, written to
 * disk before any record points at them. A record holds the reference, never the bytes. The data
 * of one record is bounded by `RECORD_DATA_LIMIT`, so the journal stays a journal.
 *
 * A secret is never data at all: a record holds a reference, `secret("name")`, and the value is
 * resolved by the host where it is used, from a source the owner keeps.
 */

import { z } from "zod";

import { CatchableError } from "./errors.ts";

/** Data larger than this many bytes is kept as an artifact, and the record holds its reference. */
export const ARTIFACT_THRESHOLD = 16 * 1024;

/** The most bytes the data of one record may take, written as JSON. */
export const RECORD_DATA_LIMIT = 256 * 1024;

/** Bytes kept whole, by the SHA-256 of their content, with their size and media type. */
export const ArtifactRefSchema = z.strictObject({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  type: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Bytes written to an artifact as they arrive. One per artifact. */
export interface ArtifactWriter {
  /** Takes the next bytes, in order. */
  write(chunk: Uint8Array): void;
  /** Makes the artifact durable and gives its reference. Nothing may be written after. */
  finish(): ArtifactRef;
  /** Throws away what was written: no artifact is made. */
  discard(): void;
}

/** The artifacts of a host. */
export interface ArtifactStore {
  /** Keeps the bytes and gives their reference, once they are on disk. The same bytes are one artifact. */
  put(bytes: Uint8Array | string, type: string): ArtifactRef;
  /** A writer for bytes that arrive in parts. */
  writer(type: string): ArtifactWriter;
  /** The bytes of an artifact. An artifact the host does not have is an `ArtifactMissing`. */
  read(ref: Pick<ArtifactRef, "digest">): Uint8Array;
}

/** An artifact a record points at is not on this host. */
export class ArtifactMissing extends Error {
  override name = "ArtifactMissing";
  readonly code = "ArtifactMissing";

  constructor(readonly digest: string) {
    super(`the artifact ${digest} is not on this host`);
  }
}

/** The data of a record is larger than a record may be. Nothing was written. */
export class RecordTooLarge extends Error {
  override name = "RecordTooLarge";
  readonly code = "RecordTooLarge";

  constructor(
    readonly type: string,
    readonly size: number,
  ) {
    super(`the data of a "${type}" record is ${String(size)} bytes, more than the ${String(RECORD_DATA_LIMIT)} a record may hold: keep it as an artifact`);
  }
}

/** The name of a secret: letters, digits and underscores, so it is a valid name of a variable too. */
export const SecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a secret name is letters, digits and underscores");

/** A reference to a secret. The value lives with the owner and is resolved by the host where it is used. */
export const SecretRef = z.strictObject({ secret: SecretName });
export type SecretRef = z.infer<typeof SecretRef>;

/** The reference to the secret called `name`. */
export function secret(name: string): SecretRef {
  return SecretRef.parse({ secret: name });
}

/** Why a secret was not given. */
export type SecretRefusalCode = "unknown-secret" | "unsafe-secret";

/** A secret that cannot be given: the caller's to catch, since nothing used it. Its message never holds a value. */
export class SecretRefusal extends CatchableError {
  override name = "SecretRefusal";
  override readonly code: SecretRefusalCode;

  constructor(code: SecretRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The secrets of a host's owner. */
export interface SecretStore {
  /** The value of the secret called `name`; a `SecretRefusal` when there is none, or its source is unsafe. */
  resolve(name: string): string;
  /** The directory the secret files live in: a confined process is kept from reading it. */
  readonly dir: string;
}
