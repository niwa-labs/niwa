/**
 * index.ts — the web surface: a thin client of the core.
 *
 * It keeps no list of its own: the feed is computed from the journal through the core's
 * observation API, and the actions are the ones the core describes. The caller is the web
 * connection: one core client, opened with the id "web", so the host sees that caller and
 * no other — and that caller speaks for the owner only when the instance is configured with
 * `speaksFor: "owner"`; then it holds the owner's token, and a request is let in only with the
 * cookie that the login link gives. Without that cookie a
 * request is refused with 401 and reaches nothing.
 * It listens on the loopback only and refuses a request that names another host or origin.
 *
 * The routes:
 *
 * - `GET /login?secret=` — the one-time link the server prints: it sets the cookie;
 * - `GET /` — the cockpit;
 * - `GET /api/info` — the available cockpit actions, journal field names, the harnesses with an agent action
 *   and the input schema of `session.start`;
 * - `GET /api/history?after=` — up to 128 records after a journal position;
 * - `GET /api/events?after=` — journal records over SSE, resuming from `Last-Event-ID` when present;
 * - `GET /api/source?seq=` — the verified script of a workflow start, for the owner;
 * - `POST /api/call` — call an allowed action with `{action, input}`;
 *
 * The feed and trace routes:
 *
 * - `GET /events` — the feed over SSE, so the page follows the journal;
 * - `GET /feed` — the feed as JSON;
 * - `GET /trace/:id` — the page of one record: what it depends on and what grew from it;
 * - `GET /trace-data/:id` — the chain as JSON;
 * - `POST /resolve` — answer a paused invocation;
 * - `POST /answer` — answer an open request.
 */

import { z } from "zod";

import { actionName, RESOLVE_ACTION, recordId, seq } from "@niwa-labs/core";
import { readOwnerToken, connect } from "@niwa-labs/client";
import type { ActionName, Description, SpeaksFor } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

import { followFeed, readFeed } from "./feed.ts";
import { LOGIN_PATH, WebLogin } from "./login.ts";
import { runSource } from "./source.ts";
import { chainOf } from "./trace.ts";
import type { Chain } from "./trace.ts";

export { feedOf } from "./feed.ts";
export type { Chain, ChainRecord } from "./trace.ts";

/**
 * The name the web surface gives itself. Whether it speaks for the owner is its token's matter:
 * with `speaksFor` the page answers a request addressed to the owner.
 */
export const WEB_CLIENT_ID = "web";

/** The action that answers an open request, when the requests module has declared it. */
const ANSWER_ACTION = "request.answer";

/** What the web surface needs. */
export interface WebOptions {
  /** The home of the running host: where the journal is. */
  readonly home: string;
  /** The port to listen on; 0 asks the system for a free one. */
  readonly port?: number;
  /**
   * Speak for the owner: the surface connects with the owner's token. Without it the surface is
   * a plain client, even if the owner's token file is readable.
   */
  readonly speaksFor?: SpeaksFor;
  /**
   * The actions only the owner's page may call, beyond the ones every page may call. The web surface
   * knows none by name: the composition that serves it (the umbrella) says which pages it carries.
   * Without `speaksFor: "owner"` they are neither listed nor called.
   */
  readonly ownerActions?: readonly OwnerAction[];
  /** The pages the surface serves. The web surface draws none itself: the composition that serves it brings them. */
  readonly pages: WebPages;
}

/** The two pages of the web surface: the feed at `/` and the trace of one record. */
export interface WebPages {
  feed(): string;
  trace(recordId: string, chain: Chain): string;
}

/** The part of an action reference the page needs: its name and its two schemas. */
export interface OwnerActionRef {
  readonly name: ActionName;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/** An action of the owner's page: the reference, and what the page checks around the call. */
export interface OwnerAction {
  readonly ref: OwnerActionRef;
  /** Refuse an input the schema alone does not: the answer is the reason, undefined when the input stands. */
  readonly refuse?: (input: Record<string, unknown>) => string | undefined;
  /** Shape what the action answered, before it is checked against the output schema. */
  readonly shape?: (answer: unknown) => Promise<unknown>;
}

/** What the page may call: the generic actions, and the owner's actions a composition added. */
interface Calls {
  readonly owner: ReadonlyMap<string, OwnerAction>;
  readonly body: z.ZodType<{ action: string; input: Record<string, unknown> }>;
  readonly names: ReadonlySet<string>;
}

/** A running web surface. */
export interface WebServer {
  readonly port: number;
  readonly url: string;
  /** The link that logs a browser in: it works once, and the server prints it when it starts. */
  readonly loginUrl: string;
  /** End every open stream, stop listening and close the core client. */
  close(): Promise<void>;
}

/** Run the web surface of one home. The host must already be running. */
export async function serveWeb(options: WebOptions): Promise<WebServer> {
  const token = options.speaksFor === undefined ? undefined : readOwnerToken(options.home);
  if (options.speaksFor !== undefined && token === undefined) {
    throw new Error(`the host of ${options.home} has not made the owner's token, so the web surface cannot speak for the owner`);
  }
  const api = await connect({ home: options.home, id: WEB_CLIENT_ID, ...(token === undefined ? {} : { token }) });
  const login = new WebLogin();
  const calls = callsOf(options.ownerActions ?? []);
  const streams = new Set<() => void>();
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 0,
      async fetch(request, listener) {
        try {
          const response = await route(api, login, streams, calls, options.pages, request, options.speaksFor === "owner");
          if (response.headers.get("content-type") === SSE_TYPE) listener.timeout(request, 0);
          return response;
        } catch (error) {
          return text(500, `the web surface failed: ${errorText(error)}`);
        }
      },
    });
  } catch (error) {
    await api.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port ?? 0}`,
    loginUrl: `http://127.0.0.1:${server.port ?? 0}${LOGIN_PATH}?secret=${login.secret}`,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const end of [...streams]) end();
        try {
          await server.stop(true);
        } finally {
          await api.close();
        }
      })();
      return closing;
    },
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The method each exact path takes. */
const METHODS: Readonly<Record<string, string>> = {
  [LOGIN_PATH]: "GET",
  "/": "GET",
  "/events": "GET",
  "/api/info": "GET",
  "/api/source": "GET",
  "/api/history": "GET",
  "/api/events": "GET",
  "/api/call": "POST",
  "/feed": "GET",
  "/resolve": "POST",
  "/answer": "POST",
};

/** The route of one request. */
async function route(
  api: NiwaApi,
  login: WebLogin,
  streams: Set<() => void>,
  calls: Calls,
  pages: WebPages,
  request: Request,
  speaksForOwner: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!LOCAL_HOSTS.has(url.hostname)) return text(403, "this host name is not served");
  if (path !== LOGIN_PATH && !login.allows(request.headers.get("cookie"))) {
    return text(401, "log in with the link the server printed when it started");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return text(403, "a request from another origin is refused");

  const tracePrefix = ["/trace/", "/trace-data/"].find((prefix) => path.startsWith(prefix));
  const allowed = tracePrefix === undefined ? METHODS[path] : "GET";
  if (allowed === undefined) return text(404, "there is no such page");
  if (request.method !== allowed) {
    return new Response("the method is not allowed here", {
      status: 405,
      headers: { allow: allowed, "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
    });
  }

  if (tracePrefix !== undefined) return trace(api, pages, path.slice(tracePrefix.length), tracePrefix === "/trace/");
  switch (path) {
    case LOGIN_PATH: {
      const cookie = login.exchange(url.searchParams.get("secret"));
      if (cookie === undefined) return text(401, "this login link is not valid, or it was used already");
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie, ...SECURITY_HEADERS } });
    }
    case "/":
      return html(pages.feed());
    case "/api/info":
      return cockpitInfo(api, calls, speaksForOwner);
    case "/api/source": {
      if (!speaksForOwner) return text(403, "The source is available to the owner only");
      const at = position(url.searchParams.get("seq") ?? "");
      if (at === undefined || at < 1) return text(400, "invalid position");
      const source = await runSource(api, at);
      return source === undefined ? text(404, "The file for this version is unavailable") : text(200, source);
    }
    case "/api/call":
      return post(request, calls.body, async ({ action, input }) => {
        try {
          const ownerAction = calls.owner.get(action);
          if (ownerAction !== undefined) {
            if (!speaksForOwner) return text(403, "The action is available to the owner only");
            const ref = ownerAction.ref;
            const schema = ref.input;
            if (!(schema instanceof z.ZodObject)) return text(502, "invalid cockpit action schema");
            const parsed = schema.strict().safeParse(input);
            if (!parsed.success) return text(400, "invalid cockpit action input");
            const refusal = ownerAction.refuse?.(input);
            if (refusal !== undefined) return text(400, refusal);
            const called = await api.call(ref.name, parsed.data);
            const result = ref.output.safeParse(ownerAction.shape === undefined ? called : await ownerAction.shape(called));
            return result.success ? json(200, result.data) : text(502, "invalid cockpit action response");
          }
          if (action === "session.list") {
            if (input.managedOnly !== true) return text(400, "session.list requires managedOnly: true");
            if (!hasInputField(await api.describe(), action, "managedOnly")) {
              return text(409, "the host does not support listing managed sessions");
            }
          }
          if (action === "session.read" && Object.hasOwn(input, "window")) {
            if (!hasInputField(await api.describe(), action, "window")) {
              return text(409, "the host does not support windowed session reads");
            }
          }
          return json(200, await api.call(actionName(action), input));
        } catch (error) {
          return text(409, errorText(error));
        }
      });
    case "/api/history":
    case "/api/events": {
      const lastEventId = path === "/api/events" ? request.headers.get("last-event-id") : null;
      const after = position(lastEventId ?? url.searchParams.get("after") ?? "0");
      if (after === undefined) return text(400, "invalid journal cursor");
      if (path === "/api/history") return json(200, await api.records.read(after, { limit: 128 }));
      return journalEvents(api, after, streams);
    }
    case "/events":
      return events(api, streams);
    case "/feed":
      return json(200, await readFeed(api));
    case "/resolve":
      return post(request, ResolveBody, async (body) => {
        try {
          await api.call(actionName(RESOLVE_ACTION), body);
          return json(200, { resolved: true });
        } catch (error) {
          return text(409, `the invocation was not answered: ${errorText(error)}`);
        }
      });
    default:
      return post(request, AnswerBody, async (body) => {
        try {
          // The page names the request it answers; the action wants the id of the request and the
          // answer itself. The verdict of the action is what the page is told: an answer to a
          // request that was over does not stand, and it says why.
          const raw = await api.call(actionName(ANSWER_ACTION), {
            id: body.request,
            answer: body.answer,
          });
          const verdict = AnswerVerdict.safeParse(raw);
          if (!verdict.success) {
            return text(502, "the answer of the host is not a verdict of the answer");
          }
          return json(200, {
            accepted: verdict.data.accepted,
            ...(verdict.data.reason === undefined ? {} : { reason: verdict.data.reason }),
          });
        } catch (error) {
          return text(409, `the request was not answered: ${errorText(error)}`);
        }
      });
  }
}

function position(value: string): ReturnType<typeof seq> | undefined {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) ? seq(number) : undefined;
}

/** The page of a record, or its chain as JSON; 400 for an id that is not one, 404 for no record. */
async function trace(api: NiwaApi, pages: WebPages, encoded: string, page: boolean): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(encoded);
    recordId(id);
  } catch {
    return text(400, "that is not a record id");
  }
  const chain = await chainOf(api, recordId(id));
  if (chain.root === null) return text(404, "there is no such record");
  return page ? html(pages.trace(id, chain)) : json(200, chain);
}

/**
 * The feed over SSE: the whole list is sent whenever it changes, and the page keeps no state of
 * its own. The subscription ends with the stream, whoever ends it.
 */
function events(api: NiwaApi, streams: Set<() => void>): Response {
  const encoder = new TextEncoder();
  let end = (_close = true): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const follower = followFeed(
        api,
        (entries) => {
          if (!ended) controller.enqueue(encoder.encode(`data: ${JSON.stringify(entries)}\n\n`));
        },
        () => end(),
      );
      end = (close = true) => {
        if (ended) return;
        ended = true;
        streams.delete(end);
        follower.stop();
        if (close) controller.close();
      };
      streams.add(end);
    },
    cancel() {
      end(false);
    },
  });
  return new Response(body, { headers: { "content-type": SSE_TYPE, ...SECURITY_HEADERS } });
}

/** The actions every page may call: not the owner's alone. */
const GENERIC_ACTIONS = [
  "message.get",
  "message.list",
  "message.send",
  "request.answer",
  "request.cancel",
  RESOLVE_ACTION,
  "workflow.cancel",
  "workflow.resume",
  "workflow.inspect",
  "session.list",
  "session.read",
  "session.interrupt",
  "session.resume",
  "session.send",
  "session.start",
  "task.create",
  "timer.list",
  "niwa.host.status",
  "niwa.host.stop",
] as const;

/** What a page may call, given the owner's actions the composition carries. */
function callsOf(ownerActions: readonly OwnerAction[]): Calls {
  const owner = new Map(ownerActions.map((entry) => [String(entry.ref.name), entry] as const));
  const all: [string, ...string[]] = [...GENERIC_ACTIONS, ...owner.keys()];
  return {
    owner,
    names: new Set(all),
    body: z.object({ action: z.enum(all), input: z.record(z.string(), z.unknown()) }),
  };
}

/** The host may load a subset of the plugins this page supports. */
async function cockpitInfo(api: NiwaApi, calls: Calls, speaksForOwner: boolean): Promise<Response> {
  const description = await api.describe();
  const actions = description.actions
    .map(({ name }) => name)
    .filter((name) => calls.names.has(name) && (speaksForOwner || !calls.owner.has(name)));
  const sessionWindow = hasInputField(description, "session.read", "window");
  const managedSessions = hasInputField(description, "session.list", "managedOnly");
  const recordFields = Object.fromEntries(
    description.types.map(({ name, schema }) => [name, schemaFields(schema.properties)]),
  );
  const sessionStart = description.actions.find(({ name }) => name === "session.start")?.input;
  return json(200, { actions, sessionWindow, managedSessions, recordFields, harnesses: agentHarnesses(description), sessionStart });
}

const AGENT_ACTION_PREFIX = "session.start.";

/** The harnesses the host serves an agent action for: the ids behind `session.start.<harness>`. */
function agentHarnesses(description: Description): string[] {
  return description.actions
    .map(({ name }) => String(name))
    .filter((name) => name.startsWith(AGENT_ACTION_PREFIX))
    .map((name) => name.slice(AGENT_ACTION_PREFIX.length))
    .sort();
}

function hasInputField(description: Description, action: string, field: string): boolean {
  const entry = description.actions.find(({ name }) => name === action);
  return schemaFields(entry?.input.properties).includes(field);
}

function schemaFields(properties: unknown): string[] {
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

const SSE_TYPE = "text/event-stream; charset=utf-8";

/** Each SSE id is a committed journal position. Reconnecting resumes after it. */
function journalEvents(api: NiwaApi, after: ReturnType<typeof seq>, streams: Set<() => void>): Response {
  const iterator = api.records.since(after)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let end = (_close = true): void => undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      end = (close = true) => {
        if (closed) return;
        closed = true;
        streams.delete(end);
        void iterator.return?.().catch(() => undefined);
        if (close) controller.close();
      };
      streams.add(end);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (closed) return;
        if (next.done) return end();
        const r = next.value;
        controller.enqueue(encoder.encode(`id: ${r.seq}\ndata: ${JSON.stringify(r)}\n\n`));
      } catch { end(); }
    },
    cancel() {
      end(false);
    },
  });
  return new Response(body, { headers: { "content-type": SSE_TYPE, ...SECURITY_HEADERS } });
}

const ResolveBody = z.object({
  invocation: z.string().min(1),
  choice: z.enum(["retry", "skip", "cancel"]),
  key: z.string().optional(),
});

const AnswerBody = z.object({
  request: z.string().min(1),
  answer: z.unknown().refine((value) => value !== undefined, "an answer is needed"),
});

/**
 * What the answer action answers with: whether the answer stands, and why it does not.
 *
 * The action is called by name, so its answer comes back untyped: it is checked here, and an
 * answer that does not have this shape is refused rather than passed on.
 */
const AnswerVerdict = z.object({
  accepted: z.boolean(),
  reason: z.enum(["cancelled", "expired"]).optional(),
});

/** The largest body a POST may have. */
const MAX_BODY_BYTES = 64 * 1024;

/** A POST: JSON, small, and shaped as `schema` says. The handler gets the parsed body. */
async function post<T>(
  request: Request,
  schema: z.ZodType<T>,
  handle: (body: T) => Promise<Response>,
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return text(415, "the body must be application/json");
  }
  const raw = await readBody(request);
  if (raw === undefined) return text(413, "the body is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return text(400, "the body is not JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return text(400, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return handle(parsed.data);
}

async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Headers for every response: no storage, no sniffing, no framing, only this origin's requests. */
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
} as const;

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
