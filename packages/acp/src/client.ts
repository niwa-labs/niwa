/**
 * The client side of an ACP connection: JSON-RPC 2.0 over the lines of a child's stdio.
 *
 * One demux over the lines the agent writes, a monotonic request id, the calls in flight by that
 * id with a timeout each, and every call settled when the connection closes. A request the agent
 * makes of the client and a notification are handed to the dialect that owns the connection; the
 * client only frames, matches and settles.
 *
 * A call that fails says how far it got (`Dispatch`): never written, refused by the agent, or
 * written and never answered. Only the last may have done what it asked. The transport says what
 * became of each line it was given (`Written`), and the client believes it.
 */

import type { Dispatch } from "@niwa-labs/harness";

/**
 * The id of a request: a number or a string, and `null` where a snapshot of the protocol allows
 * it. A request has an id when the member is present, whatever its value.
 */
export type RequestId = number | string | null;

/** One JSON-RPC message, either way: what is present says which it is. */
export interface RpcFrame {
  readonly jsonrpc?: string;
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

/** A request the agent makes of the client: it must be answered, or the agent waits forever. */
export type AgentRequest = RpcFrame & { readonly id: RequestId; readonly method: string };

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

/**
 * What became of a line given to the transport: taken (`accepted`), certainly not written
 * (`unsent`: the process is gone, its stdin closed), or not known (`unknown`: the write may have
 * partly happened). A write that throws is `unknown`.
 */
export type Written = "accepted" | "unsent" | "unknown";

export interface AcpClientOptions {
  /** Write one line to the agent, and say what became of it. */
  readonly write: (line: string) => Written;
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

/** What an answer says: its result, or the error it carries; why it is neither, when it is not well formed. */
function answerOf(frame: RpcFrame): RpcOutcome | string {
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (hasResult === hasError) return "an answer holds exactly one of a result and an error";
  if (hasResult) return { ok: true, result: frame.result };
  const error: unknown = frame.error;
  if (typeof error !== "object" || error === null) return "the error of an answer is not an object";
  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof code !== "number" || typeof message !== "string") {
    return "the error of an answer has no numeric code and string message";
  }
  return { ok: false, error: message, code, dispatch: "refused" };
}

function isRequestId(id: unknown): id is RequestId {
  return id === null || typeof id === "number" || typeof id === "string";
}

/** A failure to write, as its reason. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #pending = new Map<number, (outcome: RpcOutcome) => void>();
  #nextId = 1;
  /** The start of a line whose end has not come yet, and its length in bytes. */
  #fragment = "";
  #fragmentBytes = 0;
  #overflowed = false;
  #closed: string | undefined;

  constructor(options: AcpClientOptions) {
    this.#options = options;
  }

  /** How many calls wait for their answer. */
  get waiting(): number {
    return this.#pending.size;
  }

  /**
   * A chunk of the agent's stdout: each whole line is read as it completes.
   *
   * A line longer than the budget is the transport failing, and it is so however its chunks were
   * cut: the length of a line is measured in bytes before the line is read, whether it ends in this
   * chunk or is still growing. After an overflow nothing more is read.
   */
  feed(chunk: string): void {
    const limit = this.#options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    let start = 0;
    while (!this.#overflowed) {
      const newline = chunk.indexOf("\n", start);
      const piece = newline === -1 ? chunk.slice(start) : chunk.slice(start, newline);
      const bytes = this.#fragmentBytes + Buffer.byteLength(piece, "utf8");
      if (bytes > limit) {
        this.#overflowed = true;
        this.#fragment = "";
        this.#fragmentBytes = 0;
        this.#options.onOverflow();
        return;
      }
      if (newline === -1) {
        this.#fragment += piece;
        this.#fragmentBytes = bytes;
        return;
      }
      const line = this.#fragment + piece;
      this.#fragment = "";
      this.#fragmentBytes = 0;
      this.receive(line.trim());
      start = newline + 1;
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
    if (frame.method !== undefined && typeof frame.method !== "string") {
      this.#options.onUnreadable(line, new Error("the method of the frame is not a string"));
      return;
    }
    // What is present says what a frame is, not what its values are: an id of `null` is still an id.
    const hasId = Object.hasOwn(frame, "id");
    if (frame.method !== undefined && hasId) {
      if (!isRequestId(frame.id)) {
        this.#options.onUnreadable(line, new Error("the id of the request is neither a number, a string nor null"));
        return;
      }
      this.#options.onRequest(frame as AgentRequest);
      return;
    }
    if (frame.method === undefined && hasId) {
      // Our ids are numbers: an answer is of the call whose id it repeats, and no other.
      if (typeof frame.id !== "number") return;
      const settle = this.#pending.get(frame.id);
      if (settle === undefined) return;
      // The answer is checked before the call is given up: a malformed one settles nothing.
      const answer = answerOf(frame);
      if (typeof answer === "string") {
        this.#options.onUnreadable(line, new Error(answer));
        return;
      }
      this.#pending.delete(frame.id);
      settle(answer);
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
    // The line is made before the call is registered: a request that cannot be serialized never
    // reached the transport.
    let line: string;
    try {
      line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      settle({ ok: false, error: reasonOf(error), dispatch: "unsent" });
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
    const finish = (outcome: RpcOutcome): void => {
      clearTimeout(timer);
      clearTimeout(grace);
      settle(late ? timedOut : outcome);
    };
    this.#pending.set(id, finish);
    let written: Written | Error;
    try {
      written = this.#options.write(line);
    } catch (error) {
      written = error instanceof Error ? error : new Error(String(error));
    }
    if (written === "unsent") {
      this.#pending.delete(id);
      finish({ ok: false, error: "the request was not written", dispatch: "unsent" });
    } else if (written instanceof Error) {
      // It is not known whether the request left, and nothing says an answer will come.
      this.#pending.delete(id);
      finish({ ok: false, error: written.message, dispatch: "uncertain" });
    }
    return id;
  }

  /** `send`, as a promise of the outcome. */
  request(method: string, params: unknown, options: CallOptions = {}): Promise<RpcOutcome> {
    return new Promise<RpcOutcome>((resolve) => {
      this.send(method, params, resolve, options);
    });
  }

  /** A notification: no id, no answer. It says what became of the line. */
  notify(method: string, params: unknown = {}): Written {
    return this.#write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** The answer to a request of the agent. */
  reply(id: RequestId, result: unknown): Written {
    return this.#write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  /** The refusal of a request of the agent, so it never waits on the client. */
  refuse(id: RequestId, code: number, message: string): Written {
    return this.#write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** A line to the transport: one that throws left it unknown what became of the line. */
  #write(line: string): Written {
    try {
      return this.#options.write(line);
    } catch {
      return "unknown";
    }
  }

  /** The connection is gone: every call in flight fails with `reason`, and a later one is never written. */
  close(reason: string): void {
    if (this.#closed === undefined) this.#closed = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const settle of pending) settle({ ok: false, error: reason, dispatch: "uncertain" });
  }
}
