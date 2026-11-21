/**
 * Command output as an artifact of the host: bytes kept whole under the digest of their content.
 *
 * The output of a command goes to a writer of the host's artifact store as it arrives, and is made
 * durable and named when the command is over, so a record that points at it never points at one a
 * crash could take. The same bytes are the same artifact.
 *
 * Known secret values are replaced before a byte is written, and before it is kept in the tail:
 * a secret that straddles two chunks is still found, because the end of a chunk is held back until
 * the next one shows it cannot start a secret. The chunks of the two streams keep the order they came in.
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

/** The most bytes a stream's held-back end may keep the other stream waiting for. */
const HELD_LIMIT = 256 * 1024;

type Stream = "out" | "err";

/** A chunk as it came, waiting for what is held back before it to be settled. */
interface Piece {
  readonly stream: Stream;
  readonly bytes: Buffer;
}

/**
 * Where a known secret lies in `bytes`: the spans, merged and in order. `carry` bytes at the start
 * are the rest of a secret whose beginning was already written as its replacement.
 */
function spansOf(secrets: readonly Buffer[], bytes: Buffer, carry: number): Array<[number, number]> {
  const found: Array<[number, number]> = carry > 0 ? [[-1, carry]] : [];
  for (const secret of secrets) {
    for (let at = bytes.indexOf(secret); at !== -1; at = bytes.indexOf(secret, at + 1)) found.push([at, at + secret.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * One command's output, from the first byte to the artifact.
 *
 * With no secret to hold back, a chunk is kept as it comes. With one, each stream is read for
 * secrets on its own, so one that a stream split across chunks is found even when the other
 * stream spoke in between, and the chunks are written in the order they came: a chunk waits
 * behind the end of an earlier one only while that end could still be the start of a secret.
 * What is written then goes through one more scrubber, so a secret the two streams make
 * together, where one ends and the other begins, is found too.
 */
export class OutputCapture {
  readonly #options: CaptureOptions;
  readonly #secrets: readonly Buffer[];
  readonly #hold: number;
  readonly #merged: Scrubber;
  readonly #writer: ArtifactWriter;
  #queue: Piece[] = [];
  readonly #scan: Record<Stream, Buffer> = { out: Buffer.alloc(0), err: Buffer.alloc(0) };
  readonly #carry: Record<Stream, number> = { out: 0, err: 0 };
  #size = 0;
  #truncated = false;
  #tail: Buffer = Buffer.alloc(0);

  constructor(options: CaptureOptions) {
    this.#options = options;
    this.#secrets = options.secrets.filter((value) => value.length > 0).map((value) => Buffer.from(value));
    this.#hold = Math.max(0, ...this.#secrets.map((value) => value.length - 1));
    this.#merged = new Scrubber(options.secrets);
    this.#writer = options.artifacts.writer("text/plain");
  }

  /** The bytes waiting behind a held-back end. */
  get queued(): number {
    return this.#scan.out.length + this.#scan.err.length;
  }

  /** Takes a chunk of one of the two streams, in the order it came. */
  feed(stream: Stream, chunk: Uint8Array): void {
    if (this.#secrets.length === 0) {
      this.#keep(Buffer.from(chunk));
      return;
    }
    const bytes = Buffer.from(chunk);
    this.#queue.push({ stream, bytes });
    this.#scan[stream] = Buffer.concat([this.#scan[stream], bytes]);
    // A stream that stays silent while holding the start of a secret must not make the other
    // one pile up in memory: past the limit the held-back ends are let go. A secret that was
    // split there is then written in two parts, and is replaced only if they end up together.
    this.#release(this.queued > HELD_LIMIT);
  }

  /** Flushes what is held back, makes the artifact durable and gives its name. */
  finish(): Captured {
    this.#release(true);
    this.#keep(this.#merged.end());
    return { output: this.#writer.finish(), tail: new TextDecoder().decode(this.#tail), truncated: this.#truncated };
  }

  /** Throws away what was captured: the command never got to its end. */
  discard(): void {
    this.#writer.discard();
  }

  /** Writes the chunks, front first, whose bytes are settled: no secret can still start in them. */
  #release(everything: boolean): void {
    const state = {} as Record<Stream, { spans: Array<[number, number]>; limit: number; offset: number }>;
    for (const stream of ["out", "err"] as const) {
      const scan = this.#scan[stream];
      state[stream] = {
        spans: spansOf(this.#secrets, scan, this.#carry[stream]),
        limit: everything ? scan.length : Math.max(0, scan.length - this.#hold),
        offset: 0,
      };
    }
    const settled: Buffer[] = [];
    let taken = 0;
    for (const piece of this.#queue) {
      const at = state[piece.stream];
      const start = at.offset;
      const end = start + piece.bytes.length;
      if (end > at.limit) break;
      const scan = this.#scan[piece.stream];
      let cursor = start;
      for (const span of at.spans) {
        if (span[1] <= start) continue;
        if (span[0] >= end) break;
        const from = Math.max(span[0], start);
        if (cursor < from) settled.push(scan.subarray(cursor, from));
        if (span[0] >= start) settled.push(REDACTED);
        cursor = Math.min(span[1], end);
      }
      if (cursor < end) settled.push(scan.subarray(cursor, end));
      at.offset = end;
      taken += 1;
    }
    this.#queue = this.#queue.slice(taken);
    for (const stream of ["out", "err"] as const) {
      const { spans, offset } = state[stream];
      // The rest of a secret whose replacement was just written is dropped when its bytes come.
      this.#carry[stream] = Math.max(0, ...spans.filter((span) => span[0] < offset).map((span) => span[1] - offset));
      this.#scan[stream] = this.#scan[stream].subarray(offset);
    }
    if (settled.length > 0) this.#keep(this.#merged.push(Buffer.concat(settled)));
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
