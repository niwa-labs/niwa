/**
 * The client side of an ACP connection: JSON-RPC 2.0 over the lines of a child's stdio.
 *
 * One demux over the lines the agent writes, a monotonic request id, the calls in flight by that
 * id with a timeout each, and every call settled when the connection closes. A request the agent
 * makes of the client and a notification are handed to the dialect that owns the connection; the
 * client only frames, matches and settles.
 *
 * A call that fails says how far it got (`Dispatch`): never written, refused by the agent, or
 * written and never answered. Only the last may have done what it asked.
 */

import type { Dispatch } from "@niwa-labs/harness";

/** One JSON-RPC message, either way: what is present says which it is. */
export interface RpcFrame {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

/** A request the agent makes of the client: it must be answered, or the agent waits forever. */
export type AgentRequest = RpcFrame & { readonly id: number | string; readonly method: string };

/** A notification of the agent. */
export type AgentNotification = RpcFrame & { readonly method: string };

/** What became of a call. */
export type RpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      /** The code of the agent's refusal, when it refused. */
      readonly code?: number;
      readonly dispatch: Dispatch;
      /** The answer did not come in time. */
      readonly timedOut?: true;
    };

/** How a call waits for its answer. */
export interface CallOptions {
  /** How long the answer may take; `null` waits until the connection closes. The client's own when absent. */
  readonly timeoutMs?: number | null;
  /**
   * Run when the call is over its time, instead of giving it up at once (a cancel of the work):
   * the call then waits one more timeout for the agent to answer, and fails with the timeout
   * either way, so a cancelled answer is never taken for a success.
   */
  readonly overdue?: () => void;
}

export interface AcpClientOptions {
  /** Write one line to the agent; it throws when the agent cannot be written to. */
  readonly write: (line: string) => void;
  readonly onRequest: (request: AgentRequest) => void;
  readonly onNotification: (notification: AgentNotification) => void;
  /** A line that is not JSON: never a crash. */
  readonly onUnreadable: (line: string, error: unknown) => void;
  /** A line longer than the frame budget: the transport has failed. */
  readonly onOverflow: () => void;
  /** How long a call waits for its answer by default. */
  readonly callTimeoutMs: number;
  /** The most bytes one line may hold. */
  readonly maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** A failure to write, as its reason. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #pending = new Map<number, (outcome: RpcOutcome) => void>();
  #nextId = 1;
  #buffer = "";
  #closed: string | undefined;

  constructor(options: AcpClientOptions) {
    this.#options = options;
  }

  /** How many calls wait for their answer. */
  get waiting(): number {
    return this.#pending.size;
  }

  /** A chunk of the agent's stdout: each whole line is read as it completes. */
  feed(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      this.receive(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > (this.#options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      this.#buffer = "";
      this.#options.onOverflow();
    }
  }

  /**
   * One line of the agent: a response settles exactly one call, a request and a notification go to
   * the dialect. A frame that is not JSON-RPC 2.0 is not one of ours.
   */
  receive(line: string): void {
    if (line.length === 0) return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch (error) {
      this.#options.onUnreadable(line, error);
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      this.#options.onUnreadable(line, new Error("the line is not a JSON-RPC frame"));
      return;
    }
    if (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") return;
    const hasId = frame.id !== undefined && frame.id !== null;
    if (frame.method !== undefined && hasId) {
      this.#options.onRequest(frame as AgentRequest);
      return;
    }
    if (frame.method === undefined && hasId) {
      const settle = this.#pending.get(Number(frame.id));
      if (settle === undefined) return;
      this.#pending.delete(Number(frame.id));
      if (frame.error !== undefined) {
        const code = frame.error.code;
        settle({
          ok: false,
          error: frame.error.message ?? `the agent refused the request with code ${String(code ?? "?")}`,
          ...(code === undefined ? {} : { code }),
          dispatch: "refused",
        });
      } else {
        settle({ ok: true, result: frame.result });
      }
      return;
    }
    if (frame.method !== undefined) this.#options.onNotification(frame as AgentNotification);
  }

  /**
   * Send a request; `settle` is told what became of it, in the same turn of the event loop as the
   * line that answered it. The wait is registered before the request is written, so an answer read
   * in the same chunk as the write is never missed.
   */
  send(method: string, params: unknown, settle: (outcome: RpcOutcome) => void, options: CallOptions = {}): number {
    const id = this.#nextId;
    this.#nextId += 1;
    if (this.#closed !== undefined) {
      settle({ ok: false, error: this.#closed, dispatch: "unsent" });
      return id;
    }
    const timeoutMs = options.timeoutMs === undefined ? this.#options.callTimeoutMs : options.timeoutMs;
    const timedOut: RpcOutcome = { ok: false, error: `the call ${method} timed out`, dispatch: "uncertain", timedOut: true };
    let late = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        if (options.overdue === undefined) {
          this.#pending.delete(id);
          settle(timedOut);
          return;
        }
        late = true;
        try {
          options.overdue();
        } catch {
          // The agent is gone: there is nothing to cancel.
        }
        grace = setTimeout(() => {
          if (this.#pending.delete(id)) settle(timedOut);
        }, timeoutMs);
        grace.unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
    this.#pending.set(id, (outcome) => {
      clearTimeout(timer);
      clearTimeout(grace);
      settle(late ? timedOut : outcome);
    });
    try {
      this.#options.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      settle({ ok: false, error: reasonOf(error), dispatch: "unsent" });
    }
    return id;
  }

  /** `send`, as a promise of the outcome. */
  request(method: string, params: unknown, options: CallOptions = {}): Promise<RpcOutcome> {
    return new Promise<RpcOutcome>((resolve) => {
      this.send(method, params, resolve, options);
    });
  }

  /** A notification: no id, no answer. It throws when the agent cannot be written to. */
  notify(method: string, params: unknown = {}): void {
    this.#options.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** The answer to a request of the agent. */
  reply(id: number | string, result: unknown): void {
    this.#options.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  /** The refusal of a request of the agent, so it never waits on the client. */
  refuse(id: number | string, code: number, message: string): void {
    this.#options.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** The connection is gone: every call in flight fails with `reason`, and a later one is never written. */
  close(reason: string): void {
    if (this.#closed === undefined) this.#closed = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const settle of pending) settle({ ok: false, error: reason, dispatch: "uncertain" });
  }
}
