/**
 * The control side for ZCode: how niwa starts, steers and stops sessions over
 * `zcode app-server --stdio`.
 *
 * The wire is NDJSON, one JSON object per line: `{id, method, params}` out, `{id, result|error}`
 * back, no `jsonrpc` field and no handshake; `runtime/capabilities` is the readiness ping. The
 * server also asks things of the client while a session materializes and while a turn runs, and
 * every one of those is answered, or the turn waits forever.
 *
 * Each session owns one child in its own process group, as the owner asked: no process is reused.
 * The session's MCP servers, tool allow-list and tool deny-list go in `session/create` (and in a
 * cold `session/resume`), where the server reads them.
 * The native session id is ZCode's own (`sess_<uuid>`). The model is not set at create (ZCode
 * fails the create on it) but goes with every `session/send`, with the effort as its reasoning
 * level. A message to a busy session is queued by default and becomes a turn of its own when the
 * current turn ends; only a caller that asks for it is steered into the running turn, which is
 * what ZCode itself does with a `session/send` during a turn.
 */

import { z } from "zod";

import { assertNever, timestamp } from "@niwa-labs/core";
import type { Answer, Question } from "@niwa-labs/core";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  HarnessIdSchema,
  Unavailable,
  Unsupported,
  modeOf,
  modelName,
  requireLaunch,
  sessionId as makeSessionId,
  unknownVariantSigns,
} from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
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
  ToolsMode,
  VisibleActions,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, homePath, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess, HarnessNeeds } from "@niwa-labs/sandbox";

import { notificationAction, requestAction } from "./dispatch.ts";
import type { Answered, TurnEnd } from "./dispatch.ts";
import { SessionMessageSchema } from "./protocol/generated/zcode-protocol.ts";
import type { RequestPermissionParams, RequestUserInputParams } from "./protocol/generated/zcode-protocol.ts";
import { readNotification, readRequest, unknownDetail, unknownVariantName, ZCODE_PROTOCOL } from "./protocol/index.ts";
import type { UnknownVariant } from "./protocol/index.ts";
import { directoryOf, persistedModeOf } from "./reading.ts";
import { INPUT_CANCELLED, readPermission, readUserInput } from "./reverse.ts";

/**
 * What a ZCode session takes at launch: a model as `providerId/modelId`, and the reasoning level
 * of it. The levels are the ones the GLM models list as their variants; a model with a level of
 * its own (`enabled`) is left to its default.
 */
export const ZCODE_LAUNCH: LaunchCapabilities = { model: true, effort: ["low", "high", "max"], modes: ["ask", "auto", "full"] };

/** The mode of a ZCode session for each working mode: `guarded` asks, `edit` takes edits, `yolo` asks nothing. */
const SESSION_MODES = { ask: "guarded", auto: "edit", full: "yolo" } as const satisfies Record<SessionMode, string>;

/** What happens when a tool asks for permission: the answer to a request the session still makes. */
export type ZcodePermissionPolicy = "allow" | "deny";

export interface ZcodeControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The `zcode` binary, resolved through PATH when it is a bare name. */
  readonly binary?: string;
  /** The directory that holds `cli/db/db.sqlite`: where a session to resume is asked which directory it ran in. */
  readonly home?: string;
  /** The working mode of sessions, when the caller does not choose one per start. Default: `auto`. */
  readonly mode?: SessionMode;
  /**
   * What happens when a tool asks for permission: `"allow"` (the default) grants the request,
   * `"deny"` refuses it. A session in `full` mode is never asked.
   */
  readonly permissions?: ZcodePermissionPolicy;
  /** The model sessions talk to, as `providerId/modelId`, when the caller does not choose one per start. */
  readonly model?: string;
  /** The reasoning level, when the caller does not choose one per start. */
  readonly effort?: string;
  /** How long one call waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;
  /** How long a turn waits for its end, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a graceful stop waits before each signal, in milliseconds. */
  readonly stopGraceMs?: number;
}

/** A `SessionControl` that also owns the processes it started. */
export interface ZcodeSessionControl extends SessionControl {
  /** Stops a session and the process group it owns. */
  stop(id: SessionId): Promise<void>;

  /** Stops every session this control side owns, including ones still starting. */
  dispose(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 180_000;
/** A node process that writes its database needs time to drain after its input ends. */
const DEFAULT_STOP_GRACE_MS = 1_500;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

/** The subscription kind the server takes, newest spelling first: the enum moved between bundles. */
const DELIVERY_KINDS = ["desktop-continuous", "desktop"] as const;

/** What ZCode needs inside a box: its own directory. Its model endpoint depends on the provider, so the grant names it. */
const ZCODE_NEEDS: HarnessNeeds = { write: [homePath(".zcode")], net: [] };

/**
 * One envelope: a response, a notification or a request of the server, by which fields are present.
 * ZCode's own `zcodeProtocolMessageSchema` is a union of those four that, once it is not strict, takes an
 * error for a result, so the kind of an envelope is told by its fields, here.
 */
const FrameSchema = z.looseObject({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

/** What a `session/messages` result is made of; each message is read by the snapshot's schema on its own, so one it does not know costs only itself. */
const MessagesResultSchema = z.object({ messages: z.array(z.unknown()) });

/** The result of one call. A refusal is an outcome, not a rejection. */
interface Outcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** The model a send names, and the reasoning level it thinks with. */
interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly options?: { readonly reasoningLevel: string };
}

interface TurnWait {
  readonly done: Promise<TurnEnd | undefined>;
  cancel(): void;
}

/** A request of the server that waits for the client's answer, and every id it was announced under. */
interface Asking {
  readonly requestId: string;
  readonly toolCallId: string | undefined;
  /** The server announces a request again, under a new id, while it waits: each id is answered. */
  readonly ids: Array<number | string>;
  readonly controller: AbortController;
}

/** How many answered requests are remembered, to answer an announcement that was already on its way. */
const SETTLED_LIMIT = 32;

/** A watcher gets events, then `undefined` once when the child is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** A turn that waits for the running one; an ask also waits for its answer. */
interface QueuedTurn {
  readonly text: string;
  readonly ask?: { resolve: (end: string) => void; reject: (error: unknown) => void };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

class LiveSession {
  nativeId = "";
  /** The turns niwa has started; the running one, if any, has this number. */
  turn = 0;
  busy = false;
  /** Whether the running turn's start was reported. */
  began = false;
  stopping = false;
  ended = false;
  /** The surface (servers, allow-list, deny-list) the process was given, as JSON; a resume compares it. */
  surface = "{}";
  cwd: string | undefined;
  failure: string | undefined;
  stderrTail = "";
  readonly queue: QueuedTurn[] = [];
  /** The model every send names; none when the session runs the installation's default. */
  selection: ModelSelection | undefined;
  /** The subscription kind the server took. */
  delivery: string | undefined;
  nextId = 1;
  /** Where this session's reverse requests go, when it has been given a place for them. */
  reverse: ReverseHandler | undefined;
  /** The reverse requests waiting for an answer, by the server's own id of them. */
  readonly asking = new Map<string, Asking>();
  /** The answers given to the last requests, by the server's own id of them. */
  readonly settled = new Map<string, Answered>();

  readonly watchers = new Set<Watcher>();
  /** The turn signs before anyone watched: the first watcher is given them, after it nothing is kept. */
  private unwatched: LifeEvent[] | undefined = [];
  readonly pending = new Map<number, (outcome: Outcome) => void>();
  private readonly turnWaiters: Array<(end: TurnEnd | undefined) => void> = [];

  constructor(readonly child: AgentProcess) {}

  watch(watcher: Watcher): void {
    const missed = this.unwatched ?? [];
    this.unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  /** The server stops waiting for a request, or for all of them: what they asked is no longer wanted. */
  cancelAsking(which?: { readonly requestId: string | undefined; readonly toolCallId: string | undefined }): void {
    for (const asking of [...this.asking.values()]) {
      if (which !== undefined) {
        const same = which.requestId !== undefined ? asking.requestId === which.requestId : asking.toolCallId === which.toolCallId;
        if (!same) continue;
      }
      asking.controller.abort();
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
    let waiter: (end: TurnEnd | undefined) => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drop = (): void => {
      clearTimeout(timer);
      const at = this.turnWaiters.indexOf(waiter);
      if (at !== -1) this.turnWaiters.splice(at, 1);
    };
    const done = new Promise<TurnEnd | undefined>((resolve) => {
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

  settleTurn(end: TurnEnd | undefined): void {
    for (const waiter of this.turnWaiters.splice(0)) waiter(end);
  }

  /** The child is gone: every call in flight and every waiter is released, every watcher told. */
  end(failure?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.busy = false;
    this.cancelAsking();
    const lost = this.dropQueue(failure ?? "the session ended");
    if (failure !== undefined) {
      this.failure = failure;
      this.emit({ kind: "activity", at: Date.now(), detail: failure });
    }
    if (lost > 0) {
      this.emit({ kind: "activity", at: Date.now(), detail: `${lost} queued message(s) were never delivered: the session ended` });
    }
    const reason = this.failure ?? "the session process closed";
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const settle of pending) settle({ ok: false, error: reason });
    this.settleTurn(undefined);
    for (const watcher of [...this.watchers]) watcher(undefined);
  }
}

/** The control side for ZCode. It owns every process it starts and terminates them itself. */
export function zcodeControl(options: ZcodeControlOptions): ZcodeSessionControl {
  const binary = options.binary ?? "zcode";
  const permissions = options.permissions ?? "allow";
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const harnessId = HarnessIdSchema.parse(options.harness);

  /** The sessions by id; `owned` also holds those still starting. */
  const sessions = new Map<string, LiveSession>();
  const owned = new Set<LiveSession>();
  let disposed = false;

  function unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(harnessId, "control", ability, detail);
  }

  // -- the client ----------------------------------------------------------

  function writeLine(session: LiveSession, line: string): void {
    const stdin = session.child.stdin;
    if (stdin === null || stdin.destroyed || session.stopping || session.ended) {
      throw unavailable("send", session.failure ?? "the session is not running");
    }
    stdin.write(`${line}\n`);
  }

  /** One call, matched to its answer by id. It never rejects. */
  function call(session: LiveSession, method: string, params: Record<string, unknown>): Promise<Outcome> {
    const id = session.nextId;
    session.nextId += 1;
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        if (session.pending.delete(id)) resolve({ ok: false, error: `the call ${method} timed out` });
      }, callTimeoutMs);
      session.pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      try {
        writeLine(session, JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // -- the demux ------------------------------------------------------------

  function handleLine(session: LiveSession, line: string): void {
    if (line.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      session.emit({ kind: "activity", at: Date.now(), detail: `a line of the output stream could not be read: ${String(error)}` });
      return;
    }
    const read = FrameSchema.safeParse(value);
    if (!read.success) {
      session.emit({ kind: "activity", at: Date.now(), detail: `a line of the output stream is not an envelope: ${line.slice(0, 200)}` });
      return;
    }
    const frame = read.data;
    if (frame.method === undefined) {
      if (typeof frame.id !== "number") return;
      const settle = session.pending.get(frame.id);
      if (settle === undefined) return;
      session.pending.delete(frame.id);
      settle(
        frame.error === undefined
          ? { ok: true, result: frame.result }
          : { ok: false, error: frame.error.message ?? "the call failed" },
      );
    } else if (frame.id !== undefined && frame.id !== null) {
      answerServerRequest(session, frame.id, frame.method, frame.params);
    } else {
      handleNotification(session, frame.method, frame.params);
    }
  }

  /** A message the snapshot does not know: the typed unknown, and the words of it in the log. */
  function emitUnknown(session: LiveSession, unknown: UnknownVariant): void {
    for (const sign of unknownVariantSigns(Date.now(), ZCODE_PROTOCOL, unknownVariantName(unknown), unknown.raw, unknownDetail(unknown))) {
      session.emit(sign);
    }
  }

  /**
   * Answer a request the server makes of the client, whichever it is: unanswered, the turn waits
   * forever, and an answer that does not fit the schema of its method is refused by the server.
   * What each request comes to is `requestAction`'s: a permission and a question go to the place
   * the session's reverse requests go, and a session with none answers a permission by its policy
   * and declines a question, since nobody is there to ask. A request the snapshot does not know
   * gets an empty answer, which the server takes (the language of the reply), and is told in the log.
   */
  function answerServerRequest(session: LiveSession, id: number | string, method: string, params: unknown): void {
    const read = readRequest(id, method, params);
    if (read.unknown !== undefined) emitUnknown(session, read.unknown);
    const action = requestAction(read.request, { asksQuestions: session.reverse !== undefined });
    switch (action.do) {
      case "answer":
        reply(session, [id], action.result);
        return;
      case "error":
        replyError(session, id, action.code, action.message);
        return;
      case "permission":
        if (session.reverse !== undefined) void askPermission(session, session.reverse, id, action.params, params);
        else reply(session, [id], { decision: permissions, reason: `niwa ${permissions === "allow" ? "allowed" : "denied"} this request` });
        return;
      case "user-input":
        if (session.reverse !== undefined) void askUserInput(session, session.reverse, id, action.params, params);
        else reply(session, [id], { action: "decline", reason: "niwa has no one to ask" });
        return;
      default:
        assertNever(action, "request action");
    }
  }

  /** Answer the server's requests, once each; a child that is going away has nobody to answer. */
  function reply(session: LiveSession, ids: readonly (number | string)[], result: Answered): void {
    for (const id of ids) {
      try {
        writeLine(session, JSON.stringify({ id, result }));
      } catch {
        // The child is going away; there is no one to answer.
      }
    }
  }

  /** Refuse a request the way JSON-RPC does: with an error in place of a result. */
  function replyError(session: LiveSession, id: number | string, code: number, message: string): void {
    try {
      writeLine(session, JSON.stringify({ id, error: { code, message } }));
    } catch {
      // The child is going away; there is no one to answer.
    }
  }

  /**
   * Begin to wait for the answer to a request. The server announces a request again, under a new id,
   * while it waits for it: that is the same request, answered when the first is. Nothing is returned
   * for an announcement of a request already waited for, or already answered.
   */
  function beginAsking(session: LiveSession, id: number | string, requestId: string, toolCallId: string | undefined): Asking | undefined {
    const waiting = session.asking.get(requestId);
    if (waiting !== undefined) {
      waiting.ids.push(id);
      return undefined;
    }
    const answered = session.settled.get(requestId);
    if (answered !== undefined) {
      reply(session, [id], answered);
      return undefined;
    }
    const asking: Asking = { requestId, toolCallId, ids: [id], controller: new AbortController() };
    session.asking.set(requestId, asking);
    return asking;
  }

  /** The request is answered: every id it was announced under gets the answer. */
  function endAsking(session: LiveSession, asking: Asking, answer: Answered): void {
    session.asking.delete(asking.requestId);
    session.settled.set(asking.requestId, answer);
    if (session.settled.size > SETTLED_LIMIT) {
      const oldest = session.settled.keys().next().value;
      if (oldest !== undefined) session.settled.delete(oldest);
    }
    reply(session, asking.ids, answer);
  }

  /**
   * Hand a question to the place a session's reverse requests go, and wait for the answer.
   * The server's wait is the request's: the signal is aborted when the server stops waiting. A
   * handler that fails answers nothing.
   */
  async function reverseAnswer(
    session: LiveSession,
    handler: ReverseHandler,
    asking: Asking,
    question: Question,
    raw: { readonly method: string; readonly params: unknown },
  ): Promise<Answer> {
    try {
      return await handler(makeSessionId(harnessId, session.nativeId), { question, raw, signal: asking.controller.signal });
    } catch {
      return { cancelled: true };
    }
  }

  /** A permission request, as a question for whoever answers for the session. */
  async function askPermission(
    session: LiveSession,
    handler: ReverseHandler,
    id: number | string,
    request: RequestPermissionParams,
    raw: unknown,
  ): Promise<void> {
    const read = readPermission(request);
    const asking = beginAsking(session, id, read.requestId, read.toolCallId);
    if (asking === undefined) return;
    const answer = await reverseAnswer(session, handler, asking, read.ask.question, { method: "interaction/requestPermission", params: raw });
    endAsking(session, asking, read.ask.answer(answer));
  }

  /**
   * A user input request: its questions go one by one, each as a question of its own, and the answers
   * go back together. A question left with no answer, or one the server stopped waiting for, ends the request.
   */
  async function askUserInput(
    session: LiveSession,
    handler: ReverseHandler,
    id: number | string,
    request: RequestUserInputParams,
    raw: unknown,
  ): Promise<void> {
    const read = readUserInput(request);
    const asking = beginAsking(session, id, read.requestId, read.toolCallId);
    if (asking === undefined) return;
    const texts: string[] = [];
    for (const entry of read.ask.questions) {
      const answer = asking.controller.signal.aborted
        ? ({ cancelled: true } as const)
        : await reverseAnswer(session, handler, asking, entry.question, { method: "interaction/requestUserInput", params: raw });
      const text = entry.textOf(answer);
      if (text === undefined) {
        endAsking(session, asking, INPUT_CANCELLED);
        return;
      }
      texts.push(text);
    }
    endAsking(session, asking, read.ask.answer(texts));
  }

  /**
   * The notifications of the server: the end of a turn matters, the rest is a sign of life or nothing.
   * What each comes to is `notificationAction`'s; what the snapshot does not know is told in the log.
   */
  function handleNotification(session: LiveSession, method: string, params: unknown): void {
    const read = readNotification(method, params);
    switch (read.kind) {
      case "known":
        break;
      // The conversation view of ZCode's own desktop: nothing a session's driver has use for.
      case "side-channel":
        return;
      case "unknown":
        emitUnknown(session, read.unknown);
        return;
      default:
        assertNever(read, "notification");
    }
    const notification = read.notification;
    const action = notificationAction(notification);
    // The server says it no longer waits for a request when it resolves it, by whom or why: that is
    // all niwa sees of a cancel. A subagent's request is asked under this session, so it is closed by its id.
    if (action.do === "stop-asking") {
      if (action.requestId !== undefined || action.toolCallId !== undefined) {
        session.cancelAsking({ requestId: action.requestId, toolCallId: action.toolCallId });
      }
      session.emit({ kind: "activity", at: Date.now(), detail: action.detail });
      return;
    }
    // A subagent's turn is not this session's.
    if (notification.method === "session/event" && notification.params.sessionId !== session.nativeId) return;
    switch (action.do) {
      case "end-turn":
        endTurn(session, action.end);
        return;
      case "activity":
        session.emit({ kind: "activity", at: Date.now(), detail: action.detail });
        return;
      case "ignore":
        return;
      default:
        assertNever(action, "notification action");
    }
  }

  function endTurn(session: LiveSession, end: TurnEnd): void {
    const at = Date.now();
    // The turn is over: nothing it asked is waited for any more.
    session.cancelAsking();
    // An end with no turn running ends nothing: it is a stray, and a sign of life at most.
    if (!session.busy) {
      session.emit({ kind: "activity", at, detail: `a turn ended while none was running (${end.outcome})` });
      return;
    }
    // The end of a turn that came before the answer to its send is still preceded by its start.
    if (!session.began) {
      session.began = true;
      session.emit({ kind: "turn-started", turn: session.turn, at });
    }
    session.busy = false;
    if (end.error !== undefined) session.emit({ kind: "activity", at, detail: end.error });
    session.emit({ kind: "turn-ended", turn: session.turn, at });
    session.settleTurn(end);
    // A message that waited for this turn becomes a turn of its own.
    drainQueue(session);
  }

  // -- the child ------------------------------------------------------------

  function hasExited(session: LiveSession): boolean {
    return session.child.exitCode !== null || session.child.signalCode !== null;
  }

  function signalGroup(session: LiveSession, pid: number, signal: NodeJS.Signals): void {
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

  /** Ends the input and lets the child drain, then SIGTERM to the process group, then SIGKILL. */
  async function stopSession(session: LiveSession): Promise<void> {
    const pid = session.child.pid;
    session.stopping = true;
    if (pid === undefined) {
      session.end();
      return;
    }
    if (!hasExited(session)) {
      session.child.stdin?.end();
      if (!(await waitForExit(session, stopGraceMs))) {
        signalGroup(session, pid, "SIGTERM");
        if (!(await waitForExit(session, stopGraceMs))) {
          signalGroup(session, pid, "SIGKILL");
          await waitForExit(session, stopGraceMs);
        }
      }
    }
    // What the child started may outlive the leader.
    signalGroup(session, pid, "SIGKILL");
    session.end();
  }

  /** Spawns a child and pings it. A child that does not answer is stopped. */
  async function spawnSession(
    cwd: string | undefined,
    plan: Pick<StartOptions, "env" | "box">,
  ): Promise<LiveSession> {
    if (disposed) throw unavailable("start", "the control side is disposed");
    const child = await spawnAgent({
      harness: harnessId,
      program: binary,
      args: ["app-server", "--stdio", ...(cwd === undefined ? [] : ["--cwd", cwd])],
      cwd,
      // Its own process group, so a stop reaches everything ZCode started and nothing else.
      detached: true,
      env: { ...plan.env },
      box: plan.box,
      needs: ZCODE_NEEDS,
    });
    const session = new LiveSession(child);
    owned.add(session);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        try {
          handleLine(session, line);
        } catch (error) {
          session.emit({ kind: "activity", at: Date.now(), detail: `a frame failed: ${String(error)}` });
        }
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        buffer = "";
        session.end("a line of the output stream was longer than the frame budget");
        void stopSession(session);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // A write to a dead child is reported by the closing child, not thrown as an unhandled event.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      owned.delete(session);
      session.end(`the session process failed: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      owned.delete(session);
      if (child.pid !== undefined) signalGroup(session, child.pid, "SIGKILL");
      session.end(
        session.stopping ? "the session was stopped" : `the session process exited (${code ?? signal}): ${session.stderrTail.trim()}`,
      );
    });

    const ready = await call(session, "runtime/capabilities", {});
    if (!ready.ok) {
      await stopSession(session);
      throw unavailable("start", ready.error ?? "the CLI did not answer the readiness ping");
    }
    return session;
  }

  /** Subscribes to the events of a session: without it the server streams none, and no turn can be seen to end. */
  async function subscribe(session: LiveSession): Promise<void> {
    let refusal: string | undefined;
    for (const deliveryKind of DELIVERY_KINDS) {
      const subscribed = await call(session, "session/subscribe", {
        sessionId: session.nativeId,
        deliveryKind,
        includeSnapshot: false,
      });
      if (subscribed.ok) {
        session.delivery = deliveryKind;
        return;
      }
      refusal = subscribed.error;
    }
    throw unavailable("start", refusal ?? "the CLI took no subscription to the events of the session");
  }

  // -- the turns ------------------------------------------------------------

  function promptText(prompt: Prompt): string {
    return prompt.sections.map((section) => section.text).join("\n\n");
  }

  /**
   * Ask ZCode to take a message as a turn. The wait for the turn's end is registered before the
   * request is written, so a turn that ends in the same read as its answer is not missed.
   */
  async function startTurn(session: LiveSession, text: string): Promise<{ turn: number; wait: TurnWait }> {
    if (session.busy) throw unavailable("send", "a turn is already running");
    session.turn += 1;
    session.busy = true;
    session.began = false;
    const turn = session.turn;
    const wait = session.expectTurn(turnTimeoutMs);
    const params: Record<string, unknown> = { sessionId: session.nativeId, content: text };
    if (session.selection !== undefined) params["modelSelection"] = session.selection;
    const sent = await call(session, "session/send", params);
    if (!sent.ok) {
      wait.cancel();
      session.busy = false;
      throw unavailable("send", sent.error ?? "the CLI refused the message");
    }
    if (!session.began && session.turn === turn) {
      session.began = true;
      session.emit({ kind: "turn-started", turn, at: Date.now() });
    }
    return { turn, wait };
  }

  /** Wait for a started turn; anything but a completed turn is an error. Returns its answer. */
  async function finishTurn(session: LiveSession, wait: TurnWait): Promise<string> {
    const end = await wait.done;
    if (end === undefined) throw unavailable("send", session.failure ?? "the turn did not end");
    if (end.outcome !== "completed") throw unavailable("send", `the turn was ${end.outcome}: ${end.error ?? "no reason given"}`);
    return end.response !== "" ? end.response : await lastAnswer(session);
  }

  /** The last assistant text of the session, read back when the end of the turn carried none. */
  async function lastAnswer(session: LiveSession): Promise<string> {
    const read = await call(session, "session/messages", { sessionId: session.nativeId });
    const messages = MessagesResultSchema.safeParse(read.result);
    if (!read.ok || !messages.success) return "";
    let answer = "";
    for (const item of messages.data.messages) {
      const message = SessionMessageSchema.safeParse(item);
      if (!message.success) {
        // One message the snapshot does not know costs that message, not the answer.
        const unknown: UnknownVariant = { protocol: "zcode", discriminator: "method", value: "session/messages", why: "does not fit the snapshot", raw: item };
        emitUnknown(session, unknown);
        continue;
      }
      if (message.data.info.role !== "assistant") continue;
      const text = message.data.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      if (text.trim() !== "") answer = text;
    }
    return answer;
  }

  async function runTurn(session: LiveSession, text: string): Promise<string> {
    const { wait } = await startTurn(session, text);
    return finishTurn(session, wait);
  }

  /**
   * Starts the turn that waited for the turn that just ended, in the order the messages came.
   * The caller of a message does not wait for its turn; the caller of an ask waits for the answer.
   */
  function drainQueue(session: LiveSession): void {
    if (session.ended || session.stopping) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    void startTurn(session, next.text)
      .then(({ wait }) => {
        if (next.ask === undefined) {
          wait.cancel();
          return undefined;
        }
        return finishTurn(session, wait).then(next.ask.resolve, next.ask.reject);
      })
      .catch((error: unknown) => {
        next.ask?.reject(error);
        session.emit({ kind: "activity", at: Date.now(), detail: `a queued message could not be started: ${String(error)}` });
        // The messages behind it still wait for a turn of their own.
        drainQueue(session);
      });
  }

  /** Deliver a message the way a send does and say what became of it; nothing waits for the turn to end. */
  async function deliver(session: LiveSession, message: string): Promise<DeliveryReceipt> {
    const at = Date.now();
    if (session.busy) {
      session.queue.push({ text: message });
      return { status: "queued", turn: session.turn + session.queue.length, at };
    }
    const { turn, wait } = await startTurn(session, message);
    wait.cancel();
    return { status: "started", turn, at };
  }

  function requireSession(id: SessionId, ability: string): LiveSession {
    const session = sessions.get(id.native);
    if (session === undefined) throw unavailable(ability, `the session ${id.native} is not held by this control side`);
    return session;
  }

  /** The model and level a session's sends name; `reported` is the model the server says the session has. */
  function selectionOf(model: string | undefined, effort: string | undefined, reported: ModelRef | undefined): ModelSelection | undefined {
    const ref = model === undefined || model === "" ? reported : parseModel(harnessId, model);
    const level = effort === undefined || effort === "" ? undefined : effort;
    if (ref === undefined) {
      if (level === undefined) return undefined;
      throw new Unsupported(harnessId, "control", "start", `the effort "${level}" needs a model: none was chosen and the CLI named none`);
    }
    // No model chosen and no level: the session runs what the installation has, and the sends say nothing.
    if (ref === reported && level === undefined) return undefined;
    return { ...ref, ...(level === undefined ? {} : { options: { reasoningLevel: level } }) };
  }

  const wire = (cwd: string): { workspace: { workspacePath: string; workspaceKey: string } } => ({
    workspace: { workspacePath: cwd, workspaceKey: cwd },
  });

  /**
   * The model the snapshot of a session names is the model it runs only when no model was asked
   * for: a model that was asked for goes with every send, and ZCode names none back, so the
   * model of such a session is not known and the request is not taken for it.
   */
  function reportModel(session: LiveSession, asked: string | undefined, reported: ModelRef | undefined): void {
    if ((asked === undefined || asked === "") && reported !== undefined) {
      session.emit({ kind: "model", model: modelName(`${reported.providerId}/${reported.modelId}`) });
    }
  }

  // -- the contract ---------------------------------------------------------

  return {
    async start(startOptions: StartOptions): Promise<StartedSession> {
      // Everything ZCode cannot do is refused before the child is spawned.
      const model = startOptions.model ?? options.model;
      const effort = startOptions.effort ?? options.effort;
      const mode = modeOf(startOptions.mode, options.mode, ZCODE_LAUNCH);
      requireLaunch(harnessId, ZCODE_LAUNCH, { model, effort, mode });
      const surface = surfaceOf(startOptions.servers, startOptions.tools, startOptions.visible);
      if (model !== undefined && model !== "") parseModel(harnessId, model);
      const cwd = startOptions.cwd ?? process.cwd();

      const session = await spawnSession(cwd, startOptions);
      session.cwd = cwd;
      session.reverse = startOptions.reverse;
      session.surface = JSON.stringify(surface);
      try {
        const created = await call(session, "session/create", {
          ...wire(cwd),
          // The mode is always named: left out, the session would take the one the user's or the project's config sets.
          mode: SESSION_MODES[mode],
          ...surface,
        });
        if (!created.ok) throw unavailable("start", created.error ?? "the CLI did not create a session");
        const snapshot = asRecord(asRecord(created.result)["session"]);
        const native = stringOf(snapshot["sessionId"]);
        if (native === undefined) throw unavailable("start", "the CLI created a session without naming it");
        session.nativeId = native;
        const reported = modelRefOf(snapshot["model"]);
        session.selection = selectionOf(model, effort, reported);
        reportModel(session, model, reported);
        sessions.set(native, session);
        await subscribe(session);
      } catch (error) {
        sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
      const id = makeSessionId(harnessId, session.nativeId);
      // The session exists once ZCode has named it. The prompt is its first turn, delivered like a
      // send: the start waits for ZCode to accept the turn, never for the turn to end.
      const text = promptText(startOptions.prompt);
      if (text === "") return { session: id, mode };
      try {
        return { session: id, first: await deliver(session, text), mode };
      } catch (error) {
        sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
    },

    async resume(id: SessionId, resumeOptions?: ResumeOptions): Promise<void> {
      const surface = surfaceOf(resumeOptions?.servers, resumeOptions?.tools, resumeOptions?.visible);
      const text = resumeOptions?.prompt === undefined ? "" : promptText(resumeOptions.prompt);

      // A held session continues in its own child: a second child would be a second writer.
      const held = sessions.get(id.native);
      let carried: Watcher[] = [];
      if (held !== undefined && !held.ended && !held.stopping) {
        if (resumeOptions?.box !== undefined) throw new Unsupported(harnessId, "control", "resume", LIVE_PROCESS_REFUSAL);
        // The one who resumes names where its reverse requests go from now on.
        if (resumeOptions?.reverse !== undefined) held.reverse = resumeOptions.reverse;
        // What the process was born with is what it keeps: a surface that is the same changes
        // nothing, and one that differs is given to a new process, which takes the session on
        // again. That cannot be done under a running turn.
        const changed = Object.keys(surface).length > 0 && JSON.stringify(surface) !== held.surface;
        if (!changed) {
          if (text === "") return;
          // The prompt of a resume waits behind a running turn, as a send does; it is not an error.
          if (held.busy) held.queue.push({ text });
          else await runTurn(held, text);
          return;
        }
        if (held.busy) {
          throw unavailable("resume", "a turn is running: the servers and tools of the session change only when it is idle");
        }
        // The watchers follow the session, not the process: they are handed to the new one.
        carried = [...held.watchers];
        held.watchers.clear();
        sessions.delete(id.native);
        await stopSession(held);
      }

      // The session is resumed in the directory it ran in; one the database does not know is
      // resumed where this process is, and the CLI says whether it has it.
      const cwd = (options.home === undefined ? undefined : directoryOf(options.home, id.native)) ?? held?.cwd ?? process.cwd();
      let session: LiveSession;
      try {
        session = await spawnSession(cwd, resumeOptions ?? {});
      } catch (error) {
        for (const watcher of carried) watcher(undefined);
        throw error;
      }
      session.cwd = cwd;
      session.reverse = resumeOptions?.reverse ?? held?.reverse;
      session.surface = JSON.stringify(surface);
      try {
        const resumed = await call(session, "session/resume", { sessionId: id.native, ...wire(cwd), ...surface });
        if (!resumed.ok) throw unavailable("resume", resumed.error ?? "the CLI did not resume the session");
        // ZCode restores the mode of a resumed session itself, from its last assistant message (the
        // project's default when it has none), and a resume names none: a session that comes back in
        // another mode than niwa started it in is not run.
        if (resumeOptions?.mode !== undefined) {
          const wanted = SESSION_MODES[resumeOptions.mode];
          const restored = options.home === undefined ? undefined : persistedModeOf(options.home, id.native);
          if (restored === undefined) {
            throw unavailable("resume", `the mode ZCode restores the session in cannot be read, so it cannot be compared with "${wanted}" (${resumeOptions.mode}); it was not resumed`);
          }
          if (restored !== wanted) {
            throw unavailable(
              "resume",
              `ZCode restores the session in the mode "${restored}", but niwa started it in "${wanted}" (${resumeOptions.mode}); it was not resumed`,
            );
          }
        }
        session.nativeId = id.native;
        const asked = resumeOptions?.model ?? options.model;
        const reported = modelRefOf(asRecord(asRecord(resumed.result)["session"])["model"]);
        session.selection = selectionOf(asked, options.effort, reported);
        reportModel(session, asked, reported);
        sessions.set(id.native, session);
        await subscribe(session);
        for (const watcher of carried) session.watch(watcher);
        carried = [];
      } catch (error) {
        sessions.delete(id.native);
        await stopSession(session);
        for (const watcher of carried) watcher(undefined);
        throw error;
      }
      if (text !== "") await runTurn(session, text);
    },

    async send(id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> {
      const session = requireSession(id, "send");
      // A send during a running turn is steered into it by ZCode itself: only a caller that asks for it gets that.
      if (session.busy && sendOptions?.into === "turn") {
        const at = Date.now();
        const params: Record<string, unknown> = { sessionId: id.native, content: message };
        if (session.selection !== undefined) params["modelSelection"] = session.selection;
        const steered = await call(session, "session/send", params);
        if (!steered.ok) throw unavailable("send", steered.error ?? "the CLI refused the message");
        return { status: "delivered", turn: session.turn, at };
      }
      return deliver(session, message);
    },

    async interrupt(id: SessionId): Promise<void> {
      const session = requireSession(id, "interrupt");
      if (!session.busy) throw unavailable("interrupt", "no turn is running");
      // An explicit stop clears the queue: the messages that waited behind a turn the caller
      // just stopped must not fire as a surprise.
      session.dropQueue("the turn was interrupted");
      // `session/stop` bypasses the queue of the server, so it lands while the turn streams.
      const stopped = await call(session, "session/stop", { sessionId: id.native });
      if (!stopped.ok) throw unavailable("interrupt", stopped.error ?? "the CLI refused the interrupt");
      // A stopped turn waits for nothing, and the server says so on no wire.
      session.cancelAsking();
    },

    async ask<T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> {
      const session = requireSession(id, "ask");
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
      const text = session.busy
        ? await new Promise<string>((resolve, reject) => {
            session.queue.push({ text: instruction, ask: { resolve, reject } });
          })
        : await runTurn(session, instruction);
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
          session.watch(watcher);
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
            session.watchers.delete(watcher);
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

    async stop(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      sessions.delete(id.native);
      await stopSession(session);
    },

    async dispose(): Promise<void> {
      disposed = true;
      sessions.clear();
      await Promise.all([...owned].map((session) => stopSession(session)));
    },
  };
}

/** A model as ZCode names it: the provider and the model in it. */
interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

/** `providerId/modelId`, split at the first slash: a model id may hold slashes of its own. */
function parseModel(harness: HarnessId, model: string): ModelRef {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Unsupported(harness, "control", "start", `a model is named "providerId/modelId", not "${model}"`);
  }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** The model a snapshot of a session names. */
function modelRefOf(value: unknown): ModelRef | undefined {
  const record = asRecord(value);
  const providerId = stringOf(record["providerId"]);
  const modelId = stringOf(record["modelId"]);
  return providerId === undefined || modelId === undefined ? undefined : { providerId, modelId };
}

/**
 * What `session/create` and `session/resume` take of a session's surface (ZCode's
 * `zcodeSessionCreateParamsSchema` and `zcodeSessionResumeParamsSchema`): `mcpServers`, with each
 * `env` as `[{name, value}]` rather than a record, `toolAllowlist` and `toolDenylist`. A resume
 * takes the same three, because a cold resume rebuilds the runtime and would drop them otherwise.
 * The keys are left out when empty, so a session with nothing asked for sends what it always did.
 *
 * niwa's tool mode is the allow-list (`niwa-only` names none of ZCode's own tools) and the
 * `disabledTools` of the visible actions the deny-list; both are the harness's own tool names. ZCode's allow-list is an exact-name filter on
 * every tool of the session, the MCP tools (`mcp__<server>__<tool>`) among them. So when there is
 * an allow-list, the tools niwa knows its servers list (`McpServerSpec.tools`: niwa's own server)
 * are appended to it as `mcp__<server>__<tool>`; a foreign server lists none here, and its tools
 * pass only when the allow-list names them itself.
 */
function surfaceOf(
  servers: readonly McpServerSpec[] | undefined,
  mode: ToolsMode | undefined,
  visible: VisibleActions | undefined,
): Record<string, unknown> {
  const denied = visible?.disabledTools ?? [];
  const hasServers = servers !== undefined && servers.length > 0;
  // Only niwa's tools is an allow-list of none of ZCode's own.
  const own = mode === undefined || mode === "all" ? undefined : mode === "niwa-only" ? [] : mode.allow;
  const served =
    own === undefined
      ? []
      : (servers ?? []).flatMap((server) => (server.tools ?? []).map((tool) => `mcp__${server.name}__${tool}`));
  const allowed = own === undefined ? undefined : [...new Set([...own, ...served])];
  return {
    ...(hasServers
      ? {
          mcpServers: servers.map((server) => ({
            name: server.name,
            command: server.command,
            args: [...server.args],
            env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
            ...server.zcode,
          })),
        }
      : {}),
    ...(allowed === undefined ? {} : { toolAllowlist: allowed }),
    ...(denied.length === 0 ? {} : { toolDenylist: [...denied] }),
  };
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
