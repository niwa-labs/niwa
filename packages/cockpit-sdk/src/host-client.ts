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
import { isStoredRecord, type RecordQuery, type StoredRecord } from "./records.ts";

/** The part of a Standard Schema the cockpit uses: its types. */
export type TypedSchema<In, Out> = {
  readonly "~standard": {
    readonly types?: { readonly input: In; readonly output: Out } | undefined;
  };
};

/**
 * A value as it travels in JSON: what `JSON.stringify` makes of it. A date is its text, a field
 * that is undefined or a function is absent.
 */
export type Wire<T> = T extends { toJSON(): infer J }
  ? J
  : T extends string | number | boolean | null
    ? T
    : T extends bigint | symbol | undefined | ((...args: never[]) => unknown)
      ? never
      : T extends readonly unknown[]
        ? { [K in keyof T]: Wire<T[K]> }
        : T extends object
          ? { [K in keyof T as [Wire<T[K]>] extends [never] ? never : K]: Wire<T[K]> }
          : T;

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
  /**
   * Call an action by reference: the input has the reference's type. The result is what the
   * host returned, as it travelled: the host has already applied the output schema, so it is
   * not applied again here, and a date arrives as its text.
   */
  call<I, O, In = I>(action: ActionRefLike<I, O, In>, input: NoInfer<In>, opts?: CallOptions): Promise<Wire<O>>;
  /** Call an action by name: nothing is known about its types. */
  call(action: string, input: unknown, opts?: CallOptions): Promise<unknown>;
  info(opts?: CallOptions & { action?: string }): Promise<HostInfo>;
  records: {
    /**
     * The records that answer a query and are committed now, after its `from` position, as many
     * as the server sends at once.
     */
    read(query?: RecordQuery, opts?: CallOptions): Promise<StoredRecord[]>;
    /**
     * The records that answer a query: history, then live, without a gap or a duplicate. A
     * broken connection is reopened with the same query after the last record received. Ends
     * only when the signal aborts, or when the server refuses the query for good.
     */
    since(query?: RecordQuery, opts?: FollowOptions): AsyncIterable<StoredRecord>;
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

/** The feed sent something that is not a record: it would send it again, so it is not retried. */
class FeedProtocolError extends HostCallError {}

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

/** The position of a query: a whole number from 0, as the server reads it. */
function positionOf(query: RecordQuery | undefined): number {
  const from = query?.from ?? 0;
  if (!Number.isSafeInteger(from) || from < 0) throw new TypeError(`the position of a record query is a whole number from 0, got ${String(from)}`);
  return from;
}

/** The address of a record route: the position, and the rest of the query as one JSON parameter. */
function recordsPath(route: string, after: number, query: RecordQuery | undefined): string {
  const { from: _from, ...rest } = query ?? {};
  const given = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  const params = new URLSearchParams({ after: String(after) });
  if (Object.keys(given).length > 0) params.set("query", JSON.stringify(given));
  return `${route}?${params.toString()}`;
}

/** A request the server refused for good: the same request would be refused again. */
function persistent(error: unknown): boolean {
  return error instanceof HostCallError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
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
    return response.json();
  }

  async function read(query?: RecordQuery, opts?: CallOptions): Promise<StoredRecord[]> {
    const response = await request(recordsPath("/api/history", positionOf(query), query), { signal: opts?.signal });
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new HostCallError(502, "the history is not a list of records");
    for (const record of body) {
      if (!isStoredRecord(record)) throw new HostCallError(502, "the history has a record that is not a stored record");
    }
    return body as StoredRecord[];
  }

  async function* since(query?: RecordQuery, opts?: FollowOptions): AsyncGenerator<StoredRecord, void, undefined> {
    const signal = opts?.signal;
    const aborted = (): boolean => signal?.aborted === true;
    let last = positionOf(query);
    let attempt = 0;
    while (!aborted()) {
      let broken: unknown = new HostCallError(502, "the record feed ended");
      try {
        const response = await request(recordsPath("/api/events", last, query), {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (response.body === null) throw new HostCallError(502, "the record feed has no body");
        opts?.onOpen?.();
        for await (const event of serverEvents(textChunks(response.body))) {
          let record: unknown;
          try {
            record = JSON.parse(event.data);
          } catch {
            record = undefined;
          }
          // Skipping a record would move the position past it for good: say so instead.
          if (!isStoredRecord(record)) {
            throw new FeedProtocolError(502, `the record feed sent something that is not a stored record after position ${last}`);
          }
          // A reopened feed resumes after `last`; anything at or before it was delivered already.
          if (record.seq <= last) continue;
          last = record.seq;
          attempt = 0;
          yield record;
        }
      } catch (error) {
        if (aborted()) return;
        // Not logged in, not allowed, a query the server refuses, or a feed that sends what is not a record:
        // retrying cannot help.
        if (persistent(error) || error instanceof FeedProtocolError) throw error;
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
      const response = await request(opts?.action ? "/api/info?action=" + encodeURIComponent(opts.action) : "/api/info", { signal: opts?.signal });
      const body: unknown = await response.json();
      if (body === null || typeof body !== "object" || !Array.isArray((body as { actions?: unknown }).actions)) {
        throw new HostCallError(502, "the host info has no list of actions");
      }
      return body as HostInfo;
    },
    records: { read, since },
  };
}
