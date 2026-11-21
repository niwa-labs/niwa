/**
 * The host as the cockpit sees it: call an action, read the journal, follow new records.
 *
 * In the browser the host is reached through the web server, so this is not the client of
 * `@niwa-labs/client` (that one talks to the host's socket) but the same operations over HTTP.
 * Action references are typed structurally, through the Standard Schema types their schemas
 * carry: a reference made with `actionRef` fits as it is, and nothing of the host's runtime is
 * imported into the page.
 */

import { serverEvents, textChunks } from "./sse.ts";
import type { StoredRecord } from "./records.ts";

type ValidationResult = { readonly value?: unknown; readonly issues?: ReadonlyArray<{ readonly message: string }> | undefined };

/** The part of a Standard Schema the cockpit uses: its types, and its validation when present. */
export type TypedSchema<In, Out> = {
  readonly "~standard": {
    readonly types?: { readonly input: In; readonly output: Out } | undefined;
    readonly validate?: ((value: unknown) => ValidationResult | Promise<ValidationResult>) | undefined;
  };
};

/** An action reference: its name and the schemas of its input and output. */
export type ActionRefLike<I, O, In = I> = {
  readonly name: string;
  readonly input: TypedSchema<In, I>;
  readonly output: TypedSchema<unknown, O>;
};

export type CallOptions = { signal?: AbortSignal | undefined };

export type FollowOptions = CallOptions & {
  /** The feed is open: told on the first connection and on every reconnection. */
  onOpen?: (() => void) | undefined;
  /** The feed broke and will be reopened. */
  onRetry?: ((error: unknown) => void) | undefined;
};

/** What the web server says about the host and about what this client may call. */
export type HostInfo = {
  /** The actions this client may call through the server. */
  actions: readonly string[];
  /** Any further facts the server reports. */
  [fact: string]: unknown;
};

export interface HostClient {
  /** Call an action by reference: the input and the result have the reference's types. */
  call<I, O, In = I>(action: ActionRefLike<I, O, In>, input: NoInfer<In>, opts?: CallOptions): Promise<O>;
  /** Call an action by name: nothing is known about its types. */
  call(action: string, input: unknown, opts?: CallOptions): Promise<unknown>;
  info(opts?: CallOptions): Promise<HostInfo>;
  records: {
    /** The records after a position that are committed now, as many as the server sends at once. */
    read(after: number, opts?: CallOptions): Promise<StoredRecord[]>;
    /**
     * The records after a position: history, then live, without a gap or a duplicate. A broken
     * connection is reopened after the last record received. Ends only when the signal aborts.
     */
    since(after: number, opts?: FollowOptions): AsyncIterable<StoredRecord>;
  };
}

/** A call the host or the web server refused or could not complete. */
export class HostCallError extends Error {
  override readonly name = "HostCallError";
  constructor(
    /** The HTTP status: 400 bad input, 401 not logged in, 403 not allowed, 409 refused by the host. */
    readonly status: number,
    message: string,
    /** The action, for a failed call. */
    readonly action?: string,
  ) {
    super(message);
  }
}

export type HttpHostClientOptions = {
  /** The origin and path prefix of the web server; the page's own origin by default. */
  base?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** How long to wait before reopening a broken record feed, by attempt. */
  retryDelay?: ((attempt: number) => number) | undefined;
};

function defaultRetryDelay(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(attempt, 6));
}

function isRecord(value: unknown): value is StoredRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.seq === "number" && typeof r.type === "string" && typeof r.stream === "string";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** The host through the web server's `/api` routes. */
export function httpHostClient(options: HttpHostClientOptions = {}): HostClient {
  const base = (options.base ?? "").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const retryDelay = options.retryDelay ?? defaultRetryDelay;

  async function request(path: string, init: RequestInit, action?: string): Promise<Response> {
    const response = await doFetch(`${base}${path}`, { credentials: "same-origin", ...init });
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).trim();
      throw new HostCallError(response.status, text === "" ? `HTTP ${response.status}` : text, action);
    }
    return response;
  }

  async function call(action: ActionRefLike<unknown, unknown> | string, input: unknown, opts?: CallOptions): Promise<unknown> {
    const name = typeof action === "string" ? action : action.name;
    const response = await request(
      "/api/call",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: name, input }),
        signal: opts?.signal,
      },
      name,
    );
    const body: unknown = await response.json();
    // A result is what the output schema makes of the wire value: dates, defaults, brands.
    const validate = typeof action === "string" ? undefined : action.output["~standard"].validate;
    if (validate === undefined) return body;
    const result = await validate(body);
    if (result.issues !== undefined) {
      throw new HostCallError(502, `the result of ${name} does not fit its schema: ${result.issues.map((i) => i.message).join("; ")}`, name);
    }
    return result.value;
  }

  async function read(after: number, opts?: CallOptions): Promise<StoredRecord[]> {
    const response = await request(`/api/history?after=${after}`, { signal: opts?.signal });
    const body: unknown = await response.json();
    if (!Array.isArray(body) || !body.every(isRecord)) throw new HostCallError(502, "the history is not a list of records");
    return body;
  }

  async function* since(after: number, opts?: FollowOptions): AsyncGenerator<StoredRecord, void, undefined> {
    const signal = opts?.signal;
    const aborted = (): boolean => signal?.aborted === true;
    let last = after;
    let attempt = 0;
    while (!aborted()) {
      let broken: unknown = new HostCallError(502, "the record feed ended");
      try {
        const response = await request(`/api/events?after=${last}`, {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (response.body === null) throw new HostCallError(502, "the record feed has no body");
        opts?.onOpen?.();
        attempt = 0;
        for await (const event of serverEvents(textChunks(response.body))) {
          const record: unknown = JSON.parse(event.data);
          if (!isRecord(record)) continue;
          // A reopened feed resumes after `last`; anything at or before it was delivered already.
          if (record.seq <= last) continue;
          last = record.seq;
          attempt = 0;
          yield record;
        }
      } catch (error) {
        if (aborted()) return;
        // Not logged in or not allowed: retrying cannot help.
        if (error instanceof HostCallError && (error.status === 401 || error.status === 403)) throw error;
        broken = error;
      }
      if (aborted()) return;
      opts?.onRetry?.(broken);
      await sleep(retryDelay(attempt), signal);
      attempt += 1;
    }
  }

  return {
    call: call as HostClient["call"],
    info: async (opts) => {
      const response = await request("/api/info", { signal: opts?.signal });
      const body: unknown = await response.json();
      if (body === null || typeof body !== "object" || !Array.isArray((body as { actions?: unknown }).actions)) {
        throw new HostCallError(502, "the host info has no list of actions");
      }
      return body as HostInfo;
    },
    records: { read, since },
  };
}
