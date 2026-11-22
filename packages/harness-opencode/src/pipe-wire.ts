import type { Readable, Writable } from "node:stream";

export const OPENCODE_RUNTIME_VERSION = "2.3.2";
export const PIPE_ORIGIN = "http://opencode.niwa.invalid";
export const PROXY_CLOSE_ENV = "NIWA_OPENCODE_NONO_HTTP_CLOSE";
export const PIPE_PREFIX = "@niwa-opencode/1 ";
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const RESPONSE_CHUNK_BYTES = 24 * 1024;
export const MAX_ACTIVE_REQUESTS = 32;

export type PipeCommand =
  | { kind: "request"; id: number; method: string; path: string; headers: [string, string][]; body: string | undefined }
  | { kind: "pull" | "cancel"; id: number };

export type PipeReply =
  | { kind: "ready" }
  | { kind: "headers"; id: number; status: number; statusText: string; headers: [string, string][]; hasBody: boolean }
  | { kind: "chunk"; id: number; base64: string }
  | { kind: "end"; id: number }
  | { kind: "error"; id: number; message: string };

/** Reads framed messages from an inherited stream. Vendor stdout logging can share the reply stream. */
export async function* readFrames<T>(source: Readable, ignoreOtherOutput = false): AsyncGenerator<T> {
  let parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      add(chunk.subarray(start, end));
      const line = Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      start = end + 1;
      if (line.startsWith(PIPE_PREFIX)) yield JSON.parse(line.slice(PIPE_PREFIX.length)) as T;
      else if (!ignoreOtherOutput) throw new Error("Invalid OpenCode pipe frame");
    }
    add(chunk.subarray(start));
  }
  if (size !== 0) throw new Error("OpenCode pipe closed during a frame");

  function add(part: Buffer): void {
    if (part.length === 0) return;
    size += part.length;
    if (size > MAX_FRAME_BYTES) throw new Error("OpenCode pipe frame exceeded its size limit");
    parts.push(part);
  }
}

export function encodeFrame(frame: PipeCommand | PipeReply): Buffer {
  const encoded = Buffer.from(`${PIPE_PREFIX}${JSON.stringify(frame)}\n`);
  if (encoded.length > MAX_FRAME_BYTES) throw new Error("OpenCode pipe frame exceeded its size limit");
  return encoded;
}

export function writeFrame(destination: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    destination.write(frame, (error) => error == null ? resolve() : reject(error));
  });
}
