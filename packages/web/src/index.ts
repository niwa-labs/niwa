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
 * What a page may call is not a list kept here: a call goes to the host as it is, and the grant of the connection decides
 * it. A call the grant refuses is answered 403.
 *
 * The routes:
 *
 * - `GET /login?secret=` — the one-time link the server prints: it sets the cookie;
 * - `GET /` — the cockpit app, when the surface is given one, else the page of the composition;
 * - `GET /assets/…`, `GET /modules/<id>/<hash>/…` — the app's files, and the client modules of the plugins, built for the
 *   browser from the source the host lists; every other address of the app is the app's page, which routes it;
 * - `GET /api/viewer` — who is looking: the principal and the actions its grant lets it call;
 * - `GET /api/catalogue` — the client modules the host lists, with the addresses they are served at;
 * - `GET /api/info` — the actions the viewer may call, the position of the journal, journal field names, the harnesses
 *   with an agent action and the input schema of `session.start`;
 * - `GET /api/history?after=` — up to 128 records after a journal position;
 * - `GET /api/events?after=` — journal records over SSE from a position (the journal's end is `seq` of `/api/info`),
 *   resuming from `Last-Event-ID` when present;
 * - `GET /api/source?seq=` — the verified script of a workflow start, for the owner;
 * - `POST /api/call` — call an action with `{action, input}`;
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
import { readOwnerToken, connect, HostError, RECORDS_READ_ACTION } from "@niwa-labs/client";
import type { ActionName, Description, SpeaksFor } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

import { ASSETS_PREFIX, assetFile, catalogueOf, MODULES_PREFIX, ModuleBuilds, pageOf, typeOf } from "./app.ts";
import type { WebApp } from "./app.ts";
import { followFeed, readFeed } from "./feed.ts";
import { viewerOf } from "./viewer.ts";
import { LOGIN_PATH, WebLogin } from "./login.ts";
import { runSource } from "./source.ts";
import { chainOf } from "./trace.ts";
import type { Chain } from "./trace.ts";

export { feedOf } from "./feed.ts";
export type { WebApp } from "./app.ts";
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
   * Actions with a check of their own: an input the schema alone does not refuse, an answer that is shaped before it is
   * read. The web surface knows none by name: the composition that serves it (the umbrella) says which pages it carries.
   * Whether a page may call them is the grant's matter, as for every action.
   */
  readonly ownerActions?: readonly OwnerAction[];
  /** The pages the surface serves. The web surface draws none itself: the composition that serves it brings them. */
  readonly pages: WebPages;
  /**
   * The cockpit app: its built files and the modules its client modules share. With it `/` is the app and the addresses of
   * the app are its page; without it the surface serves only the pages above and the API.
   */
  readonly app?: WebApp;
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

/** How a page calls: the checks some actions carry, and the shape of the body. The grant decides the rest. */
interface Calls {
  readonly hooks: ReadonlyMap<string, OwnerAction>;
  readonly body: z.ZodType<{ action: string; input: Record<string, unknown> }>;
}

/** What a route needs beyond the request: the host, the login, the open streams and what the surface serves. */
interface Context {
  readonly api: NiwaApi;
  readonly login: WebLogin;
  readonly streams: Set<() => void>;
  readonly calls: Calls;
  readonly pages: WebPages;
  readonly app: WebApp | undefined;
  readonly builds: ModuleBuilds;
  readonly speaksForOwner: boolean;
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
  const context: Context = {
    api,
    login: new WebLogin(),
    streams: new Set<() => void>(),
    calls: callsOf(options.ownerActions ?? []),
    pages: options.pages,
    app: options.app,
    builds: new ModuleBuilds(),
    speaksForOwner: options.speaksFor === "owner",
  };
  const { login, streams } = context;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 0,
      async fetch(request, listener) {
        try {
          const response = await route(context, request);
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
  "/api/viewer": "GET",
  "/api/catalogue": "GET",
  "/api/source": "GET",
  "/api/history": "GET",
  "/api/events": "GET",
  "/api/call": "POST",
  "/feed": "GET",
  "/resolve": "POST",
  "/answer": "POST",
};

/** The route of one request. */
async function route(context: Context, request: Request): Promise<Response> {
  const { api, login, streams, calls, pages, app, speaksForOwner } = context;
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
  if (allowed === undefined) {
    if (app === undefined || path.startsWith("/api/")) return text(404, "there is no such page");
    // An address of the app: its files, the client modules, or a page the app routes itself.
    if (request.method !== "GET") return methodNotAllowed("GET");
    return appResponse(context, app, path);
  }
  if (request.method !== allowed) return methodNotAllowed(allowed);

  if (tracePrefix !== undefined) return trace(api, pages, path.slice(tracePrefix.length), tracePrefix === "/trace/");
  switch (path) {
    case LOGIN_PATH: {
      const cookie = login.exchange(url.searchParams.get("secret"));
      if (cookie === undefined) return text(401, "this login link is not valid, or it was used already");
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie, ...SECURITY_HEADERS } });
    }
    case "/":
      return app === undefined ? html(pages.feed()) : appPage(app);
    case "/api/viewer":
      return json(200, await viewerOf(api, WEB_CLIENT_ID));
    case "/api/catalogue":
      return json(200, await catalogueOf(api));
    case "/api/info":
      return cockpitInfo(api);
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
          const hooked = calls.hooks.get(action);
          if (hooked !== undefined) {
            const ref = hooked.ref;
            const schema = ref.input;
            if (!(schema instanceof z.ZodObject)) return text(502, "invalid cockpit action schema");
            const parsed = schema.strict().safeParse(input);
            if (!parsed.success) return text(400, "invalid cockpit action input");
            const refusal = hooked.refuse?.(input);
            if (refusal !== undefined) return text(400, refusal);
            const called = await api.call(ref.name, parsed.data);
            const result = ref.output.safeParse(hooked.shape === undefined ? called : await hooked.shape(called));
            return result.success ? json(200, result.data) : text(502, "invalid cockpit action response");
          }
          return json(200, await api.call(actionName(action), input));
        } catch (error) {
          // The grant of this connection decided the call: say so, so a page can tell a refusal from a failure.
          if (error instanceof HostError && error.denied !== undefined) return text(403, errorText(error));
          return text(409, errorText(error));
        }
      });
    case "/api/history":
    case "/api/events": {
      const lastEventId = path === "/api/events" ? request.headers.get("last-event-id") : null;
      const after = position(lastEventId ?? url.searchParams.get("after") ?? "0");
      if (after === undefined) return text(400, "invalid journal cursor");
      if (path === "/api/history") return json(200, await api.records.read({ from: after, limit: 128 }));
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

/** What a page may call: whatever the grant of the connection lets through, with the checks the composition added. */
function callsOf(hooks: readonly OwnerAction[]): Calls {
  return {
    hooks: new Map(hooks.map((entry) => [String(entry.ref.name), entry] as const)),
    body: z.object({
      action: z.string().min(1).refine(isActionName, "that is not an action name"),
      input: z.record(z.string(), z.unknown()),
    }),
  };
}

function isActionName(name: string): boolean {
  try {
    actionName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the page needs to know of the host: the actions the viewer may call, the position of the journal's end (where a feed
 * that wants the latest records starts), and the facts of the host the pages read. The host may load a subset of the
 * plugins this page supports.
 */
async function cockpitInfo(api: NiwaApi): Promise<Response> {
  const description = await api.describe();
  const { actions } = await viewerOf(api, WEB_CLIENT_ID);
  const recordFields = Object.fromEntries(
    description.types.map(({ name, schema }) => [name, schemaFields(schema.properties)]),
  );
  const sessionStart = description.actions.find(({ name }) => name === "session.start")?.input;
  return json(200, { actions, seq: await journalEnd(api), recordFields, harnesses: agentHarnesses(description), sessionStart });
}

/** The position of the last record the connection may read: 0 when it may read none. */
async function journalEnd(api: NiwaApi): Promise<number> {
  try {
    const read = await api.call(RECORDS_READ_ACTION, { tail: 1 });
    const next = (read as { next?: unknown }).next;
    return typeof next === "number" ? next : 0;
  } catch (error) {
    if (error instanceof HostError && error.denied !== undefined) return 0;
    throw error;
  }
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

function schemaFields(properties: unknown): string[] {
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

const SSE_TYPE = "text/event-stream; charset=utf-8";

/** Each SSE id is a committed journal position. Reconnecting resumes after it. */
function journalEvents(api: NiwaApi, after: ReturnType<typeof seq>, streams: Set<() => void>): Response {
  const iterator = api.records.since({ from: after })[Symbol.asyncIterator]();
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

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

/**
 * The policy of the app and of everything else the surface answers: scripts only from this origin (the app's own and the
 * client modules, as modules), inline styles because components set style attributes, requests only to this origin.
 */
function appPolicy(inlineScript?: string): string {
  const scripts = inlineScript === undefined ? "'self'" : `'self' ${inlineScript}`;
  return `default-src 'none'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** Headers for every response: no storage, no sniffing, no framing, only this origin's requests. */
const SECURITY_HEADERS = { ...BASE_HEADERS, "content-security-policy": appPolicy() } as const;

/** The pages a composition brings carry their own inline script: they are the one thing that may. */
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
} as const;

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS },
  });
}

function methodNotAllowed(allowed: string): Response {
  return new Response("the method is not allowed here", {
    status: 405,
    headers: { allow: allowed, "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
  });
}

/** The page of the app, with the import map the client modules share and the policy that lets that one script run. */
async function appPage(app: WebApp): Promise<Response> {
  const page = await pageOf(app);
  return new Response(page.html, {
    headers: { "content-type": "text/html; charset=utf-8", ...BASE_HEADERS, "content-security-policy": appPolicy(page.hash) },
  });
}

/** A file that never changes under its name: the name carries the hash of what it holds. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** `/modules/<id>/<hash>/index.js` and `/modules/<id>/<hash>/style-<n>-<hash>.css`. */
const MODULE_PATH = /^\/modules\/([^/]+)\/([0-9a-f]{64})\/(index\.js|style-(\d+)-([0-9a-f]{12})\.css)$/;

/** What the app serves at an address that is none of the API's: its files, the client modules, or the app's own page. */
async function appResponse(context: Context, app: WebApp, path: string): Promise<Response> {
  if (path.startsWith(ASSETS_PREFIX)) {
    const file = await assetFile(app, path);
    if (file === undefined) return text(404, "there is no such file");
    return new Response(Bun.file(file), {
      headers: { "content-type": typeOf(file), ...SECURITY_HEADERS, "cache-control": IMMUTABLE },
    });
  }
  if (path.startsWith(MODULES_PREFIX)) {
    const found = MODULE_PATH.exec(path);
    if (found === null) return text(404, "there is no such module");
    const [, id = "", hash = "", file = "", index, sheet] = found;
    if (file === "index.js") {
      const code = await context.builds.code(context.api, app, id, hash);
      if (code === undefined) return text(404, "the host lists no such module");
      if (typeof code !== "string") return text(500, `the module could not be built: ${code.problem}`);
      return new Response(code, {
        headers: { "content-type": typeOf("module.js"), ...SECURITY_HEADERS, "cache-control": IMMUTABLE },
      });
    }
    const css = await context.builds.style(context.api, id, hash, Number(index), sheet ?? "");
    if (css === undefined) return text(404, "the host lists no such stylesheet");
    return new Response(css, { headers: { "content-type": typeOf("style.css"), ...SECURITY_HEADERS, "cache-control": IMMUTABLE } });
  }
  // An address with an extension names a file that is not there; any other is a page of the app.
  if (/\.[A-Za-z0-9]+$/.test(path)) return text(404, "there is no such file");
  return appPage(app);
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
