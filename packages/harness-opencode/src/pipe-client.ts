import type { AgentProcess } from "@niwa-labs/sandbox";

import {
  MAX_ACTIVE_REQUESTS,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  PIPE_ORIGIN,
  RESPONSE_CHUNK_BYTES,
  encodeFrame,
  readFrames,
  writeFrame,
} from "./pipe-wire.ts";
import type { PipeCommand, PipeReply } from "./pipe-wire.ts";

interface Pending {
  resolve(response: Response): void;
  reject(error: unknown): void;
  detach(): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  requested: boolean;
}

export class OpenCodePipeUnsent extends Error {}

/** The SDK's fetch transport for one boxed OpenCode child. Responses advance one chunk per read. */
export class OpenCodePipe {
  private readonly started = Promise.withResolvers<void>();
  readonly ready = this.started.promise;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private isReady = false;
  private failure: unknown;

  constructor(private readonly child: Pick<AgentProcess, "stdin" | "stdout">, failed: (error: unknown) => void) {
    void this.read().catch((error: unknown) => {
      this.failure = error;
      this.started.reject(error);
      for (const id of this.pending.keys()) this.finish(id, error);
      failed(error);
    });
  }

  readonly fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    request.signal.throwIfAborted();
    if (url.origin !== PIPE_ORIGIN) throw new OpenCodePipeUnsent("Invalid OpenCode pipe origin");
    const body = await requestBody(request);
    request.signal.throwIfAborted();
    if (this.failure !== undefined || this.child.stdin.writableEnded || this.child.stdin.destroyed) {
      throw new OpenCodePipeUnsent("The OpenCode pipe is closed");
    }
    if (this.pending.size >= MAX_ACTIVE_REQUESTS) throw new OpenCodePipeUnsent("Too many OpenCode pipe requests");

    const id = ++this.nextId;
    let frame: Buffer;
    try {
      frame = encodeFrame({ kind: "request", id, method: request.method, path: url.pathname + url.search, headers: [...request.headers], body });
    } catch (error) {
      throw new OpenCodePipeUnsent("The OpenCode pipe request exceeded its size limit", { cause: error });
    }
    if (this.child.stdin.writableLength + frame.length > MAX_FRAME_BYTES) {
      throw new OpenCodePipeUnsent("The OpenCode pipe input buffer is full");
    }

    const response = Promise.withResolvers<Response>();
    const abort = () => this.cancel(id, request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    this.pending.set(id, {
      resolve: response.resolve,
      reject: response.reject,
      detach: () => request.signal.removeEventListener("abort", abort),
      requested: false,
    });
    // A broken pipe after writing starts leaves delivery uncertain.
    void writeFrame(this.child.stdin, frame).catch((error: unknown) => this.finish(id, error));
    return response.promise;
  }) as typeof fetch;

  private command(message: PipeCommand): Promise<void> {
    return writeFrame(this.child.stdin, encodeFrame(message));
  }

  private cancel(id: number, error?: unknown): void {
    if (!this.pending.has(id)) return;
    this.finish(id, error);
    if (!this.child.stdin.writableEnded) void this.command({ kind: "cancel", id }).catch(() => {});
  }

  private finish(id: number, error?: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.detach();
    if (error !== undefined) {
      pending.reject(error);
      pending.controller?.error(error);
    }
  }

  private async read(): Promise<void> {
    for await (const frame of readFrames<PipeReply>(this.child.stdout, true)) {
      if (frame.kind === "ready") {
        if (this.isReady) throw new Error("OpenCode pipe sent more than one readiness frame");
        this.isReady = true;
        this.started.resolve();
        continue;
      }
      const pending = this.pending.get(frame.id);
      if (pending === undefined) continue; // A canceled request can still have a response in flight.
      if (frame.kind === "headers") {
        if (pending.controller !== undefined) throw new Error("OpenCode pipe sent duplicate response headers");
        const body = frame.hasBody ? this.responseBody(frame.id, pending) : null;
        pending.resolve(new Response(body, { status: frame.status, statusText: frame.statusText, headers: frame.headers }));
        if (body === null) this.finish(frame.id);
      } else if (frame.kind === "chunk" || frame.kind === "end") {
        const controller = pending.controller;
        if (controller === undefined || !pending.requested) throw new Error("OpenCode pipe sent response data without a read");
        pending.requested = false;
        if (frame.kind === "end") {
          controller.close();
          this.finish(frame.id);
        } else {
          const chunk = Buffer.from(frame.base64, "base64");
          if (chunk.length > RESPONSE_CHUNK_BYTES) throw new Error("OpenCode pipe chunk exceeded its size limit");
          controller.enqueue(chunk);
        }
      } else if (frame.kind === "error") {
        this.finish(frame.id, new Error(frame.message));
      } else {
        throw new Error("Invalid OpenCode pipe reply");
      }
    }
    throw new Error("The OpenCode server closed its pipe");
  }

  private responseBody(id: number, pending: Pending): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: (controller) => { pending.controller = controller; },
      pull: () => {
        if (pending.requested) return;
        pending.requested = true;
        return this.command({ kind: "pull", id }).catch((error: unknown) => this.finish(id, error));
      },
      cancel: () => this.cancel(id),
    }, { highWaterMark: 0 });
  }
}

async function requestBody(request: Request): Promise<string | undefined> {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString("utf8");
      size += value.length;
      if (size > MAX_REQUEST_BYTES) {
        cancel();
        throw new OpenCodePipeUnsent("The OpenCode pipe request body exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
