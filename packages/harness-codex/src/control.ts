/**
 * The control side for Codex: how niwa starts, steers and stops sessions over
 * `codex app-server` JSON-RPC.
 *
 * Each session owns one child in its own process group. The native session id is Codex's own
 * thread id. A message to a busy session is queued by default and becomes a turn of its own
 * when the current turn ends; only a caller that asks for it is steered into the running turn.
 * Every receipt reports what happened: `queued` after the current turn, `delivered` when
 * `turn/steer` was accepted, `started` when `turn/start` was accepted, and a turn that did not
 * complete is an error, never a success.
 */

import { existsSync } from "node:fs";

import { z } from "zod";

import { assertNever, stableJson, timestamp } from "@niwa-labs/core";
import type { Answer, Question } from "@niwa-labs/core";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  LifeEvent,
  McpServerSpec,
  Prompt,
  ResumeOptions,
  SendOptions,
  SessionControl,
  SessionState,
  StartOptions,
  StartedSession,
  VisibleActions,
  LaunchCapabilities,
  SessionMode,
  HarnessId,
  SessionId,
  ReverseHandler,
  ToolsMode,
  TurnOutcome,
  Dispatch,
} from "@niwa-labs/harness";
import {
  InputNotSent,
  InputPossiblySent,
  inputFailure,
  DEFAULT_TURN_TIMEOUT_MS,
  describeToolsMode,
  modelName,
  unknownVariantSigns,
  modeOf,
  requireLaunch,
  Unavailable,
  Unsupported,
  HarnessIdSchema,
  sessionId as makeSessionId,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, sandboxOf, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess } from "@niwa-labs/sandbox";

import { incomingOf, incomingOfDrifted } from "./incoming.ts";
import type { EndedTurn, Incoming } from "./incoming.ts";
import { CODEX_PROTOCOL, readFrame } from "./protocol/index.ts";
import type { UnknownFrame } from "./protocol/index.ts";
import type { RequestId, ServerRequest } from "./protocol/generated/app-server.ts";
import { refusalOf } from "./refusals.ts";
import type { Reply } from "./refusals.ts";
import { approvalOf, elicitationOf, userAnswerOf, userQuestionsOf } from "./reverse.ts";
import type { ReversedRequest } from "./reverse.ts";

/** macOS ships a public CA bundle that a read-closed nono box can use without the Keychain. */
function boxedCertificate(plan: Pick<StartOptions, "env" | "box">): Record<string, string> {
  if (process.platform !== "darwin" || !plan.box || sandboxOf(plan.box.sandbox).name !== "nono") return {};
  const env = { ...plan.box.spec.env, ...plan.env };
  if (env["CODEX_CA_CERTIFICATE"] !== undefined || env["SSL_CERT_FILE"] !== undefined) return {};
  const certificate = "/etc/ssl/cert.pem";
  return existsSync(certificate) ? { CODEX_CA_CERTIFICATE: certificate } : {};
}

/** What a Codex session takes at launch: a model, an effort that is sent with every turn, and a working mode. */
export const CODEX_LAUNCH: LaunchCapabilities = {
  model: true,
  effort: ["low", "medium", "high", "xhigh"],
  modes: ["ask", "auto", "full"],
};

/**
 * What a working mode is to Codex, at `thread/start` and `thread/resume`: `ask` may read and asks
 * to do anything else, `auto` writes in the workspace (the working directory) and asks to leave
 * it, `full` has the machine and asks nothing.
 */
const THREAD_MODES = {
  ask: { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
} as const satisfies Record<SessionMode, { approvalPolicy: string; sandbox: string }>;

/** The network is open inside the workspace-write sandbox of `auto`; Codex closes it by default. */
const AUTO_NETWORK = { "sandbox_workspace_write.network_access": true } as const;

export interface CodexControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The `codex` binary, resolved through PATH when it is a bare name. */
  readonly binary?: string;
  /**
   * The home of the installation its sessions belong to: every process is started with it as
   * `CODEX_HOME`. A kind sets it from the home it reads, so a session started here is one that is
   * listed and read there, and its profile gives a box that home. Without it the process keeps the
   * environment it inherits.
   */
  readonly home?: string;
  /** The model sessions talk to, when the caller does not choose one per start. */
  readonly model?: string;
  /** The effort sessions think with, when the caller does not choose one per start. */
  readonly effort?: string;
  /** The working mode of sessions, when the caller does not choose one per start. Default: `auto`. */
  readonly mode?: SessionMode;
  /** How long one JSON-RPC call waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;
  /** How long a turn waits for its end, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a graceful stop waits before the hard kill, in milliseconds. */
  readonly stopGraceMs?: number;
}

/** A `SessionControl` that also owns the processes it started. */
export interface CodexSessionControl extends SessionControl {
  /** Stops a session and the process group it owns. */
  stop(id: SessionId): Promise<void>;

  /** Stops every session this control side owns, including ones still starting. */
  dispose(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_GRACE_MS = 200;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

/** The result of one JSON-RPC call. A refusal is an outcome, not a rejection. */
interface RpcOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  /** How far a call that failed got: never written, refused by Codex, or written and never answered. */
  readonly dispatch?: Dispatch;
}

/** A watcher gets events, then `undefined` once when the child is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** A turn's end: the turn Codex reported and the answer it gave. */
interface TurnEnd {
  readonly turn: EndedTurn | undefined;
  readonly text: string;
}

/** A turn's end: the turn Codex reported, or `undefined` when it timed out or the child died. */
interface TurnWait {
  readonly done: Promise<TurnEnd | undefined>;
  cancel(): void;
}

interface TurnWaiter {
  readonly settle: (end: TurnEnd | undefined) => void;
}

type TurnNotification = Extract<Incoming, { kind: "turn-started" | "turn-ended" | "answer" }>;
type EarlyTurnEvent = { event: TurnNotification; at: number } | { sign: LifeEvent };

function turnIdOf(event: TurnNotification): string | undefined {
  if (event.kind === "turn-ended") return event.turn.id;
  return event.turnId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** How a turn ended, in the words every harness shares: a turn Codex stopped or failed did not complete, and a status this build does not know proves nothing. */
function outcomeOfTurn(turn: EndedTurn): TurnOutcome {
  switch (turn.status) {
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return "unknown";
  }
}

function idOf(value: unknown): string | undefined {
  const id = asRecord(value).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** A turn that waits for the running one; an ask also waits for its answer. */
interface QueuedTurn {
  readonly turn: number;
  readonly text: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly ask?: { resolve: (answer: string) => void; reject: (error: unknown) => void };
}

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

/** How many file-change items are remembered, to tell what an approval of one is about. */
const FILE_CHANGES_KEPT = 64;

class LiveSession {
  nativeId = "";
  /** The turns niwa has started; the running one, if any, has this number. */
  turn = 0;
  assigned = 0;
  /** The id Codex gave the running turn. */
  activeTurnId: string | undefined;
  turnStartEmitted = false;
  readonly endedTurnIds = new Set<string>();
  earlyTurnEvents: EarlyTurnEvent[] = [];
  busy = false;
  stopping = false;
  ended = false;
  failure: string | undefined;
  stderrTail = "";
  /** The last final answer of the running turn, or of the last turn that ended. */
  text = "";
  /** The turns that wait for the turn after the running one, in the order they came. */
  readonly queue: QueuedTurn[] = [];
  /** The effort the session was started with: it goes with every turn, and never changes. */
  effort: string | undefined;
  /** The config the thread was started with; a held thread cannot take another one. */
  config: Record<string, unknown> | undefined;
  nextId = 1;
  /** Where this session's reverse requests go, when it has been given a place for them. */
  reverse: ReverseHandler | undefined;
  /** The paths of the file changes Codex announced, by item id: what an approval of one is about. */
  readonly fileChanges = new Map<string, readonly string[]>();
  /** The reverse requests waiting for an answer, each with the request id of Codex: aborted when Codex stops waiting. */
  private readonly asking = new Map<AbortController, number | string>();

  readonly watchers = new Set<Watcher>();
  /**
   * The turn signs before anyone watched: a turn can run inside `start`, before the caller has
   * the session to watch. The first watcher is given them; after it nothing is kept.
   */
  private unwatched: LifeEvent[] | undefined = [];
  readonly pending = new Map<number, (outcome: RpcOutcome) => void>();
  private readonly turnWaiters: TurnWaiter[] = [];

  constructor(readonly child: AgentProcess) {}

  /** Watch the signs of life; the first watcher also gets the turn signs that came before it. */
  watch(watcher: Watcher): void {
    const missed = this.unwatched ?? [];
    this.unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  rememberFileChange(itemId: string, paths: readonly string[]): void {
    this.fileChanges.set(itemId, paths);
    if (this.fileChanges.size > FILE_CHANGES_KEPT) {
      const oldest = this.fileChanges.keys().next().value;
      if (oldest !== undefined) this.fileChanges.delete(oldest);
    }
  }

  /** A reverse request begins to wait: the signal is aborted when Codex stops waiting for it. */
  startAsking(requestId: number | string): { readonly signal: AbortSignal; readonly done: () => void } {
    const controller = new AbortController();
    this.asking.set(controller, requestId);
    return { signal: controller.signal, done: () => this.asking.delete(controller) };
  }

  /** Codex no longer waits for one request, or for any of them. */
  cancelAsking(requestId?: number | string): void {
    for (const [controller, asked] of [...this.asking]) {
      if (requestId !== undefined && asked !== requestId) continue;
      this.asking.delete(controller);
      controller.abort();
    }
  }

  /** Fail every queued ask, and drop the queue; returns how many turns were dropped. */
  dropQueue(reason: string): number {
    const dropped = this.queue.splice(0);
    for (const entry of dropped) {
      entry.ask?.reject(new Error(reason));
      this.emit({ kind: "turn-discarded", turn: entry.turn });
    }
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: TurnWaiter | undefined;
    const drop = (): void => {
      clearTimeout(timer);
      const at = waiter === undefined ? -1 : this.turnWaiters.indexOf(waiter);
      if (at !== -1) this.turnWaiters.splice(at, 1);
    };
    const done = new Promise<TurnEnd | undefined>((resolve) => {
      waiter = {
        settle: (end) => {
          clearTimeout(timer);
          resolve(end);
        },
      };
      this.turnWaiters.push(waiter);
      timer = setTimeout(() => {
        drop();
        resolve(undefined);
      }, timeoutMs);
    });
    return {
      done,
      cancel: drop,
    };
  }

  /** The current turn ended, or the child went away. Settle before starting the next turn. */
  settleTurn(turn: EndedTurn | undefined): void {
    // The answer of the turn that ends is the text as it stands now; the next turn clears it.
    const end: TurnEnd = { turn, text: this.text };
    const waiting = this.turnWaiters.splice(0);
    for (const waiter of waiting) waiter.settle(end);
  }

  /** The child is gone: every call in flight and every waiter is released, every watcher told. */
  end(failure?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.busy = false;
    this.activeTurnId = undefined;
    for (const entry of this.earlyTurnEvents) if ("sign" in entry) this.emit(entry.sign);
    this.earlyTurnEvents = [];
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
    for (const settle of pending) settle({ ok: false, error: reason, dispatch: "uncertain" });
    this.settleTurn(undefined);
    for (const watcher of [...this.watchers]) watcher(undefined);
  }
}

/** The control side for Codex. It owns every process it starts and terminates them itself. */
export function codexControl(options: CodexControlOptions): CodexSessionControl {
  const binary = options.binary ?? "codex";
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const defaultModel = options.model;
  const defaultEffort = options.effort;
  const harnessId = HarnessIdSchema.parse(options.harness);

  /** The sessions by thread id; `owned` also holds those still starting. */
  const sessions = new Map<string, LiveSession>();
  const owned = new Set<LiveSession>();
  /** The processes being created: one that is not yet a session is still the control side's to stop. */
  const spawning = new Set<Promise<AgentProcess>>();
  /** The launch of each thread that is being brought up: a thread has one writer, so a second launch waits for the first. */
  const launching = new Map<string, Promise<void>>();
  let disposed = false;

  function unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(harnessId, "control", ability, detail);
  }

  // -- the JSON-RPC client --------------------------------------------------

  function writeLine(session: LiveSession, line: string): void {
    const stdin = session.child.stdin;
    if (stdin === null || stdin.destroyed || session.stopping || session.ended) {
      throw unavailable("send", session.failure ?? "the session is not running");
    }
    stdin.write(`${line}\n`);
  }

  /** One call, matched to its answer by id. It never rejects. */
  function call(
    session: LiveSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcOutcome> {
    const id = session.nextId;
    session.nextId += 1;
    return new Promise<RpcOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (session.pending.delete(id)) resolve({ ok: false, error: `the call ${method} timed out`, dispatch: "uncertain" });
      }, callTimeoutMs);
      session.pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      try {
        writeLine(session, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error), dispatch: "unsent" });
      }
    });
  }

  // -- the demux ------------------------------------------------------------

  function handleLine(session: LiveSession, line: string): void {
    if (line.length === 0) return;
    const frame = readFrame(line);
    const at = Date.now();
    switch (frame.kind) {
      case "response":
        settleCall(session, frame.id, { ok: true, result: frame.result });
        return;
      case "failure":
        settleCall(session, frame.id, { ok: false, error: frame.error.message, dispatch: "refused" });
        return;
      case "notification":
        apply(session, incomingOf(frame.notification), at);
        return;
      case "request":
        answerServerRequest(session, frame.id, frame.request);
        return;
      case "unknown":
        handleUnknown(session, frame, at);
        return;
      case "unreadable":
        publishNotification(session, { kind: "activity", at, detail: frame.reason });
        return;
      default:
        assertNever(frame, "codex frame");
    }
  }

  /** The answer to a call of ours; one for a call nobody waits for any more is dropped. */
  function settleCall(session: LiveSession, id: RequestId, outcome: RpcOutcome): void {
    if (typeof id !== "number") return;
    const settle = session.pending.get(id);
    if (settle === undefined) return;
    session.pending.delete(id);
    settle(outcome);
  }

  /**
   * A message that is not in the snapshot: Codex got newer. It is reported, and the session goes on:
   * a request is still answered, and a turn that began or ended is still known to have.
   */
  function handleUnknown(session: LiveSession, frame: UnknownFrame, at: number): void {
    for (const sign of unknownVariantSigns(at, CODEX_PROTOCOL, frame.variant, frame.raw, frame.method)) publishNotification(session, sign);
    if (frame.id !== undefined) {
      writeReply(session, frame.id, refusalOf(frame.method));
      return;
    }
    const drifted = incomingOfDrifted(frame.method, frame.params);
    if (drifted !== undefined) apply(session, drifted, at);
  }

  /**
   * Answer a request Codex makes of the client; unanswered, the turn waits forever. A session that
   * has a place for its reverse requests sends approvals and questions there. Any other has nobody
   * to ask, so nothing is escalated: the request is refused (`./refusals.ts`).
   */
  function answerServerRequest(session: LiveSession, id: RequestId, request: ServerRequest): void {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
        if (session.reverse !== undefined) {
          void askReverse(session, session.reverse, id, request);
          return;
        }
        break;
      case "item/tool/requestUserInput":
        // An answer to a secret question would be kept in clear text with every other answer, and
        // nothing yet asks for input that is hidden: such a request is refused, never asked.
        if (session.reverse !== undefined && !request.params.questions.some((asked) => asked.isSecret)) {
          void askReverse(session, session.reverse, id, request);
          return;
        }
        break;
      case "mcpServer/elicitation/request":
        // A form niwa cannot ask a person (a link, a form of OpenAI's own kind) is refused like the rest.
        if (session.reverse !== undefined && elicitationOf(request) !== undefined) {
          void askReverse(session, session.reverse, id, request);
          return;
        }
        break;
      // Nobody is asked about these: they are refused. The words of each refusal, and why, are in `./refusals.ts`.
      case "item/tool/call":
      case "applyPatchApproval":
      case "execCommandApproval":
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
        break;
      default:
        assertNever(request, "codex server request");
    }
    writeReply(session, id, refusalOf(request.method));
  }

  /**
   * A request of Codex that waits for a person, sent to where the session's reverse requests go.
   * Codex is always answered, so a turn never hangs.
   */
  async function askReverse(
    session: LiveSession,
    handler: ReverseHandler,
    id: RequestId,
    request: ReversedRequest,
  ): Promise<void> {
    const raw = { method: request.method, params: request.params };
    const ask = async (question: Question): Promise<Answer> => {
      const asking = session.startAsking(id);
      try {
        return await handler(makeSessionId(harnessId, session.nativeId), { question, raw, signal: asking.signal });
      } catch {
        return { cancelled: true };
      } finally {
        asking.done();
      }
    };

    let reply: Reply;
    if (request.method === "item/tool/requestUserInput") {
      // One question after the other; one left unanswered ends the call with no answers.
      const asked = userQuestionsOf(request.params);
      const answers: Record<string, { answers: string[] }> = {};
      for (const { id: questionId, question } of asked) {
        const given = userAnswerOf(question, await ask(question));
        if (given === undefined) break;
        answers[questionId] = { answers: given };
      }
      reply = { result: { answers: Object.keys(answers).length === asked.length ? answers : {} } };
    } else if (request.method === "mcpServer/elicitation/request") {
      const elicitation = elicitationOf(request);
      reply = elicitation === undefined ? refusalOf(request.method) : { result: elicitation.reply(await ask(elicitation.question)) };
    } else {
      const approval = approvalOf(request, session.fileChanges.get(request.params.itemId));
      reply = { result: approval.reply(await ask(approval.question)) };
    }
    writeReply(session, id, reply);
  }

  /** A frame that nobody waits to see written: a reply, or the `initialized` notice. */
  function writeFrame(session: LiveSession, frame: Record<string, unknown>): void {
    try {
      writeLine(session, JSON.stringify({ jsonrpc: "2.0", ...frame }));
    } catch {
      // The child is going away; there is no one to answer.
    }
  }

  function writeReply(session: LiveSession, id: RequestId, reply: Reply): void {
    writeFrame(session, { id, ...reply });
  }

  /** Keep diagnostics and other signs in wire order with notifications awaiting turn identity. */
  function publishNotification(session: LiveSession, sign: LifeEvent): void {
    if (session.busy && session.activeTurnId === undefined) session.earlyTurnEvents.push({ sign });
    else session.emit(sign);
  }

  /** Reverse-request bookkeeping stays live while publication waits for the turn ID. */
  function apply(session: LiveSession, incoming: Incoming, at: number, replaying = false): void {
    if (incoming.kind === "turn-started" || incoming.kind === "turn-ended" || incoming.kind === "answer") {
      if (!session.busy) return;
      const id = turnIdOf(incoming);
      if (id === undefined || session.endedTurnIds.has(id)) return;
      if (session.activeTurnId === undefined) {
        session.earlyTurnEvents.push({ event: incoming, at });
        return;
      }
      if (id !== session.activeTurnId) return;
    }
    switch (incoming.kind) {
      case "turn-started":
        if (session.turnStartEmitted) return;
        session.turnStartEmitted = true;
        session.emit({ kind: "turn-started", turn: session.turn, at });
        return;
      case "turn-ended":
        if (incoming.turn.id !== undefined) session.endedTurnIds.add(incoming.turn.id);
        session.activeTurnId = undefined;
        session.busy = false;
        session.cancelAsking();
        session.emit({ kind: "turn-ended", turn: session.turn, at, outcome: outcomeOfTurn(incoming.turn), answer: session.text });
        session.settleTurn(incoming.turn);
        // A message that waited for this turn becomes a turn of its own.
        if (!replaying) drainQueue(session);
        return;
      case "file-change":
        session.rememberFileChange(incoming.itemId, incoming.paths);
        break;
      case "answer":
        session.text = incoming.text;
        break;
      case "rerouted":
        // Codex moved the turn to another model: that is the model the session runs from now on.
        if (incoming.toModel !== "") publishNotification(session, { kind: "model", model: modelName(incoming.toModel) });
        break;
      case "request-resolved":
        // Codex answered the request itself (the turn was interrupted, a policy decided): nobody waits.
        session.cancelAsking(incoming.requestId);
        break;
      case "sign":
        break;
      case "ignored":
        return;
      default:
        assertNever(incoming, "codex incoming");
    }
    publishNotification(session, { kind: "activity", at, detail: incoming.detail });
  }

  // -- the child ------------------------------------------------------------

  /** Spawns a child and runs the handshake. A child that fails the handshake is stopped. */
  async function spawnSession(
    cwd: string | undefined,
    plan: Pick<StartOptions, "env" | "tools" | "box">,
    ability: "start" | "resume" = "start",
  ): Promise<LiveSession> {
    if (disposed) throw unavailable("start", "the control side is disposed");
    // A tool mode Codex cannot hold is refused before the child exists.
    requireCodexTools(harnessId, ability, plan.tools);
    const creating = spawnAgent({
      harness: harnessId,
      program: binary,
      args: ["app-server", "--stdio"],
      cwd,
      // Its own process group, so a stop reaches everything Codex started and nothing else.
      detached: true,
      env: {
        ...boxedCertificate(plan),
        ...plan.env,
        ...(options.home === undefined ? {} : { CODEX_HOME: options.home }),
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DO_NOT_TRACK: "1",
      },
      box: plan.box,
    });
    spawning.add(creating);
    let child: AgentProcess;
    try {
      child = await creating;
    } finally {
      spawning.delete(creating);
    }
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
          publishNotification(session, { kind: "activity", at: Date.now(), detail: `a frame failed: ${String(error)}` });
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
      // Whatever Codex started may outlive it; the group is the unit of cleanup.
      if (child.pid !== undefined) signalGroup(session, child.pid, "SIGKILL");
      session.end(
        session.stopping
          ? "the session was stopped"
          : `the session process exited (${code ?? signal}): ${session.stderrTail.trim()}`,
      );
    });

    // A control side disposed while the process was being created owns it all the same.
    if (disposed) {
      await stopSession(session);
      throw unavailable(ability, "the control side is disposed");
    }
    const initialized = await call(session, "initialize", {
      clientInfo: { name: "niwa", title: "niwa", version: "0.1.0" },
    });
    if (!initialized.ok) {
      await stopSession(session);
      throw unavailable("start", initialized.error ?? "the CLI did not answer the handshake");
    }
    writeFrame(session, { method: "initialized", params: {} });
    return session;
  }

  // -- stopping -------------------------------------------------------------

  function hasExited(session: LiveSession): boolean {
    return session.child.exitCode !== null || session.child.signalCode !== null;
  }

  /** SIGTERM to the process group, then SIGKILL. Returns once the child is gone. */
  async function stopSession(session: LiveSession): Promise<void> {
    const pid = session.child.pid;
    session.stopping = true;
    if (pid === undefined) {
      session.end();
      return;
    }
    if (!hasExited(session)) {
      session.child.stdin?.end();
      signalGroup(session, pid, "SIGTERM");
      if (!(await waitForExit(session, stopGraceMs))) {
        signalGroup(session, pid, "SIGKILL");
        await waitForExit(session, stopGraceMs);
      }
    }
    // Codex's own children may outlive the leader.
    signalGroup(session, pid, "SIGKILL");
    session.end();
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

  // -- the turns ------------------------------------------------------------

  function promptText(prompt: Prompt): string {
    return prompt.sections.map((section) => section.text).join("\n\n");
  }

  /**
   * Ask Codex to start a turn. The wait for the turn's end is registered before the request is
   * written, so a turn that ends in the same read as its start response is not missed.
   */
  async function startTurn(
    session: LiveSession,
    threadId: string,
    text: string,
    outputSchema?: Record<string, unknown>,
    turn = ++session.assigned,
  ): Promise<{ turn: number; wait: TurnWait }> {
    if (session.busy) throw new InputNotSent(harnessId, "send", "a turn is already running");
    session.turn = turn;
    session.busy = true;
    session.turnStartEmitted = false;
    session.text = "";
    const wait = session.expectTurn(turnTimeoutMs);

    const params: Record<string, unknown> = { threadId, input: [{ type: "text", text }] };
    if (outputSchema !== undefined) params.outputSchema = outputSchema;
    if (session.effort !== undefined) params.effort = session.effort;
    const started = await call(session, "turn/start", params);
    if (session.ended) {
      wait.cancel();
      throw inputFailure(harnessId, "send", started.dispatch ?? "uncertain", started.error ?? "the session ended");
    }
    const early = session.earlyTurnEvents.splice(0);
    if (!started.ok) {
      wait.cancel();
      const dispatch = started.dispatch ?? "uncertain";
      const failure = inputFailure(harnessId, "send", dispatch, started.error ?? "the CLI refused the turn");
      if (dispatch !== "uncertain") {
        // Codex did not take the turn: nothing runs, and what queued behind it goes on in its order.
        replayEarlySigns(session, early);
        session.busy = false;
        drainQueue(session);
      } else {
        const announced = new Set(early.flatMap((entry) =>
          "event" in entry && entry.event.kind === "turn-started" ? [entry.event.turnId] : []));
        const [id] = announced;
        if (announced.size === 1 && id !== undefined) {
          // The notification can identify a turn whose start acknowledgement was lost.
          bindTurn(session, id, early);
          throw failure;
        }
        // Codex neither answered nor announced the turn, so nobody knows whether one runs. Another
        // turn on top of it would be a second writer, and what waits could wait forever: the
        // session is closed, and a later resume starts from what Codex has on disk.
        replayEarlySigns(session, early);
        session.end(`${started.error ?? "the CLI did not answer the turn"}: the session was closed because the turn may be running`);
        await stopSession(session);
      }
      throw failure;
    }
    const nativeTurn = idOf(asRecord(started.result).turn);
    if (nativeTurn === undefined || session.endedTurnIds.has(nativeTurn)) {
      wait.cancel();
      const reason = "Codex accepted the turn without a new turn ID";
      replayEarlySigns(session, early);
      session.end(reason);
      await stopSession(session);
      throw inputFailure(harnessId, "send", "uncertain", reason);
    }
    bindTurn(session, nativeTurn, early);
    return { turn, wait };
  }

  function replayEarlySigns(session: LiveSession, early: EarlyTurnEvent[]): void {
    for (const entry of early) if ("sign" in entry) session.emit(entry.sign);
  }

  /** Replay signs in order and accept only turn notifications named by the acknowledgement. */
  function bindTurn(session: LiveSession, id: string, early: EarlyTurnEvent[]): void {
    session.activeTurnId = id;
    for (const entry of early) {
      if ("sign" in entry) session.emit(entry.sign);
      else if (session.activeTurnId === id && turnIdOf(entry.event) === id) apply(session, entry.event, entry.at, true);
    }
    if (!session.busy) drainQueue(session);
  }

  /** Wait for a started turn; anything but a completed turn is an error. Returns its answer. */
  async function finishTurn(session: LiveSession, wait: TurnWait): Promise<string> {
    const end = await wait.done;
    if (end === undefined) {
      throw unavailable("send", session.failure ?? "the turn did not end");
    }
    if (end.turn === undefined || end.turn.status !== "completed") {
      const status = end.turn?.status ?? "did not complete";
      throw unavailable("send", `the turn ${status}: ${end.turn?.message ?? "no reason given"}`);
    }
    return end.text;
  }

  async function runTurn(
    session: LiveSession,
    threadId: string,
    text: string,
    outputSchema?: Record<string, unknown>,
  ): Promise<string> {
    const { wait } = await startTurn(session, threadId, text, outputSchema);
    return finishTurn(session, wait);
  }

  /**
   * Starts the turns that waited for the turn that just ended, in the order the messages came.
   *
   * The turn is started after the end of the previous one was reported, so the signs of life
   * show one turn after the other and never two at the same time.
   */
  function drainQueue(session: LiveSession): void {
    if (session.ended || session.stopping) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    // The caller of a message does not wait for its turn; its end is a sign of life. The
    // caller of an ask waits for the answer.
    void startTurn(session, session.nativeId, next.text, next.outputSchema, next.turn)
      .then(({ wait }) => {
        if (next.ask === undefined) {
          wait.cancel();
          return undefined;
        }
        return finishTurn(session, wait).then(next.ask.resolve, next.ask.reject);
      })
      .catch((error: unknown) => {
        next.ask?.reject(error);
        if (error instanceof InputNotSent) session.emit({ kind: "turn-discarded", turn: next.turn });
        session.emit({
          kind: "activity",
          at: Date.now(),
          detail: `a queued message could not be started: ${String(error)}`,
        });
      });
  }

  /**
   * Deliver a message the way a send does, and say what became of it: queued behind a running
   * turn, or the start of a turn. Nothing waits for the turn to end; the signs of life report it.
   */
  async function deliver(session: LiveSession, message: string): Promise<DeliveryReceipt> {
    const at = Date.now();
    if (session.busy) {
      // The default: the message waits for the turn after the running one.
      const turn = ++session.assigned;
      session.queue.push({ turn, text: message });
      return { status: "queued", turn, at };
    }
    const { turn, wait } = await startTurn(session, session.nativeId, message);
    wait.cancel();
    return { status: "started", turn, at };
  }

  /** Runs `launch` once the earlier launches of the same thread are over, whether they worked or not. */
  async function launchAlone<T>(native: string, launch: () => Promise<T>): Promise<T> {
    const earlier = launching.get(native);
    const run = (async (): Promise<T> => {
      await earlier;
      return launch();
    })();
    const over = run.then(
      () => undefined,
      () => undefined,
    );
    launching.set(native, over);
    try {
      return await run;
    } finally {
      if (launching.get(native) === over) launching.delete(native);
    }
  }

  function requireSession(id: SessionId, ability: string): LiveSession {
    const session = sessions.get(id.native);
    if (session === undefined) {
      throw unavailable(ability, `the session ${id.native} is not held by this control side`);
    }
    return session;
  }

  function threadParams(
    model: string | undefined,
    config: Record<string, unknown> | undefined,
    mode: SessionMode,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = { ...THREAD_MODES[mode] };
    if (model !== undefined && model !== "") params.model = model;
    // Nothing to set means no config at all.
    const given = mode === "auto" ? { ...config, ...AUTO_NETWORK } : config;
    if (given !== undefined) params.config = given;
    return params;
  }

  /** The model Codex names in its answer to `thread/start` or `thread/resume`, as a sign of life. */
  function reportModel(session: LiveSession, answer: unknown): void {
    const reported = asRecord(answer).model;
    if (typeof reported === "string" && reported !== "") session.emit({ kind: "model", model: modelName(reported) });
  }

  // -- the contract ---------------------------------------------------------

  return {
    async start(startOptions: StartOptions): Promise<StartedSession> {
      // The config is built before the child is spawned: a tool Codex cannot switch off is
      // refused before anything is attempted.
      const model = startOptions.model ?? defaultModel;
      const effort = startOptions.effort ?? defaultEffort;
      const mode = modeOf(startOptions.mode, options.mode, CODEX_LAUNCH);
      requireLaunch(harnessId, CODEX_LAUNCH, { model, effort, mode });
      const config = codexConfig(
        harnessId,
        "start",
        startOptions.servers,
        startOptions.visible,
      );
      const session = await spawnSession(startOptions.cwd, startOptions);
      session.reverse = startOptions.reverse;
      try {
        const started = await call(session, "thread/start", {
          ...threadParams(model, config, mode),
          cwd: startOptions.cwd ?? process.cwd(),
        });
        if (!started.ok) throw unavailable("start", started.error ?? "the CLI did not start a thread");
        const threadId = idOf(asRecord(started.result).thread);
        if (threadId === undefined) throw unavailable("start", "the CLI started a thread without naming it");

        if (disposed || session.ended) throw unavailable("start", session.failure ?? "the session did not outlive its start");
        reportModel(session, started.result);
        session.nativeId = threadId;
        session.config = config;
        session.effort = effort === "" ? undefined : effort;
        sessions.set(threadId, session);
      } catch (error) {
        sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
      const id = makeSessionId(harnessId, session.nativeId);
      // The thread exists once Codex has named it, and the caller knows it before the prompt goes:
      // a start cut off while its first turn is on the way still finds its thread.
      try {
        await startOptions.named?.(id);
      } catch (error) {
        // A thread whose name could not be kept is one nobody could find again: it is given no work.
        sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
      // The prompt is its first turn, delivered like a send: the start waits for Codex to accept
      // the turn, never for the turn to end.
      const text = promptText(startOptions.prompt);
      if (text === "") return { session: id, mode };
      try {
        return { session: id, first: await deliver(session, text), mode };
      } catch (error) {
        // The first message may have been taken: the thread is named and its turn may run, so the
        // start answers with the session and no receipt. The caller keeps the id; a start that
        // threw would be tried again, and that would make a second thread and say the prompt twice.
        if (error instanceof InputPossiblySent) return { session: id, mode };
        // The first message was refused: the thread was never given its work, and a session
        // nobody holds the id of could not be stopped later.
        sessions.delete(session.nativeId);
        await stopSession(session);
        throw error;
      }
    },

    async resume(id: SessionId, resumeOptions?: ResumeOptions): Promise<void> {
      const text = resumeOptions?.prompt === undefined ? "" : promptText(resumeOptions.prompt);
      const config = codexConfig(
        harnessId,
        "resume",
        resumeOptions?.servers,
        resumeOptions?.visible,
      );

      // A held session continues in its own child: a second child would be a second writer. The
      // launches of one thread follow one another, so the second sees what the first made.
      const session = await launchAlone(id.native, async (): Promise<LiveSession> => {
        const held = sessions.get(id.native);
        if (held !== undefined && !held.ended && !held.stopping) {
          if (resumeOptions?.tools !== undefined || resumeOptions?.box !== undefined) {
            throw new Unsupported(harnessId, "control", "resume", LIVE_PROCESS_REFUSAL);
          }
          // The thread was given its config when it started, and it cannot take another one.
          // The same config is no change at all; a different one is refused, never dropped.
          if (config !== undefined && !sameConfig(config, held.config)) {
            throw new Unsupported(
              harnessId,
              "control",
              "resume",
              "a running session cannot take another server or tool set",
            );
          }
          // The one who resumes names where its reverse requests go from now on.
          if (resumeOptions?.reverse !== undefined) held.reverse = resumeOptions.reverse;
          return held;
        }

        const spawned = await spawnSession(undefined, resumeOptions ?? {}, "resume");
        spawned.reverse = resumeOptions?.reverse;
        try {
          const resumed = await call(spawned, "thread/resume", {
            ...threadParams(resumeOptions?.model ?? defaultModel, config, modeOf(resumeOptions?.mode, options.mode, CODEX_LAUNCH)),
            threadId: id.native,
          });
          if (!resumed.ok) throw unavailable("resume", resumed.error ?? "the CLI did not resume the thread");
          if (idOf(asRecord(resumed.result).thread) !== id.native) {
            throw unavailable("resume", "the CLI did not resume the thread that was asked for");
          }
          if (disposed || spawned.ended) throw unavailable("resume", spawned.failure ?? "the session did not outlive its resume");
          reportModel(spawned, resumed.result);
        } catch (error) {
          await stopSession(spawned);
          throw error;
        }

        spawned.nativeId = id.native;
        spawned.config = config;
        spawned.effort = defaultEffort === "" ? undefined : defaultEffort;
        sessions.set(id.native, spawned);
        return spawned;
      });
      // The turn of the prompt is not part of the launch: it runs after the next resume may start.
      if (text !== "") await runTurn(session, id.native, text);
    },

    async send(id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> {
      const session = sessions.get(id.native);
      if (session === undefined) {
        throw new InputNotSent(harnessId, "send", `the session ${id.native} is not held by this control side`);
      }
      const at = Date.now();
      const input = [{ type: "text", text: message }];

      if (session.busy) {
        // Only a caller that asks for it gets its message into the running turn.
        if (sendOptions?.into === "turn") {
          if (session.activeTurnId === undefined) {
            throw new InputNotSent(harnessId, "send", "the running turn has not been named by Codex yet");
          }
          const turn = session.turn;
          const steered = await call(session, "turn/steer", {
            threadId: id.native,
            expectedTurnId: session.activeTurnId,
            input,
          });
          if (!steered.ok) throw inputFailure(harnessId, "send", steered.dispatch ?? "uncertain", steered.error ?? "the CLI refused the message");
          return { status: "delivered", turn, at };
        }
      }
      return deliver(session, message);
    },

    async interrupt(id: SessionId): Promise<void> {
      const session = requireSession(id, "interrupt");
      if (session.activeTurnId === undefined) throw unavailable("interrupt", "no turn is running");
      // An explicit stop clears the queue: the messages that waited behind a turn the caller
      // just stopped must not fire as a surprise.
      session.dropQueue("the turn was interrupted");
      const interrupted = await call(session, "turn/interrupt", {
        threadId: id.native,
        turnId: session.activeTurnId,
      });
      if (!interrupted.ok) {
        throw unavailable("interrupt", interrupted.error ?? "the CLI refused the interrupt");
      }
      // Codex stops waiting for whatever the turn asked.
      session.cancelAsking();
    },

    async close(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      sessions.delete(id.native);
      session.dropQueue("the session was closed");
      await stopSession(session);
    },

    async ask<T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> {
      const session = requireSession(id, "ask");
      const text = promptText(askOptions.prompt);
      const plan = codexAsk(askOptions.schema, text);
      const outputSchema = plan.outputSchema;
      // An ask into a busy session waits for its turn, behind what is already queued.
      const answer = session.busy
        ? await new Promise<string>((resolve, reject) => {
            session.queue.push({ turn: ++session.assigned, text: plan.text, outputSchema, ask: { resolve, reject } });
          })
        : await runTurn(session, id.native, plan.text, outputSchema);
      // An answer written in the text may hold more than one piece of JSON (braces in the words
      // around it): the first that the caller's schema takes is the answer.
      let failure: unknown;
      for (const reading of jsonReadings(answer)) {
        try {
          const value = parseAnswer(askOptions.schema, plan.wrapped ? valueOf(reading) : reading);
          return { session: id, value, at: timestamp(Date.now()) };
        } catch (error) {
          failure ??= error;
        }
      }
      throw failure;
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
      // A process still being created becomes a session of this side before the stop reaches it.
      await Promise.allSettled([...spawning]);
      await Promise.all([...owned].map((session) => stopSession(session)));
      sessions.clear();
    },
  };
}

/**
 * app-server can disable individual features, but a feature can register several
 * tools and installed MCP servers contribute their own. Its thread API supplies
 * no exact filter over the effective catalog.
 */
function requireCodexTools(harness: HarnessId, ability: "start" | "resume", tools: ToolsMode | undefined): void {
  if (tools === undefined || tools === "all") return;
  throw new Unsupported(harness, "control", ability,
    `${describeToolsMode(tools)}: Codex app-server cannot enforce an exact tool list`);
}

/** Whether two Codex configs say the same thing; the same config is no change at all. */
function sameConfig(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableJson(a) === stableJson(b);
}

/**
 * The Codex config of a thread, in the dialect Codex speaks.
 *
 * Codex merges the JSON overrides as if they were given with `-c`. Server names are keys
 * of a table: a name that contains a dot must stay a single key.
 */
function codexConfig(
  harness: HarnessId,
  ability: "start" | "resume",
  servers: readonly McpServerSpec[] | undefined,
  visible: VisibleActions | undefined,
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};

  if (servers !== undefined && servers.length > 0) {
    config.mcp_servers = Object.fromEntries(servers.map((server) => [server.name, {
      command: server.command,
      args: [...server.args],
      ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
      ...(server.tools === undefined ? {} : { enabled_tools: [...new Set(server.tools)].sort() }),
    }]));
  }

  for (const tool of visible?.disabledTools ?? []) {
    switch (tool) {
      case "shell":
        config["features.shell_tool"] = false;
        break;
      case "web_search":
        config["web_search"] = "disabled";
        break;
      default:
        // Codex has no switch for any other tool, so the request is refused by name.
        throw new Unsupported(
          harness,
          "control",
          ability,
          `codex cannot switch off the tool "${tool}"`,
        );
    }
  }

  return Object.keys(config).length === 0 ? undefined : config;
}

/** How a question goes to Codex: the turn's text, the schema it is decoded under, and its shape. */
interface CodexAsk {
  readonly text: string;
  /** The schema the turn is decoded under; none when strict mode cannot say the caller's schema. */
  readonly outputSchema?: Record<string, unknown>;
  /** Whether the answer comes wrapped as `{ value }`, for a schema whose root is not an object. */
  readonly wrapped: boolean;
}

/**
 * The way a question goes to Codex (OpenAI structured output in strict mode).
 *
 * Strict mode takes a narrower JSON Schema than zod writes, so the schema sent is a projection of
 * the caller's, and the caller's own schema checks the answer whatever was sent:
 * - a root that is not an object is wrapped as `{ value }`, and the answer unwrapped;
 * - a `format` strict mode does not know and `propertyNames` are left out;
 * - objects are closed and optional properties made required and nullable (`closedObjects`);
 * - what strict mode cannot say at all (a free map, a tuple) is not decoded under a schema: the
 *   schema is put in the text of the question, and the answer is read as the JSON it writes.
 */
function codexAsk(schema: z.ZodType, text: string): CodexAsk {
  const caller = callerJsonSchema(schema);
  const wrapped = caller["type"] !== "object";
  const root = wrapped ? wrapRoot(caller) : caller;
  const fit = root === undefined ? undefined : strictFit(root);
  // What strict mode can say is judged before the objects are closed: closing a free map would
  // turn it into an object that may hold nothing.
  if (fit !== undefined && strictCanSay(fit)) {
    return { text, outputSchema: closedObjects(fit) as Record<string, unknown>, wrapped };
  }
  return {
    text: `${text}\n\nAnswer with JSON only, with no other text, that passes this JSON Schema:\n${JSON.stringify(caller)}`,
    wrapped: false,
  };
}

/** A root that is not an object, as the property `value` of one; none when its refs would break. */
function wrapRoot(caller: Record<string, unknown>): Record<string, unknown> | undefined {
  const { $defs, ...rest } = caller;
  // Only a ref into `$defs` stays valid once the root is the wrapper; a ref to the root ("#") or to
  // a place inside it ("#/items") would point somewhere else: such a schema is not wrapped.
  if (hasRefOutsideDefs(caller)) return undefined;
  return {
    type: "object",
    properties: { value: rest },
    required: ["value"],
    additionalProperties: false,
    ...($defs === undefined ? {} : { $defs }),
  };
}

function hasRefOutsideDefs(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRefOutsideDefs);
  if (typeof node !== "object" || node === null) return false;
  return Object.entries(node).some(([key, value]) =>
    key === "$ref" && typeof value === "string"
      ? value.startsWith("#") && !value.startsWith("#/$defs/")
      : hasRefOutsideDefs(value),
  );
}

/** The value inside a wrapped answer. */
function valueOf(answer: unknown): unknown {
  return typeof answer === "object" && answer !== null && "value" in answer
    ? (answer as { value: unknown }).value
    : answer;
}

/** The formats strict mode takes. */
const STRICT_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** The schema without what strict mode refuses and the caller's schema checks anyway. */
function strictFit(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((item) => strictFit(item));
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!names && key === "propertyNames") continue;
    // Strict mode takes `anyOf` but not `oneOf` (a discriminated union); the caller's schema keeps the exclusivity.
    if (!names && key === "oneOf") {
      out["anyOf"] = strictFit(value);
      continue;
    }
    if (!names && key === "format" && typeof value === "string" && !STRICT_FORMATS.has(value)) continue;
    out[key] = !names && DATA_KEYWORDS.has(key) ? value : strictFit(value, !names && SCHEMA_MAPS.has(key));
  }
  return out;
}

/** Whether strict mode can say the schema: no free map, no tuple. */
function strictCanSay(node: unknown, names = false): boolean {
  if (Array.isArray(node)) return node.every((item) => strictCanSay(item));
  if (typeof node !== "object" || node === null) return true;
  const record = node as Record<string, unknown>;
  if (!names) {
    if (record["patternProperties"] !== undefined) return false;
    const extra = record["additionalProperties"];
    const properties = record["properties"];
    const named = typeof properties === "object" && properties !== null;
    // A typed map is not sayable; neither is a loose one that has no `properties` at all (a record
    // of anything), which closing would leave able to hold nothing. A loose object that lists its
    // properties is closed to them.
    if (typeof extra === "object" && extra !== null && (!named || Object.keys(extra).length > 0)) return false;
    if (extra === true && !named) return false;
    if (record["items"] === false || record["prefixItems"] !== undefined) return false;
  }
  return Object.entries(record).every(
    ([key, value]) => (!names && DATA_KEYWORDS.has(key)) || strictCanSay(value, !names && SCHEMA_MAPS.has(key)),
  );
}

/** The caller's schema as JSON Schema, as zod writes it. */
function callerJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
}

/**
 * The schema with every object closed to keys it does not name.
 *
 * OpenAI's structured output refuses an `additionalProperties` that is not a typed schema or
 * `false` (a loose object, which a schema given as JSON becomes, says `{}`), and the whole turn
 * fails with a 400. Closing the object only narrows what the model may write: the answer is still
 * checked against the schema the caller gave, which takes it.
 */
function closedObjects(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((item) => closedObjects(item));
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  // The keys of `properties` (and of the other maps of schemas) are names, not keywords: a
  // property may be called "additionalProperties". The values of `enum`, `const`, `default` and
  // `examples` are data, not schemas, and stay as they are.
  for (const [key, value] of Object.entries(node)) {
    out[key] = !names && DATA_KEYWORDS.has(key) ? value : closedObjects(value, !names && SCHEMA_MAPS.has(key));
  }
  if (names) return out;
  const extra = out["additionalProperties"];
  if (extra === true || (typeof extra === "object" && extra !== null && Object.keys(extra).length === 0)) {
    out["additionalProperties"] = false;
  }
  // OpenAI's strict mode wants every property listed as required. An optional property becomes a
  // required one that may be null, and the null is taken out of the answer again (see
  // `withoutOptionalNulls`) before the caller's schema checks it.
  const properties = out["properties"];
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    const names = Object.keys(properties);
    const required = new Set(Array.isArray(out["required"]) ? (out["required"] as string[]) : []);
    const map = properties as Record<string, unknown>;
    for (const name of names) {
      if (!required.has(name)) map[name] = { anyOf: [map[name], { type: "null" }] };
    }
    out["required"] = names;
  }
  return out;
}

/**
 * The answer with the nulls Codex wrote for optional properties taken out, read along the schema
 * the caller gave (before the objects were closed): a property that schema does not require and
 * that came back null was left out by the model.
 *
 * The answer is first checked as it is; only one the schema refuses is cleaned and checked again.
 * A null the property's own schema accepts (nullable and optional) is kept either way.
 */
function parseAnswer<T>(schema: z.ZodType<T>, answer: unknown): T {
  const raw = schema.safeParse(answer);
  if (raw.success) return raw.data;
  return schema.parse(withoutOptionalNulls(answer, callerJsonSchema(schema)));
}

function withoutOptionalNulls(value: unknown, root: Record<string, unknown>): unknown {
  return stripNulls(value, root, root);
}

type SchemaNode = Record<string, unknown>;

/** The schema nodes that apply to a value: the node, what it `$ref`s, and the branches of `anyOf`/`oneOf`/`allOf`. */
function applicableNodes(schema: unknown, root: SchemaNode, seen = new Set<unknown>()): SchemaNode[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const node = schema as SchemaNode;
  const out: SchemaNode[] = [node];
  const ref = node["$ref"];
  if (typeof ref === "string" && ref.startsWith("#")) {
    let target: unknown = root;
    for (const part of ref.slice(1).split("/").filter((p) => p !== "")) {
      const name = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~");
      target = typeof target === "object" && target !== null ? (target as SchemaNode)[name] : undefined;
    }
    out.push(...applicableNodes(target, root, seen));
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[keyword];
    if (Array.isArray(branches)) for (const branch of branches) out.push(...applicableNodes(branch, root, seen));
  }
  return out;
}

/** Whether a schema accepts null itself, so that a null for it is an answer and not a missing value. */
function allowsNull(schema: unknown, root: SchemaNode): boolean {
  return applicableNodes(schema, root).some((node) => {
    const type = node["type"];
    return type === "null" || (Array.isArray(type) && type.includes("null")) || node["const"] === null;
  });
}

function stripNulls(value: unknown, schema: unknown, root: SchemaNode): unknown {
  if (typeof value !== "object" || value === null) return value;
  const nodes = applicableNodes(schema, root);
  if (nodes.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      nodes.reduce((acc, node) => {
        const prefix = node["prefixItems"];
        const own = Array.isArray(prefix) && index < prefix.length ? prefix[index] : node["items"];
        return stripNulls(acc, own, root);
      }, item),
    );
  }
  const declared = (node: SchemaNode, key: string): unknown => {
    const properties = node["properties"];
    return typeof properties === "object" && properties !== null && Object.hasOwn(properties, key)
      ? (properties as SchemaNode)[key]
      : undefined;
  };
  const requires = (node: SchemaNode, key: string): boolean =>
    Array.isArray(node["required"]) && (node["required"] as unknown[]).includes(key);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const declaring = nodes.filter((node) => declared(node, key) !== undefined);
    if (
      item === null &&
      declaring.length > 0 &&
      !nodes.some((node) => requires(node, key)) &&
      !declaring.some((node) => allowsNull(declared(node, key), root))
    ) {
      continue;
    }
    out[key] =
      declaring.length > 0
        ? declaring.reduce((acc, node) => stripNulls(acc, declared(node, key), root), item)
        : nodes.reduce((acc, node) => stripNulls(acc, node["additionalProperties"], root), item);
  }
  return out;
}

/** The keywords whose value is a map from a name to a schema. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/** The keywords whose value is data a schema describes, not a schema. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["enum", "const", "default", "examples"]);

/**
 * The pieces of JSON an answer may hold, most likely first. An answer decoded under a schema is
 * JSON; one asked for in the text may come in a code fence or with words around it, and the words
 * may have braces of their own, so every balanced `{...}` or `[...]` in it is a reading.
 */
function jsonReadings(text: string): unknown[] {
  const candidates = [text.trim()];
  for (const fenced of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push((fenced[1] ?? "").trim());
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const end = balancedEnd(text, start);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  const readings: unknown[] = [];
  for (const candidate of candidates) {
    try {
      readings.push(JSON.parse(candidate) as unknown);
    } catch {
      // Not JSON.
    }
  }
  // Nothing to read: the schema gets `undefined`, and says what it wanted.
  return readings.length === 0 ? [undefined] : readings;
}

/** The index of the bracket closing the one at `start`, reading strings as JSON does; -1 if none. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
