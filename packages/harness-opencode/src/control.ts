/**
 * The control side for OpenCode. One child per session serves the pinned `@opencode/client`
 * over inherited pipes in a box or via `opencode serve --stdio` on unboxed launches.
 *
 * The child stays up while its stdin is open. Shutdown closes stdin, then signals the process
 * group if needed.
 * Every HTTP call carries a Basic authorization of a random password the child was
 * given, and answers within the call timeout; the turns are admitted by `session.prompt`, which
 * returns as soon as the message is taken, never when the turn ends — the end comes as a
 * `session.execution.*` event on the one event stream each session holds, and the events of the
 * stream are mapped by `protocol.ts`. A message to a busy session is queued by this side and
 * becomes a turn of its own when the running turn ends; only a caller that asks for it is steered
 * into the running turn (`delivery: "steer"`). The working mode sets the session's permission
 * rules at creation. The MCP servers of a session go to the child as an `OPENCODE_CONFIG_CONTENT`
 * config document, the only place opencode v2 takes them.
 */

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { z } from "zod";
import { ClientError, OpenCode } from "@opencode/client";
import type { SessionGetOutput } from "@opencode/client";

import { assertNever, timestamp } from "@niwa-labs/core";
import type { Answer, Question } from "@niwa-labs/core";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  HarnessIdSchema,
  InputNotSent,
  inputFailure,
  ProtocolNameSchema,
  Unavailable,
  Unsupported,
  modeOf,
  modelName,
  requireLaunch,
  requireTools,
  sessionId as makeSessionId,
  unknownVariantSigns,
  VariantNameSchema,
} from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Dispatch,
  HarnessId,
  LaunchCapabilities,
  LifeEvent,
  McpServerSpec,
  Prompt,
  ResumeOptions,
  ReverseHandler,
  SendOptions,
  SessionControl,
  SessionId,
  SessionMode,
  SessionState,
  StartOptions,
  StartedSession,
  VisibleActions,
} from "@niwa-labs/harness";
import { BoxSpecSchema, LIVE_PROCESS_REFUSAL, sandboxOf, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess, BoxRequest } from "@niwa-labs/sandbox";

import { boxedEnvironment, matchesListener, writesRuntime } from "./box.ts";
import { MODE_PERMISSIONS, OPENCODE_MODES, hasModePermissions, requireOpenCodeMode } from "./permissions.ts";
import type { OpenCodeMode } from "./permissions.ts";
import { OpenCodePipe, OpenCodePipeUnsent } from "./pipe-client.ts";
import { OPENCODE_RUNTIME_VERSION, PIPE_ORIGIN, PROXY_CLOSE_ENV } from "./pipe-wire.ts";
import { eventAction, OPENCODE_PROTOCOL } from "./protocol.ts";
import type { OpenCodeForm, PermissionAskedData, ServerEvent, ToolNames, TurnEnd } from "./protocol.ts";
import { policyDecision, readForm, readPermission } from "./reverse.ts";
import type { PermissionDecision } from "./reverse.ts";
import { opencodeWorker } from "./runtime.ts";
import {
  MAX_LINE_BYTES,
  STORAGE_ENV_NAMES,
  announcementIn,
  authOf,
  installationEnvOf,
  sessionStorageIssueOf,
  stopServer,
  storageEnvOf,
} from "./server.ts";
import type { ServerChild } from "./server.ts";

/**
 * What an OpenCode session takes at launch: a model as `providerId/modelId`. opencode v2 names no
 * effort levels of its own, so none are declared.
 */
export const OPENCODE_LAUNCH: LaunchCapabilities = { model: true, effort: [], modes: [...OPENCODE_MODES] };

/** What happens when a tool asks for permission: the answer to a request the session still makes. */
export type OpenCodePermissionPolicy = "allow" | "deny";

export interface OpenCodeControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The CLI executable for unboxed launches or a box with an explicitly granted listener. */
  readonly binary?: string;
  /**
   * The OpenCode installation's state directory, ending in `opencode`. Without it a child uses
   * its XDG data home (`~/.local/share/opencode` by default).
   */
  readonly home?: string;
  /** The installation environment shared with its reading server. */
  readonly env?: Readonly<Record<string, string>>;
  /** The working mode of sessions, when the caller does not choose one per start. Default: `auto`. */
  readonly mode?: SessionMode;
  /**
   * What happens when a tool asks for permission without a reverse handler. The default is `"deny"`.
   * Explicit `"allow"` grants that request once.
   */
  readonly permissions?: OpenCodePermissionPolicy;
  /** The model sessions talk to, as `providerId/modelId`, when the caller does not choose one per start. */
  readonly model?: string;
  /** How long one call waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;
  /** How long a turn waits for its end, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a graceful stop waits before each signal, in milliseconds. */
  readonly stopGraceMs?: number;
}

/** A `SessionControl` that will also own the `opencode serve` children it starts. */
export interface OpenCodeSessionControl extends SessionControl {
  /** Stops a session and lets it go: the contract's release of one session. */
  close(id: SessionId): Promise<void>;

  /** Stops a session and the `opencode serve` child it owns. */
  stop(id: SessionId): Promise<void>;

  /** Stops every session this control side owns, including ones still starting. */
  dispose(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 180_000;
/** A bun process that writes its database needs time to drain after its input ends. */
const DEFAULT_STOP_GRACE_MS = 1_500;
const STDERR_TAIL_CHARS = 2000;
/** The server version this control side speaks: the major of the pinned client. */
const REQUIRED_MAJOR = 2;

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

/** A watcher gets events, then `undefined` once when the child is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** A turn that waits for the running one; an ask also waits for its answer. */
interface QueuedTurn {
  readonly text: string;
  readonly ask?: { resolve: (end: string) => void; reject: (error: unknown) => void };
}

interface TurnWait {
  readonly done: Promise<TurnOutcome | undefined>;
  cancel(): void;
}

/** How a turn ended, with the answer its texts left on the event stream. */
interface TurnOutcome extends TurnEnd {
  readonly response: string;
  readonly messages: readonly string[];
}

/** A permission request that waits for an answer, and the answer it is waiting for. */
interface Asking {
  readonly controller: AbortController;
  dismiss(): void;
  replying: boolean;
}

/**
 * What a session's process was launched with. A process that replaces it is launched with the
 * same: what a resume does not name again stays what it was.
 */
interface Launch {
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly box: BoxRequest | undefined;
  readonly servers: readonly McpServerSpec[] | undefined;
}

/** The model a session was asked to run, as `providerId/modelId`. */
interface ModelSelection {
  readonly providerID: string;
  readonly id: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an error is an aborted call (our own timeout), however deep the client wrapped it: a
 * request that was cut mid-flight may still have been admitted.
 */
function isAbort(error: unknown): boolean {
  for (let at = error; at instanceof Error; at = (at as Error & { readonly cause?: unknown }).cause) {
    const name = (at as DOMException).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
  }
  return false;
}

/**
 * Whether a transport failure proves the request never left: the connection was never made. A
 * connection that broke mid-flight proves nothing — the server may have taken the request.
 */
function isConnectFailure(error: unknown): boolean {
  for (let at = error; at instanceof Error; at = (at as Error & { readonly cause?: unknown }).cause) {
    if (at instanceof OpenCodePipeUnsent) return true;
    const code = (at as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return true;
    }
  }
  return false;
}

/** How far a call that failed got: never written, refused by an answer, or written and never answered. */
function dispatchOf(error: unknown): { readonly dispatch: Dispatch; readonly detail: string } {
  if (isAbort(error)) return { dispatch: "uncertain", detail: "the call ended before the server answered" };
  if (error instanceof ClientError) {
    if (error.reason === "Transport" && isConnectFailure(error)) {
      return { dispatch: "unsent", detail: `the server was not reached: ${error.message}` };
    }
    // A broken connection, unexpected status or malformed success body does not establish refusal.
    return { dispatch: "uncertain", detail: `the server gave no confirmed answer: ${error.message}` };
  }
  // The client decoded a declared error response.
  return { dispatch: "refused", detail: messageOf(error) };
}

class LiveSession {
  nativeId = "";
  /** The client of the server, once the child is ready. */
  client: ReturnType<typeof OpenCode.make> | undefined;
  /** The turns niwa has started; the running one, if any, has this number. */
  turn = 0;
  busy = false;
  interrupting = false;
  /** Whether the running turn's start was reported. */
  began = false;
  stopping = false;
  stopPromise: Promise<void> | undefined;
  ended = false;
  /** What the process was launched with. */
  launch: Launch = { env: undefined, box: undefined, servers: undefined };
  cwd: string | undefined;
  failure: string | undefined;
  stderrTail = "";
  readonly queue: QueuedTurn[] = [];
  /** Where this session's reverse requests go, when it has been given a place for them. */
  reverse: ReverseHandler | undefined;
  /** The reverse requests waiting for an answer, by kind and native id. */
  readonly asking = new Map<string, Asking>();
  /** The model niwa named at the create, when it named one: a model this side chose is not reported back. */
  pinnedModel: string | undefined;
  /** The model last reported by the session's steps, when one was. */
  reportedModel: string | undefined;
  /** The last non-empty answer text the running turn's `session.text.ended` events left. */
  answer = "";
  /** The assistant messages the running turn's steps named, to read the answer back by. */
  turnMessages: string[] = [];
  /** Ends the event stream of the session. */
  readonly events = new AbortController();
  /** The names of the session's tool calls, learned from the events that name them. */
  readonly tools: ToolNames = (() => {
    const names = new Map<string, string>();
    return {
      nameOf: (id: string) => names.get(id),
      remember: (id: string, name: string) => void names.set(id, name),
    };
  })();

  private watchers = new Set<Watcher>();
  /** The turn signs before anyone watched: the first watcher is given them, after it nothing is kept. */
  private unwatched: LifeEvent[] | undefined = [];
  private readonly turnWaiters: Array<(end: TurnOutcome | undefined) => void> = [];

  constructor(readonly child: AgentProcess, readonly boxedPipe: boolean) {}

  watch(watcher: Watcher): () => void {
    const watchers = this.watchers;
    this.replay(watcher);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }

  takeWatchers(): Set<Watcher> {
    const watchers = this.watchers;
    this.watchers = new Set();
    return watchers;
  }

  attachWatchers(watchers: Set<Watcher>): void {
    this.watchers = watchers;
    for (const watcher of watchers) this.replay(watcher);
  }

  private replay(watcher: Watcher): void {
    const missed = this.unwatched ?? [];
    this.unwatched = undefined;
    for (const event of missed) watcher(event);
  }

  /** The server settled this request independently of the reverse handler. */
  settleAsking(key: string): void {
    const asking = this.asking.get(key);
    this.asking.delete(key);
    asking?.controller.abort();
  }

  /** Dismiss everything the ending turn asked. */
  cancelAsking(): void {
    for (const [key, asking] of this.asking) {
      this.asking.delete(key);
      asking.controller.abort();
      if (!asking.replying) asking.dismiss();
    }
  }

  /** Fail every queued ask, and drop the queue; returns how many turns were dropped. */
  dropQueue(reason: string): number {
    const dropped = this.queue.splice(0);
    for (const turn of dropped) turn.ask?.reject(new Error(reason));
    return dropped.length;
  }

  emit(event: LifeEvent): void {
    if (this.unwatched !== undefined && event.kind !== "activity") {
      this.unwatched.push(event);
      if (this.unwatched.length > UNWATCHED_LIMIT) this.unwatched.shift();
    }
    for (const watcher of [...this.watchers]) {
      try {
        watcher(event);
      } catch {
        // A broken watcher must not break the session.
      }
    }
  }

  expectTurn(timeoutMs: number): TurnWait {
    if (this.ended) return { done: Promise.resolve(undefined), cancel: () => {} };
    let waiter: (end: TurnOutcome | undefined) => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drop = (): void => {
      clearTimeout(timer);
      const at = this.turnWaiters.indexOf(waiter);
      if (at !== -1) this.turnWaiters.splice(at, 1);
    };
    const done = new Promise<TurnOutcome | undefined>((resolve) => {
      waiter = (end) => {
        clearTimeout(timer);
        resolve(end);
      };
      this.turnWaiters.push(waiter);
      timer = setTimeout(() => {
        drop();
        resolve(undefined);
      }, timeoutMs);
    });
    return { done, cancel: drop };
  }

  settleTurn(end: TurnOutcome | undefined): void {
    for (const waiter of this.turnWaiters.splice(0)) waiter(end);
  }

  /** The child is gone: every waiter is released, every watcher told. */
  end(failure?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.busy = false;
    this.events.abort();
    for (const asking of this.asking.values()) asking.controller.abort();
    this.asking.clear();
    const lost = this.dropQueue(failure ?? "the session ended");
    if (failure !== undefined) {
      this.failure = failure;
      this.emit({ kind: "activity", at: Date.now(), detail: failure });
    }
    if (lost > 0) {
      this.emit({ kind: "activity", at: Date.now(), detail: `${lost} queued message(s) were never delivered: the session ended` });
    }
    this.settleTurn(undefined);
    for (const watcher of [...this.watchers]) watcher(undefined);
  }
}

/** The control side for OpenCode. It owns every `opencode serve` child it starts and terminates them itself. */
export function opencodeControl(options: OpenCodeControlOptions): OpenCodeSessionControl {
  const binary = options.binary ?? "opencode";
  const permissions = options.permissions ?? "deny";
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const harnessId = HarnessIdSchema.parse(options.harness);

  /** How a child of this installation is pointed at the state directory it keeps its sessions in. */
  const installationEnv = installationEnvOf(options.home);
  const storageEnv = storageEnvOf(options.env);

  /** The sessions by id; `owned` also holds those still starting. */
  const sessions = new Map<string, LiveSession>();
  const owned = new Set<LiveSession>();
  /** The launches under way: a process that is being born is not yet in `owned`. */
  const launching = new Set<Promise<unknown>>();
  /** The resumes under way, by session: the last of those waiting for the session's turn at it. */
  const resuming = new Map<string, Promise<void>>();
  let disposed = false;

  /** The tool modes this side can hold a session to: none but `all` (capabilities.ts). */
  const TOOLS = { niwaOnly: false, allow: false } as const;

  /**
   * A tool this kind cannot switch off is refused by name, never silently left on: opencode v2
   * gates its tools by permission actions, not by tool name, so a deny of a named tool is a
   * promise this side cannot hold.
   */
  function requireNoDisabledTools(visible: VisibleActions | undefined, ability: string): void {
    const disabled = visible?.disabledTools ?? [];
    if (disabled.length === 0) return;
    throw new Unsupported(
      harnessId,
      "control",
      ability,
      `opencode v2 has no per-tool switch, so these tools cannot be switched off: ${disabled.join(", ")}`,
    );
  }

  function unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(harnessId, "control", ability, detail);
  }

  /** The options every call takes: the call timeout, as a signal the client passes to its fetch. */
  function callOptions(session: LiveSession): OpenCode.RequestOptions {
    return { signal: AbortSignal.any([AbortSignal.timeout(callTimeoutMs), session.events.signal]) };
  }

  // -- the client ----------------------------------------------------------

  /** One call to the session's server: a failure is a refusal of the ability that made it. */
  async function call<T>(session: LiveSession, ability: string, run: (options: OpenCode.RequestOptions) => Promise<T>): Promise<T> {
    if (session.client === undefined) throw unavailable(ability, session.failure ?? "the session's server is not running");
    try {
      return await run(callOptions(session));
    } catch (error) {
      throw unavailable(ability, dispatchOf(error).detail);
    }
  }

  /**
   * The config document a child is born with, as its `OPENCODE_CONFIG_CONTENT`: the caller's own
   * document, when it gave one, with this session's MCP servers merged in. opencode v2 takes its
   * servers only through its config; a local server is one argv (`command`) and a map of strings
   * (`environment`) — the v2 schema's own shape (`config/mcp.ts`), which is not niwa's (`command` +
   * `args`). A caller's server of the same name is the caller's no more: the session's own servers
   * are what niwa promised it. A document the caller gave that is not a JSON object is refused
   * loudly — merged config must never be dropped in silence.
   */
  function configOf(servers: readonly McpServerSpec[] | undefined, caller: string | undefined): string | undefined {
    if (servers === undefined || servers.length === 0) return caller;
    let base: Record<string, unknown> = {};
    if (caller !== undefined) {
      try {
        const parsed: unknown = JSON.parse(caller);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        base = { ...(parsed as Record<string, unknown>) };
      } catch {
        throw new Unsupported(harnessId, "control", "start", "OPENCODE_CONFIG_CONTENT the caller gave is not a JSON object");
      }
    }
    const mcp = typeof base["mcp"] === "object" && base["mcp"] !== null && !Array.isArray(base["mcp"]) ? { ...(base["mcp"] as Record<string, unknown>) } : {};
    const named = typeof mcp["servers"] === "object" && mcp["servers"] !== null && !Array.isArray(mcp["servers"]) ? { ...(mcp["servers"] as Record<string, unknown>) } : {};
    mcp["servers"] = {
      ...named,
      ...Object.fromEntries(
        servers.map((server) => [
          server.name,
          {
            type: "local",
            command: [server.command, ...server.args],
            ...(Object.keys(server.env).length === 0 ? {} : { environment: { ...server.env } }),
          },
        ]),
      ),
    };
    return JSON.stringify({ ...base, mcp });
  }

  // -- the events ------------------------------------------------------------

  /** The session an event is about, when it names one. */
  function sessionOf(ev: ServerEvent): string | undefined {
    const data = ev.data as { readonly sessionID?: unknown; readonly form?: { readonly sessionID?: unknown } } | undefined;
    const native = ev.type === "form.created" ? data?.form?.sessionID : data?.sessionID;
    return typeof native === "string" ? native : undefined;
  }

  /**
   * The event stream of one session: subscribed before the first prompt is admitted (the first
   * delivery, `server.connected`, is awaited), and pumped until the session ends. The stream is
   * not reconnected when it drops: a session whose stream failed is ended, for its turns can no
   * longer be seen to end (reconnect is a later wave).
   */
  async function subscribe(session: LiveSession): Promise<void> {
    const client = session.client;
    if (client === undefined) throw unavailable("start", "the session's server is not running");
    const stream = client.event.subscribe({ signal: session.events.signal })[Symbol.asyncIterator]();
    // The first delivery — the stream's own hello — is waited for within the call timeout: a server
    // that holds its stream open but says nothing is a start that never finishes.
    const silent = new Error(`the server's event stream said nothing within ${callTimeoutMs} ms`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(silent), callTimeoutMs);
    });
    let first: IteratorResult<ServerEvent>;
    try {
      first = await Promise.race([stream.next(), quiet]);
    } catch (error) {
      // What is left of the stream is torn down: the session is not started, and its pump must not linger.
      session.events.abort();
      throw error === silent
        ? unavailable("start", silent.message)
        : unavailable("start", `the server took no event subscription: ${dispatchOf(error).detail}`);
    } finally {
      clearTimeout(timer);
    }
    if (first.done === true) throw unavailable("start", "the event stream closed before its first delivery");
    handleEvent(session, first.value);
    void (async () => {
      try {
        for (;;) {
          const next = await stream.next();
          if (next.done === true) break;
          handleEvent(session, next.value);
        }
        if (!session.ended && !session.stopping) failSession(session, "the event stream ended: the server closed it");
      } catch (error) {
        if (session.ended || session.stopping || session.events.signal.aborted) return;
        failSession(session, `the event stream failed: ${messageOf(error)}`);
      }
    })();
  }

  function handleEvent(session: LiveSession, ev: ServerEvent): void {
    // One server per session, but the subscription hears the whole server: only this session's
    // events are its own, and an event that names another session is not ours even so.
    const native = sessionOf(ev);
    if (native !== undefined && session.nativeId !== "" && native !== session.nativeId) return;
    // The answer texts are collected before the mapping: the map is about what an event means,
    // and the text of an ended text is the turn's answer, not a sign of life.
    if (ev.type === "session.text.ended" && (native === undefined || native === session.nativeId)) {
      if (ev.data.text.trim() !== "") session.answer = ev.data.text;
    }
    if (ev.type === "session.step.started" && (native === undefined || native === session.nativeId)) {
      session.turnMessages.push(ev.data.assistantMessageID);
    }
    const action = eventAction(ev, session.tools);
    switch (action.do) {
      case "end-turn":
        endTurn(session, action.end);
        return;
      case "start-busy":
        // Defensive: the admission already said the session is busy. An execution that began
        // while this side believed the session idle is a turn of its own, that its own end will end.
        if (!session.busy) {
          session.turn += 1;
          session.busy = true;
          session.began = true;
          session.answer = "";
          session.turnMessages = [];
          session.emit({ kind: "turn-started", turn: session.turn, at: Date.now() });
        }
        return;
      case "permission":
        void answerPermission(session, action.request);
        return;
      case "form":
        if (native === session.nativeId) void answerForm(session, action.form);
        return;
      case "reverse-ended":
        if (native === session.nativeId) session.settleAsking(`${action.kind}:${action.id}`);
        return;
      case "activity": {
        session.emit({
          kind: "activity",
          at: Date.now(),
          detail: action.detail,
          ...(action.tool === undefined ? {} : { tool: action.tool }),
        });
        if (action.model !== undefined) reportModel(session, action.model);
        return;
      }
      case "unknown":
        for (const sign of unknownVariantSigns(Date.now(), OPENCODE_PROTOCOL, VariantNameSchema.parse(action.variant), ev)) {
          session.emit(sign);
        }
        return;
      case "ignore":
        return;
      default:
        return assertNever(action, "event action");
    }
  }

  /**
   * The model the session runs, reported once and only when it changes. A model this side named at
   * the create is never reported back: the server only echoes what niwa asked for.
   */
  function reportModel(session: LiveSession, model: string): void {
    if (session.pinnedModel !== undefined || session.reportedModel === model) return;
    session.reportedModel = model;
    session.emit({ kind: "model", model: modelName(model) });
  }

  /** Answer a permission request: by the place the session's reverse requests go, else by the policy. */
  async function answerPermission(session: LiveSession, request: PermissionAskedData): Promise<void> {
    const key = `permission:${request.id}`;
    const asking = beginAsking(session, key, () => void replyPermission(session, request.id, "reject"));
    if (asking === undefined) return;
    const ask = readPermission(request);
    const decision = session.reverse === undefined
      ? policyDecision(permissions)
      : ask.answer(await requestAnswer(session, asking, ask.question, "permission.asked", request));
    await sendAnswer(session, key, asking, () => replyPermission(session, request.id, decision));
  }

  function beginAsking(session: LiveSession, key: string, dismiss: () => void): Asking | undefined {
    if (session.asking.has(key) || session.client === undefined || session.ended || session.stopping) return undefined;
    const asking: Asking = { controller: new AbortController(), dismiss, replying: false };
    session.asking.set(key, asking);
    return asking;
  }

  async function requestAnswer(session: LiveSession, asking: Asking, question: Question, method: string, params: unknown): Promise<Answer> {
    try {
      return await session.reverse?.(makeSessionId(harnessId, session.nativeId), {
        question,
        raw: { method, params },
        signal: asking.controller.signal,
      }) ?? { cancelled: true };
    } catch {
      return { cancelled: true };
    }
  }

  async function sendAnswer(session: LiveSession, key: string, asking: Asking, send: () => Promise<void>): Promise<void> {
    if (asking.controller.signal.aborted) return;
    asking.replying = true;
    try {
      await send();
    } finally {
      if (session.asking.get(key) === asking) session.asking.delete(key);
    }
  }

  async function answerForm(session: LiveSession, form: OpenCodeForm): Promise<void> {
    if (typeof form.id !== "string" || form.id === "") return;
    const key = `form:${form.id}`;
    const target = { sessionID: session.nativeId, formID: form.id };
    const asking = beginAsking(session, key, () => void cancelForm(session, target));
    if (asking === undefined) return;
    const ask = readForm(form);
    const answer = ask === undefined || session.reverse === undefined
      ? undefined
      : ask.answer(await requestAnswer(session, asking, ask.question, "form.created", { form }));
    await sendAnswer(session, key, asking, async () => {
      if (answer === undefined) {
        const message = ask === undefined || session.reverse === undefined ? "This client cannot present the requested form" : undefined;
        await cancelForm(session, target, message);
        return;
      }
      try {
        await session.client!.session.form.reply({ ...target, answer }, callOptions(session));
      } catch (error) {
        session.emit({ kind: "activity", at: Date.now(), detail: `the form reply was not taken: ${dispatchOf(error).detail}` });
        if (!asking.controller.signal.aborted) await cancelForm(session, target, "This client could not submit an answer to the form");
      }
    });
  }

  async function cancelForm(session: LiveSession, target: { sessionID: string; formID: string }, message?: string): Promise<void> {
    if (session.client === undefined || session.ended || session.stopping) return;
    try {
      await session.client.session.form.cancel({ ...target, message }, callOptions(session));
    } catch (error) {
      session.emit({ kind: "activity", at: Date.now(), detail: `the form cancellation was not taken: ${dispatchOf(error).detail}` });
    }
  }

  /** Send the reply to a permission request; a reply the server no longer waits for is an activity at most. */
  async function replyPermission(session: LiveSession, requestID: string, decision: PermissionDecision): Promise<void> {
    if (session.client === undefined || session.ended) return;
    try {
      await session.client.permission.reply({ sessionID: session.nativeId, requestID, decision }, callOptions(session));
    } catch (error) {
      session.emit({ kind: "activity", at: Date.now(), detail: `the permission reply was not taken: ${dispatchOf(error).detail}` });
    }
  }

  function endTurn(session: LiveSession, end: TurnEnd): void {
    const at = Date.now();
    // An end with no turn running ends nothing: it is a stray, and a sign of life at most.
    if (!session.busy) {
      session.emit({ kind: "activity", at, detail: `a turn ended while none was running (${end.outcome})` });
      return;
    }
    session.cancelAsking();
    // The end of a turn that came before the answer to its prompt is still preceded by its start.
    if (!session.began) {
      session.began = true;
      session.emit({ kind: "turn-started", turn: session.turn, at });
    }
    session.busy = false;
    if (end.error !== undefined) session.emit({ kind: "activity", at, detail: end.error });
    session.emit({ kind: "turn-ended", turn: session.turn, at, outcome: end.outcome });
    session.settleTurn({ ...end, response: session.answer, messages: session.turnMessages });
    session.answer = "";
    session.turnMessages = [];
    // A message that waited for this turn becomes a turn of its own.
    drainQueue(session);
  }

  // -- the child ------------------------------------------------------------

  function hasExited(session: LiveSession): boolean {
    return session.child.exitCode !== null || session.child.signalCode !== null;
  }

  function signalGroup(session: LiveSession, signal: NodeJS.Signals): void {
    const pid = session.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        session.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  function waitForExit(session: LiveSession, timeoutMs: number): Promise<boolean> {
    if (hasExited(session)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onClose = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        session.child.off("close", onClose);
        resolve(false);
      }, timeoutMs);
      session.child.once("close", onClose);
    });
  }

  /** The session's child as the shared stop ladder sees it (`server.ts`). */
  function serverChildOf(session: LiveSession): ServerChild {
    return {
      pid: session.child.pid,
      hasExited: () => hasExited(session),
      endInput: () => session.child.stdin?.end(),
      signalGroup: (signal) => signalGroup(session, signal),
      waitForExit: (timeoutMs) => waitForExit(session, timeoutMs),
    };
  }

  /** Ends the input and lets the child drain, then SIGTERM to the process group, then SIGKILL. */
  function stopSession(session: LiveSession): Promise<void> {
    session.stopping = true;
    return session.stopPromise ??= closeSession(session).finally(() => session.end());
  }

  async function closeSession(session: LiveSession): Promise<void> {
    // An active execution left on EOF is eligible for upstream crash recovery on the next boot.
    // On an orderly close ask the worker to interrupt and settle it before ending the pipe.
    if (session.boxedPipe && session.busy && !session.ended && session.client !== undefined && stopGraceMs > 0) {
      const turn = session.expectTurn(stopGraceMs);
      try {
        if (!session.interrupting) {
          const signal = AbortSignal.any([AbortSignal.timeout(stopGraceMs), session.events.signal]);
          await session.client.session.interrupt({ sessionID: session.nativeId }, { signal });
        }
        await turn.done;
      } catch {
        // A broken pipe or a missed deadline proceeds to the stop ladder.
      } finally {
        turn.cancel();
      }
    }
    await stopServer(serverChildOf(session), stopGraceMs);
  }

  function failSession(session: LiveSession, reason: string): void {
    session.end(reason);
    void stopSession(session);
  }

  /** Spawns a child and waits for its announcement. A child that does not answer is stopped. */
  async function spawnSession(cwd: string, plan: Pick<StartOptions, "env" | "box" | "servers">, ability: "start" | "resume"): Promise<LiveSession> {
    const launch = launchSession(cwd, plan, ability);
    launching.add(launch);
    try {
      return await launch;
    } finally {
      launching.delete(launch);
    }
  }

  async function launchSession(cwd: string, plan: Pick<StartOptions, "env" | "box" | "servers">, ability: "start" | "resume"): Promise<LiveSession> {
    if (disposed) throw unavailable(ability, "the control side is disposed");
    const listener = BoxSpecSchema.shape.listen.parse(plan.box?.spec.listen);
    const pipeBox = listener === undefined ? plan.box : undefined;
    const env = { ...options.env, ...plan.env, ...storageEnv, ...installationEnv };
    const confined = plan.box === undefined ? undefined : boxedEnvironment(plan.box, env, cwd);
    if (confined !== undefined && confined.missing.length > 0) {
      throw new Unsupported(harnessId, "control", ability, `the box lacks writable OpenCode paths: ${confined.missing.join(", ")}`);
    }
    const storageIssue = sessionStorageIssueOf(storageEnv, { ...plan.box?.spec.env, ...plan.env }, confined?.home ?? options.home);
    if (storageIssue !== undefined) throw unavailable(ability, storageIssue);
    const password = randomBytes(24).toString("hex");
    const config = configOf(plan.servers, env["OPENCODE_CONFIG_CONTENT"] ?? plan.box?.spec.env?.["OPENCODE_CONFIG_CONTENT"]);
    const worker = pipeBox === undefined ? undefined : opencodeWorker();
    if (pipeBox !== undefined && worker !== undefined && writesRuntime(pipeBox, worker.root, cwd)) {
      throw new Unsupported(harnessId, "control", ability, "the boxed OpenCode runtime needs a read-only grant");
    }
    if (worker !== undefined && confined !== undefined) {
      // The sandbox grants the app directories individually. Their XDG ancestors may not exist yet.
      await Promise.all(confined.directories.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    }
    const args = ["serve", "--stdio"];
    if (listener !== undefined) args.push("--hostname", listener.host, "--port", String(listener.port));
    const child = await spawnAgent({
      harness: harnessId,
      program: worker === undefined ? binary : process.execPath,
      args: worker?.args ?? args,
      cwd,
      ...(plan.box === undefined ? {} : { box: plan.box }),
      // Its own process group, so a stop reaches everything opencode started and nothing else.
      detached: true,
      unset: STORAGE_ENV_NAMES,
      env: {
        ...env,
        ...confined?.env,
        // The password the server asks of every call, and the session's MCP servers as a config
        // document, the only place opencode v2 takes them.
        OPENCODE_PASSWORD: password,
        ...(pipeBox === undefined ? {} : { [PROXY_CLOSE_ENV]: sandboxOf(pipeBox.sandbox).name === "nono" ? "1" : "0" }),
        ...(config === undefined ? {} : { OPENCODE_CONFIG_CONTENT: config }),
      },
    });
    const session = new LiveSession(child, worker !== undefined);
    owned.add(session);

    let settleReady: ((url: string) => void) | undefined;
    let refuseReady: ((detail: string) => void) | undefined;
    let settled = false;
    const done = (take: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      take();
    };
    // `refuseReady` settles through `done` itself: the timer only has to say its word.
    const timer = setTimeout(
      () => refuseReady?.(`the server did not ${worker === undefined ? "announce its address" : "report readiness"} within ${callTimeoutMs} ms${session.stderrTail === "" ? "" : `: ${session.stderrTail.trim()}`}`),
      callTimeoutMs,
    );
    const ready = new Promise<string>((resolve, reject) => {
      settleReady = (url) => done(() => resolve(url));
      refuseReady = (detail) => done(() => reject(unavailable(ability, detail)));
    });

    const pipe = worker === undefined ? undefined : new OpenCodePipe(child, (error) => {
      // Let the process close deliver its exit status and stderr during startup.
      if (settled && !session.stopping && !hasExited(session)) failSession(session, messageOf(error));
    });
    if (pipe === undefined) listenForAddress();
    else void pipe.ready.then(() => settleReady?.(PIPE_ORIGIN), (error: unknown) => {
      if (!hasExited(session)) refuseReady?.(`${messageOf(error)}${session.stderrTail === "" ? "" : `: ${session.stderrTail.trim()}`}`);
    });

    function listenForAddress(): void {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // The announcement is one JSON line with a string `url`; anything else is noise.
          const url = announcementIn(line);
          if (url === undefined) continue;
          if (listener !== undefined && !matchesListener(url, listener)) {
            refuseReady?.("the server announced an address outside the box's TCP loopback listener");
          } else settleReady?.(url);
        }
        if (buffer.length > MAX_LINE_BYTES) {
          buffer = "";
          refuseReady?.("a line of the output stream was longer than the readiness budget");
          failSession(session, "a line of the output stream was longer than the readiness budget");
        }
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // A write to a dead child is reported by the closing child, not thrown as an unhandled event.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      owned.delete(session);
      refuseReady?.(`the server process failed: ${error.message}`);
      session.end(`the server process failed: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      owned.delete(session);
      signalGroup(session, "SIGKILL");
      const why = session.stopping ? "the session was stopped" : `the server process exited (${code ?? signal}): ${session.stderrTail.trim()}`;
      refuseReady?.(why);
      session.end(session.stopping ? undefined : why);
    });

    // The control side was disposed while the process was being born: it is not served, and not left running.
    if (disposed) {
      await stopSession(session);
      throw unavailable("start", "the control side was disposed while the process was starting");
    }

    // A child that announced nothing, or answered the version guard with nothing this side speaks,
    // is stopped before the failure is thrown: a failed launch leaves no server behind.
    let url: string;
    try {
      url = await ready;
    } catch (error) {
      await stopSession(session);
      throw error;
    }
    session.client = OpenCode.make({ baseUrl: url, headers: authOf(password), ...(pipe === undefined ? {} : { fetch: pipe.fetch }) });
    try {
      // The version guard: a server of another major speaks a protocol this client does not know.
      const info = await call(session, ability, (options) => session.client!.server.info(options));
      if (pipe !== undefined && (info.version !== OPENCODE_RUNTIME_VERSION || info.urls.length !== 0)) {
        throw unavailable(ability, `the boxed worker must run OpenCode ${OPENCODE_RUNTIME_VERSION} without a listener`);
      }
      const major = Number.parseInt(info.version, 10);
      if (!Number.isInteger(major) || major !== REQUIRED_MAJOR) {
        throw unavailable(
          "start",
          `the server speaks "opencode ${info.version === "" ? "?" : info.version}", but this control side speaks ${OPENCODE_PROTOCOL} (client 2.3.2); no session was started`,
        );
      }
    } catch (error) {
      await stopSession(session);
      throw error;
    }
    return session;
  }

  // -- the turns ------------------------------------------------------------

  function promptText(prompt: Prompt): string {
    return prompt.sections.map((section) => section.text).join("\n\n");
  }

  /**
   * Ask the server to take a message as a turn. The wait for the turn's end is registered before
   * the call is made, so a turn that ends in the same breath as its admission is not missed.
   */
  async function startTurn(session: LiveSession, text: string): Promise<{ turn: number; wait: TurnWait }> {
    if (session.busy || session.interrupting) throw new InputNotSent(harnessId, "send", "a turn is running or being interrupted");
    if (session.client === undefined || session.ended || session.stopping) {
      throw new InputNotSent(harnessId, "send", session.failure ?? "the session's server is not running");
    }
    session.turn += 1;
    session.busy = true;
    session.began = false;
    session.answer = "";
    session.turnMessages = [];
    const turn = session.turn;
    const wait = session.expectTurn(turnTimeoutMs);
    void wait.done.then((end) => {
      if (end !== undefined || session.ended || session.stopping || session.turn !== turn || !session.busy) return;
      // A missing end does not establish that the server is idle or that it lost the prompt.
      failSession(session, `turn ${turn} did not report its end within ${turnTimeoutMs} ms`);
    });
    try {
      await session.client.session.prompt({ sessionID: session.nativeId, text, delivery: "queue" }, callOptions(session));
    } catch (error) {
      const failure = dispatchOf(error);
      if (failure.dispatch !== "uncertain") {
        // The message was never taken: its turn never was, and what waited behind it goes on.
        wait.cancel();
        if (session.turn === turn) {
          session.busy = false;
          drainQueue(session);
        }
      }
      throw inputFailure(harnessId, "send", failure.dispatch, failure.detail);
    }
    if (session.busy && !session.began && session.turn === turn) {
      session.began = true;
      session.emit({ kind: "turn-started", turn, at: Date.now() });
    }
    return { turn, wait };
  }

  /** Wait for a started turn; anything but a completed turn is an error. */
  async function finishTurn(session: LiveSession, wait: TurnWait, ability: "ask" | "resume"): Promise<TurnOutcome> {
    const end = await wait.done;
    if (end === undefined) throw unavailable(ability, session.failure ?? "the turn did not end");
    if (end.outcome !== "completed") throw unavailable(ability, `the turn was ${end.outcome}: ${end.error ?? "no reason given"}`);
    return end;
  }

  /**
   * The answer of one turn, read back from the session's messages when the turn's own events
   * carried none: the last text of the assistant messages the turn's steps named. A turn that left
   * no text of its own has none: the text of another turn is never its answer.
   */
  async function turnAnswer(session: LiveSession, wait: TurnWait): Promise<string> {
    const end = await finishTurn(session, wait, "ask");
    if (end.response !== "" || end.messages.length === 0) return end.response;
    const read = await call(session, "ask", (options) =>
      session.client!.message.list({ sessionID: session.nativeId, limit: 100, order: "desc" }, options),
    );
    for (const message of read.data) {
      if (message.type !== "assistant" || !end.messages.includes(message.id)) continue;
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      if (text.trim() !== "") return text;
    }
    return "";
  }

  /**
   * Starts the turn that waited for the turn that just ended, in the order the messages came.
   * The caller of a message does not wait for its turn; the caller of an ask waits for the answer.
   */
  function drainQueue(session: LiveSession): void {
    if (session.busy || session.interrupting || session.ended || session.stopping) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    void startTurn(session, next.text)
      .then(({ wait }) => {
        if (next.ask !== undefined) return turnAnswer(session, wait).then(next.ask.resolve, next.ask.reject);
      })
      .catch((error: unknown) => {
        next.ask?.reject(error);
        // The messages behind it are released by the start that failed, when its message was never taken.
        session.emit({ kind: "activity", at: Date.now(), detail: `a queued message could not be started: ${messageOf(error)}` });
      });
  }

  /** Deliver a message the way a send does and say what became of it; nothing waits for the turn to end. */
  async function deliver(session: LiveSession, message: string): Promise<DeliveryReceipt> {
    const at = Date.now();
    if (session.stopping) throw new InputNotSent(harnessId, "send", session.failure ?? "the session's server is stopping");
    if (session.busy || session.interrupting) {
      session.queue.push({ text: message });
      return { status: "queued", turn: session.turn + session.queue.length, at };
    }
    const { turn } = await startTurn(session, message);
    return { status: "started", turn, at };
  }

  /** Put a message into the turn that runs, as a steer; a session that runs nothing starts a turn of it. */
  async function steer(session: LiveSession, message: string): Promise<DeliveryReceipt> {
    const at = Date.now();
    if (session.interrupting) throw new InputNotSent(harnessId, "send", "the running turn is being interrupted");
    if (!session.busy) {
      const { turn } = await startTurn(session, message);
      return { status: "started", turn, at };
    }
    if (session.client === undefined || session.stopping) {
      throw new InputNotSent(harnessId, "send", session.failure ?? "the session's server is not running");
    }
    const turn = session.turn;
    try {
      await session.client.session.prompt({ sessionID: session.nativeId, text: message, delivery: "steer" }, callOptions(session));
    } catch (error) {
      const failure = dispatchOf(error);
      throw inputFailure(harnessId, "send", failure.dispatch, failure.detail);
    }
    return { status: "delivered", turn, at };
  }

  function requireSession(id: SessionId, ability: string): LiveSession {
    const session = sessions.get(id.native);
    if (session === undefined) throw unavailable(ability, `the session ${id.native} is not held by this control side`);
    return session;
  }

  function checkResumeOptions(found: SessionGetOutput, mode: OpenCodeMode | undefined, model: string | undefined): void {
    if (mode !== undefined && !hasModePermissions(mode, found.permissions)) {
      throw unavailable("resume", `the session's permissions differ from mode "${mode}"`);
    }
    if (model !== undefined) {
      if (found.model === undefined) {
        throw unavailable("resume", `the server did not confirm the requested model "${model}" for this session`);
      }
      const named = `${found.model.providerID}/${found.model.id}`;
      if (named !== model) {
        throw unavailable("resume", `the session runs "${named}", but the resume was told "${model}"`);
      }
    }
  }

  function readSession(session: LiveSession, native: string): Promise<SessionGetOutput> {
    return call(session, "resume", (options) => session.client!.session.get({ sessionID: native }, options));
  }

  async function resumeTurn(session: LiveSession, text: string): Promise<void> {
    const { wait } = await startTurn(session, text);
    await finishTurn(session, wait, "resume");
  }

  /**
   * Takes the session on in a process of this side, and says what is left to do once it is: the turn of
   * the resume's prompt, which the caller runs after letting go of the session.
   */
  async function resumeSession(
    id: SessionId,
    resumeOptions: ResumeOptions | undefined,
    mode: OpenCodeMode | undefined,
  ): Promise<(() => Promise<void>) | undefined> {
    const text = resumeOptions?.prompt === undefined ? "" : promptText(resumeOptions.prompt);
    const storageIssue = sessionStorageIssueOf(storageEnv, resumeOptions?.env, options.home);
    if (storageIssue !== undefined) throw unavailable("resume", storageIssue);
    requireNoDisabledTools(resumeOptions?.visible, "resume");
    requireTools(harnessId, TOOLS, resumeOptions?.tools);
    // A held session continues in its own child: a second child would be a second writer.
    const held = sessions.get(id.native);
    const launch: Launch = {
      env: resumeOptions?.env ?? held?.launch.env,
      box: resumeOptions?.box ?? held?.launch.box,
      servers: resumeOptions?.servers ?? held?.launch.servers,
    };
    let carried: Set<Watcher> | undefined;
    if (held !== undefined && !held.ended && !held.stopping) {
      if (resumeOptions?.box !== undefined) throw new Unsupported(harnessId, "control", "resume", LIVE_PROCESS_REFUSAL);
      if (mode !== undefined || resumeOptions?.model !== undefined) {
        checkResumeOptions(await readSession(held, id.native), mode, resumeOptions?.model);
        if (held.ended || held.stopping) throw unavailable("resume", held.failure ?? "the session's server stopped during resume");
      }
      // What the process was born with is what it keeps: a resume that names the same servers
      // changes nothing, and one that names others is given to a new process, which reads them
      // from the config it is born with. That cannot be done under a running turn. What the
      // resume does not name stays as it was: the new process inherits the old environment.
      const changed =
        resumeOptions?.servers !== undefined && JSON.stringify(resumeOptions.servers) !== JSON.stringify(held.launch.servers ?? []);
      if (!changed) {
        // The resume is accepted: its caller names where the reverse requests go from now on.
        if (resumeOptions?.reverse !== undefined) held.reverse = resumeOptions.reverse;
        if (text === "") return undefined;
        // The prompt of a resume waits behind a running turn, as a send does; it is not an error.
        if (held.busy || held.interrupting) {
          held.queue.push({ text });
          return undefined;
        }
        return async () => resumeTurn(held, text);
      }
      if (held.busy || held.interrupting) {
        throw unavailable("resume", "a turn is running: the servers of the session change only when it is idle");
      }
      // The watchers follow the session, not the process: they are handed to the new one.
      carried = held.takeWatchers();
      await stopSession(held);
    } else if (held !== undefined) {
      // An ended event stream can leave its process alive until the stop ladder finishes.
      await stopSession(held);
    }
    if (held !== undefined && !hasExited(held)) {
      carried?.forEach((watcher) => watcher(undefined));
      throw unavailable("resume", "the previous OpenCode server did not stop");
    }

    // The session is resumed in the directory its caller says it ran in, else the one this side
    // remembers; the session's own directory stays what its record says, and opencode keeps the
    // session working there — the child's directory is only where the server itself sits.
    const cwd = resumeOptions?.cwd ?? launch.box?.spec.cwd ?? held?.cwd ?? process.cwd();
    let session: LiveSession;
    try {
      session = await spawnSession(cwd, launch, "resume");
    } catch (error) {
      carried?.forEach((watcher) => watcher(undefined));
      throw error;
    }
    session.cwd = cwd;
    session.reverse = resumeOptions?.reverse ?? held?.reverse;
    session.launch = launch;
    // A model the resume is given is the model the harness named for the session: the session
    // keeps it server-side, and this side does not report back what was named.
    session.pinnedModel = resumeOptions?.model;
    try {
      // A session this server does not know cannot be resumed: opencode keeps its sessions in the
      // state directory of the installation, which the child was pointed at by its environment.
      checkResumeOptions(await readSession(session, id.native), mode, resumeOptions?.model);
      session.nativeId = id.native;
      await subscribe(session);
      if (session.ended || session.stopping) throw unavailable("resume", session.failure ?? "the session's server stopped during resume");
      sessions.set(id.native, session);
      if (carried !== undefined) session.attachWatchers(carried);
      carried = undefined;
    } catch (error) {
      // Only its own entry: another process that took the session on in the meantime is not this one's to drop.
      if (sessions.get(id.native) === session) sessions.delete(id.native);
      await stopSession(session);
      carried?.forEach((watcher) => watcher(undefined));
      throw error;
    }
    return text === "" ? undefined : async () => resumeTurn(session, text);
  }

  // -- the contract ---------------------------------------------------------

  return {
    async start(startOptions: StartOptions): Promise<StartedSession> {
      // Everything this kind cannot do is refused before the child is spawned.
      const model = startOptions.model ?? options.model;
      const mode = modeOf(startOptions.mode, options.mode, OPENCODE_LAUNCH);
      requireOpenCodeMode(harnessId, "start", mode);
      requireLaunch(harnessId, OPENCODE_LAUNCH, { model, mode, effort: startOptions.effort });
      // opencode v2 has no tool switch of its own beyond the permission actions, so a session
      // cannot be held to a tool set: what is asked for is refused by name, never silently dropped.
      requireTools(harnessId, TOOLS, startOptions.tools);
      requireNoDisabledTools(startOptions.visible, "start");
      const selection = model === undefined || model === "" ? undefined : parseModel(harnessId, model);
      const cwd = startOptions.cwd ?? startOptions.box?.spec.cwd ?? process.cwd();

      const session = await spawnSession(cwd, startOptions, "start");
      session.cwd = cwd;
      session.reverse = startOptions.reverse;
      session.launch = { env: startOptions.env, box: startOptions.box, servers: startOptions.servers };
      session.pinnedModel = selection === undefined ? undefined : `${selection.providerID}/${selection.id}`;
      try {
        const created = await call(session, "start", (options) =>
          session.client!.session.create(
            {
              location: { directory: cwd },
              ...(selection === undefined ? {} : { model: { providerID: selection.providerID, id: selection.id } }),
              permissions: [...MODE_PERMISSIONS[mode]],
            },
            options,
          ),
        );
        if (created.id === "") throw unavailable("start", "the server created a session without naming it");
        if (!hasModePermissions(mode, created.permissions)) {
          throw unavailable("start", `the server did not confirm the session permissions for mode "${mode}"`);
        }
        session.nativeId = created.id;
        // The subscription is up before the first prompt is admitted: without it no turn of the
        // session can be seen to end.
        await subscribe(session);
        if (session.ended || session.stopping) throw unavailable("start", session.failure ?? "the session's server stopped during start");
        sessions.set(created.id, session);
      } catch (error) {
        if (sessions.get(session.nativeId) === session) sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
      const id = makeSessionId(harnessId, session.nativeId);
      // The caller knows the session before its prompt goes: a start cut off while its first turn
      // is on the way still finds it. A session whose name could not be kept is given no work.
      try {
        await startOptions.named?.(id);
      } catch (error) {
        if (sessions.get(session.nativeId) === session) sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
      // The session exists once the server has named it. The prompt is its first turn, delivered
      // like a send: the start waits for the server to take the turn, never for the turn to end.
      const text = promptText(startOptions.prompt);
      if (text === "") return { session: id, mode };
      try {
        return { session: id, first: await deliver(session, text), mode };
      } catch (error) {
        if (sessions.get(session.nativeId) === session) sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
    },

    async resume(id: SessionId, resumeOptions?: ResumeOptions): Promise<void> {
      const mode = resumeOptions?.mode;
      requireOpenCodeMode(harnessId, "resume", mode);
      // Resumes of one session go one at a time through the lookup, the launch and the publishing
      // of its process: two that both found it absent would launch two servers, and the later
      // would hide the earlier. The lock is let go before the prompt's turn, which can run for hours.
      const previous = resuming.get(id.native);
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = (previous ?? Promise.resolve()).then(() => mine);
      resuming.set(id.native, tail);
      let afterwards: (() => Promise<void>) | undefined;
      try {
        await previous;
        afterwards = await resumeSession(id, resumeOptions, mode);
      } finally {
        release();
        if (resuming.get(id.native) === tail) resuming.delete(id.native);
      }
      await afterwards?.();
    },

    async send(id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> {
      const session = sessions.get(id.native);
      if (session === undefined) {
        throw new InputNotSent(harnessId, "send", `the session ${id.native} is not held by this control side`);
      }
      // Only a caller that asks for it is steered into the running turn.
      if (sendOptions?.into === "turn") return steer(session, message);
      return deliver(session, message);
    },

    async interrupt(id: SessionId): Promise<void> {
      const session = requireSession(id, "interrupt");
      if (!session.busy || session.stopping || session.client === undefined) throw unavailable("interrupt", "no turn is running");
      if (session.interrupting) throw unavailable("interrupt", "an interrupt is already in progress");
      const turn = session.turn;
      session.interrupting = true;
      // An explicit stop clears the queue: the messages that waited behind a turn the caller
      // just stopped must not fire as a surprise.
      session.dropQueue("the turn was interrupted");
      try {
        const result = await session.client.session.interrupt({ sessionID: session.nativeId }, callOptions(session));
        if (result.interrupted && session.busy && session.turn === turn) session.cancelAsking();
      } catch (error) {
        const failure = dispatchOf(error);
        if (failure.dispatch === "uncertain" && !session.ended && !session.stopping) {
          failSession(session, `the interrupt could still affect this session: ${failure.detail}`);
        }
        throw unavailable("interrupt", failure.detail);
      } finally {
        session.interrupting = false;
        drainQueue(session);
      }
    },

    async ask<T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> {
      const session = requireSession(id, "ask");
      if (session.ended || session.stopping) throw unavailable("ask", session.failure ?? "the session's server is not running");
      // The schema travels as text, and the answer is checked against the zod schema here: an
      // answer that does not pass is not an answer.
      const jsonSchema = z.toJSONSchema(askOptions.schema, { io: "output", unrepresentable: "any" });
      const instruction = [
        promptText(askOptions.prompt),
        "",
        "Answer with JSON only, matching this schema exactly:",
        JSON.stringify(jsonSchema),
      ].join("\n");
      // An ask into a busy session waits for its turn, behind what is already queued.
      const text = session.busy || session.interrupting
        ? await new Promise<string>((resolve, reject) => {
            session.queue.push({ text: instruction, ask: { resolve, reject } });
          })
        : await turnAnswer(session, (await startTurn(session, instruction)).wait);
      if (text.trim() === "") throw unavailable("ask", "the turn left no answer");
      const checked = askOptions.schema.safeParse(parseJson(text));
      if (!checked.success) {
        throw unavailable("ask", `the answer did not pass the schema: ${checked.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      }
      return { session: id, value: checked.data, at: timestamp(Date.now()) };
    },

    life(id: SessionId): AsyncIterable<LifeEvent> {
      const session = requireSession(id, "life");
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<LifeEvent> {
          const queue: LifeEvent[] = [];
          let finished = session.ended;
          let wake: (() => void) | undefined;
          const watcher: Watcher = (event) => {
            if (event === undefined) finished = true;
            else queue.push(event);
            wake?.();
          };
          const unwatch = session.watch(watcher);
          try {
            for (;;) {
              const event = queue.shift();
              if (event !== undefined) {
                yield event;
              } else if (finished) {
                return;
              } else {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
              }
            }
          } finally {
            unwatch();
          }
        },
      };
    },

    async state(id: SessionId): Promise<SessionState> {
      const session = sessions.get(id.native);
      // A session not held, or whose child is gone, proves nothing about now.
      if (session === undefined || session.ended || session.stopping) return "unknown";
      return session.busy ? "running" : "idle";
    },

    /** The release the shared contract names: stops this session's process and no other. */
    async close(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      await stopSession(session);
      if (sessions.get(id.native) === session) sessions.delete(id.native);
    },

    async stop(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      await stopSession(session);
      if (sessions.get(id.native) === session) sessions.delete(id.native);
    },

    async dispose(): Promise<void> {
      disposed = true;
      sessions.clear();
      await Promise.all([...owned].map((session) => stopSession(session)));
      // A launch that is still under way stops its own child when it finds the control side disposed.
      await Promise.allSettled([...launching]);
    },
  };
}

/** `providerId/modelId`, split at the first slash: a model id may hold slashes of its own. */
function parseModel(harness: HarnessId, model: string): ModelSelection {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Unsupported(harness, "control", "start", `a model is named "providerId/modelId", not "${model}"`);
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** The JSON an answer holds: the answer as it is, in a fence, or after words; text that has none is the text. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const start = body.search(/[[{]/);
    if (start === -1) return body;
    try {
      return JSON.parse(body.slice(start)) as unknown;
    } catch {
      return body;
    }
  }
}
