/**
 * Command output as an artifact of the host: bytes kept whole under the digest of their content.
 *
 * The output of a command goes to a writer of the host's artifact store as it arrives, and is made
 * durable and named when the command is over, so a record that points at it never points at one a
 * crash could take. The same bytes are the same artifact.
 *
 * Known secret values are replaced before a byte is written, and before it is kept in the tail:
 * a secret that straddles two chunks is still found, because the end of a chunk is held back until
 * the next one shows it cannot start a secret.
 */

import type { ArtifactRef, ArtifactStore, ArtifactWriter } from "@niwa-labs/core";

/** What stands where a secret was. */
export const REDACTED = Buffer.from("***");

/** Replaces every known secret in a stream of chunks. One per stream: the held-back end belongs to it. */
export class Scrubber {
  readonly #secrets: readonly Buffer[];
  readonly #hold: number;
  #held: Buffer = Buffer.alloc(0);

  constructor(secrets: readonly string[]) {
    this.#secrets = secrets.filter((value) => value.length > 0).map((value) => Buffer.from(value));
    this.#hold = Math.max(0, ...this.#secrets.map((value) => value.length - 1));
  }

  /** The part of the stream that can no longer change. */
  push(chunk: Uint8Array): Buffer {
    const all = this.#replace(Buffer.concat([this.#held, chunk]));
    const keep = Math.min(all.length, this.#hold);
    this.#held = all.subarray(all.length - keep);
    return all.subarray(0, all.length - keep);
  }

  /** The held-back end, once the stream is over. */
  end(): Buffer {
    const rest = this.#replace(this.#held);
    this.#held = Buffer.alloc(0);
    return rest;
  }

  #replace(bytes: Buffer): Buffer {
    let out = bytes;
    for (const secret of this.#secrets) {
      const parts: Buffer[] = [];
      let from = 0;
      for (let at = out.indexOf(secret, from); at !== -1; at = out.indexOf(secret, from)) {
        parts.push(out.subarray(from, at), REDACTED);
        from = at + secret.length;
      }
      if (parts.length > 0) out = Buffer.concat([...parts, out.subarray(from)]);
    }
    return out;
  }
}

export interface CaptureOptions {
  /** The store the output is kept in. */
  readonly artifacts: ArtifactStore;
  /** Values to remove from the output before anything is kept. */
  readonly secrets: readonly string[];
  /** The most bytes kept in the artifact; the rest of the output is read and dropped. */
  readonly limit: number;
  /** The bytes of the end of the output shown in the result. */
  readonly tailBytes: number;
}

/** What a finished capture gives back. */
export interface Captured {
  readonly output: ArtifactRef;
  readonly tail: string;
  readonly truncated: boolean;
}

/** One command's output, from the first byte to the artifact. */
export class OutputCapture {
  readonly #options: CaptureOptions;
  readonly #scrubbers: { readonly out: Scrubber; readonly err: Scrubber };
  readonly #writer: ArtifactWriter;
  #size = 0;
  #truncated = false;
  #tail: Buffer = Buffer.alloc(0);

  constructor(options: CaptureOptions) {
    this.#options = options;
    this.#scrubbers = { out: new Scrubber(options.secrets), err: new Scrubber(options.secrets) };
    this.#writer = options.artifacts.writer("text/plain");
  }

  /** Takes a chunk of one of the two streams, in the order it came. */
  feed(stream: "out" | "err", chunk: Uint8Array): void {
    this.#keep(this.#scrubbers[stream].push(chunk));
  }

  /** Flushes what is held back, makes the artifact durable and gives its name. */
  finish(): Captured {
    this.#keep(this.#scrubbers.out.end());
    this.#keep(this.#scrubbers.err.end());
    return { output: this.#writer.finish(), tail: new TextDecoder().decode(this.#tail), truncated: this.#truncated };
  }

  /** Throws away what was captured: the command never got to its end. */
  discard(): void {
    this.#writer.discard();
  }

  #keep(bytes: Buffer): void {
    if (bytes.length === 0) return;
    const { limit, tailBytes } = this.#options;
    const room = Math.max(0, limit - this.#size);
    const stored = bytes.subarray(0, room);
    if (stored.length < bytes.length) this.#truncated = true;
    if (stored.length > 0) {
      this.#writer.write(stored);
      this.#size += stored.length;
    }
    this.#tail = Buffer.concat([this.#tail, bytes]);
    if (this.#tail.length > tailBytes) this.#tail = this.#tail.subarray(this.#tail.length - tailBytes);
  }
}
