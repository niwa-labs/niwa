/**
 * Command output as an artifact: bytes kept whole under the digest of their content.
 *
 * The output of a command is written to a file as it arrives and moved to its name, `<sha256>`, when
 * the command is over. The file is flushed to disk before the name exists, so a record that points
 * at an artifact never points at one a crash could take. The same bytes are the same file.
 *
 * Known secret values are replaced before a byte is written, and before it is kept in the tail:
 * a secret that straddles two chunks is still found, because the end of a chunk is held back until
 * the next one shows it cannot start a secret.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ArtifactRef } from "./records.ts";

/** What stands where a secret was. */
export const REDACTED = Buffer.from("***");

/** The directory the artifacts of a host live in. */
export function artifactDir(home: string): string {
  return join(home, "proc", "artifacts");
}

/** The file of an artifact. */
export function artifactPath(home: string, ref: Pick<ArtifactRef, "digest">): string {
  return join(artifactDir(home), ref.digest.slice("sha256:".length));
}

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
  readonly home: string;
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
  readonly #hasher = new Bun.CryptoHasher("sha256");
  readonly #temp: string;
  readonly #fd: number;
  #size = 0;
  #truncated = false;
  #tail: Buffer = Buffer.alloc(0);

  constructor(options: CaptureOptions) {
    this.#options = options;
    this.#scrubbers = { out: new Scrubber(options.secrets), err: new Scrubber(options.secrets) };
    mkdirSync(artifactDir(options.home), { recursive: true, mode: 0o700 });
    this.#temp = join(artifactDir(options.home), `.partial-${randomUUID()}`);
    this.#fd = openSync(this.#temp, "wx", 0o600);
  }

  /** Takes a chunk of one of the two streams, in the order it came. */
  feed(stream: "out" | "err", chunk: Uint8Array): void {
    this.#keep(this.#scrubbers[stream].push(chunk));
  }

  /** Flushes what is held back, makes the artifact durable and gives its name. */
  finish(): Captured {
    this.#keep(this.#scrubbers.out.end());
    this.#keep(this.#scrubbers.err.end());
    fsyncSync(this.#fd);
    closeSync(this.#fd);
    const digest = this.#hasher.digest("hex");
    const ref: ArtifactRef = { digest: `sha256:${digest}`, size: this.#size, type: "text/plain" };
    const path = artifactPath(this.#options.home, ref);
    renameSync(this.#temp, path);
    const dir = openSync(artifactDir(this.#options.home), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return { output: ref, tail: new TextDecoder().decode(this.#tail), truncated: this.#truncated };
  }

  /** Throws away what was captured: the command never got to its end. */
  discard(): void {
    try {
      closeSync(this.#fd);
    } catch {
      // Closed already.
    }
    rmSync(this.#temp, { force: true });
  }

  #keep(bytes: Buffer): void {
    if (bytes.length === 0) return;
    const { limit, tailBytes } = this.#options;
    const room = Math.max(0, limit - this.#size);
    const stored = bytes.subarray(0, room);
    if (stored.length < bytes.length) this.#truncated = true;
    if (stored.length > 0) {
      writeSync(this.#fd, stored);
      this.#hasher.update(stored);
      this.#size += stored.length;
    }
    this.#tail = Buffer.concat([this.#tail, bytes]);
    if (this.#tail.length > tailBytes) this.#tail = this.#tail.subarray(this.#tail.length - tailBytes);
  }
}
