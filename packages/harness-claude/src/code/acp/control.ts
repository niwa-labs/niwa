/**
 * The control side for the Agent Client Protocol (ACP), in Claude Code's dialect: how niwa
 * starts, steers and stops the sessions of Claude Code.
 *
 * ACP is a *protocol*, not a product, and every provider has its own dialect of it. This side
 * is the dialect Claude Code's adapter speaks, so it belongs to Claude Code: it is the harness
 * that only says which adapter to run and how to shape its answers.
 *
 * What it provides:
 *
 * - **The client**: one demux over the JSON lines of stdout, a monotonic request id, a pending
 *   map keyed by that id, a per-call timeout, every pending call failed when the child dies, the
 *   reply to a request the agent makes of the client (so the agent never waits for a human that
 *   is not there), the FIFO queue of messages that arrive while a turn is running, and the two
 *   stop ladders: a loud one for an explicit stop, a quiet one for a cleanup that must not carry
 *   meaning onto a durable session.
 * - **Process ownership and termination**: the child leads its own process group, a stop is a
 *   group signal with a grace period and a hard-kill escalation, the frame budget is bounded so
 *   a peer cannot make this side allocate without bound, and an interrupt is only successful
 *   when the agent itself confirms it: a write that went through is not proof.
 * - **Signs of life**: `turn-started` when a prompt goes out, `turn-ended` when the agent
 *   answers it, `activity` for everything in between. ACP has no turn-start notification, so
 *   the turn is counted here and the boundary is the prompt's own answer.
 * - **A delivery receipt that is never a guess**: `queued` when a message waits behind the
 *   running turn, `started` when it begins a turn of its own. ACP forbids two prompts at once,
 *   so the queue is the adapter's own and the receipt says which it is.
 * - **A permission policy that can actually allow**: the agent offers its options and this
 *   side picks one. The default is to allow, because a session niwa drives should be able to
 *   do its work; a policy that says no says no.
 */

import { z } from "zod";

import type { Answer, Question, QuestionOption } from "@niwa-labs/core";
import { OptionIdSchema, pickedOptions, stableJson, timestamp, assertNever } from "@niwa-labs/core";
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
  ToolAllowance,
  SessionMode,
  SessionId,
  ReverseHandler,
  ClaudeOptions,
} from "@niwa-labs/harness";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  unknownVariantSigns,
  Unavailable,
  Unsupported,
  modeOf,
  HarnessIdSchema,
  sessionId as makeSessionId,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, SandboxUnavailable, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess } from "@niwa-labs/sandbox";
import { answerText, acpVariant, readVariant } from "@niwa-labs/acp";
import type { UnknownVariant } from "@niwa-labs/acp";
import { claudeEnv } from "../options.ts";
import {
  Acp,
  AskUserQuestionParams,
  CLAUDE_ACP_PROTOCOL,
  ClaudeAgentNotification,
  ClaudeAgentRequest,
  claudeToolName,
} from "./protocol.ts";
import { CLAUDE_NEEDS, claudeToolsOff } from "../needs.ts";

/**
 * The adapter's mode for each working mode. The adapter takes no `auto`: it answers "Invalid Mode"
 * to it, so `auto` is `acceptEdits`, the mode that works freely in the folder and asks for the rest.
 */
const ADAPTER_MODES = { ask: "default", auto: "acceptEdits", full: "bypassPermissions" } as const;

/**
 * A tool the agent wants to use.
 */
export interface ClaudeAcpPermissionRequest {
  /** The session the request belongs to. */
  readonly sessionId: string;
  /** The tool the agent named, when it named one. */
  readonly tool: string | undefined;
  /** The call id of the tool call, when the agent gave one. */
  readonly toolCallId: string | undefined;
  /** The title the agent gave the call, when it gave one. */
  readonly title: string | undefined;
  /** The input the agent wants to pass to the tool. */
  readonly input: unknown;
  /** The options the agent offered, with their kinds and ids. */
  readonly options: readonly ClaudeAcpPermissionOption[];
}

/**
 * One option the agent offered.
 */
export interface ClaudeAcpPermissionOption {
  /** The kind of the option: `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  readonly kind: string | undefined;
  /** The id this side sends back when it picks this option. */
  readonly optionId: string;
  /** The name the agent gave the option. */
  readonly name: string | undefined;
}

/**
 * What this side decided about a permission request.
 */
export type ClaudeAcpPermissionDecision =
  | { readonly behavior: "allow"; readonly optionId?: string }
  | { readonly behavior: "deny"; readonly message?: string };

/**
 * What happens when the agent asks for permission.
 *
 * `"allow"` (the default) picks the option that allows the tool, so a session niwa drives can
 * do its work. `"deny"` picks the option that refuses it. A function decides per request; a
 * function that throws refuses.
 */
export type ClaudeAcpPermissionPolicy =
  | "allow"
  | "deny"
  | ((request: ClaudeAcpPermissionRequest) => Promise<ClaudeAcpPermissionDecision> | ClaudeAcpPermissionDecision);

/**
 * How the control side is set up.
 */
export interface ClaudeAcpControlOptions {
  /**
   * The harness instance id. It is half of a session's identity: the pair of harness id and
   * the id the harness gave the session.
   */
  readonly harness: string;

  /**
   * The command that starts the ACP adapter. The first element is the program and the rest are
   * its arguments.
   */
  readonly command: readonly string[];

  /**
   * The model the session talks to, when the caller does not choose one per start.
   */
  readonly model?: string;

  /**
   * The effort level, when the caller does not choose one per start. It reaches the program as its
   * `--effort` flag.
   */
  readonly effort?: string;

  /**
   * The Claude Code program the adapter drives, as a path. The adapter takes it from the
   * `CLAUDE_CODE_EXECUTABLE` of its environment. It is asked for when a process is started, and it
   * throws when there is no program to run.
   */
  readonly executable: () => string;

  /**
   * What happens when the agent asks for permission.
   */
  readonly permissions?: ClaudeAcpPermissionPolicy;

  /**
   * The working mode of sessions, when the caller does not choose one per start. It is sent with
   * `session/set_mode` right after the session opens, as the adapter's own mode of that name.
   */
  readonly mode?: SessionMode;

  /**
   * Environment variables the child must not inherit.
   */
  readonly unsetEnv?: readonly string[];

  /** Claude Code's own options: `advisor: false` switches its advisor off; left out, the owner's config stands. */
  readonly claude?: ClaudeOptions;

  /**
   * How long one call waits for its answer, in milliseconds.
   */
  readonly callTimeoutMs?: number;

  /**
   * How long a turn waits for its answer, in milliseconds.
   */
  readonly turnTimeoutMs?: number;

  /**
   * How long a graceful stop waits before the hard kill, in milliseconds.
   */
  readonly stopGraceMs?: number;
}

/**
 * The control side of Claude Code's ACP dialect.
 *
 * It is a `SessionControl`, and it adds the two things a control side needs to own what it
 * started: the way to stop one session, and the way to stop all of them.
 */
export interface ClaudeAcpSessionControl extends SessionControl {
  /** Stops a session and the process it owns. */
  stop(id: SessionId): Promise<void>;

  /** Stops every session this control side owns. */
  dispose(): Promise<void>;
}

/** How long one call waits for its answer. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** How long a graceful stop waits before the hard kill. */
const DEFAULT_STOP_GRACE_MS = 500;

/** The most bytes one line of the output stream may hold. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** How much of stderr is kept to explain a death. */
const STDERR_TAIL_CHARS = 2_000;

/** The child is not a person; it should not phone home. */
const CHILD_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DO_NOT_TRACK: "1",
};

/**
 * The stop reason that means the agent finished its turn.
 */
const STOP_TURN = "end_turn";

/**
 * The stop reason of a turn whose marker was absent.
 *
 * A missing marker is a protocol fact, and unknown is not success: a caller must never be told
 * the turn ended when the agent never said so.
 */
const STOP_MISSING = "<missing>";

// ---------------------------------------------------------------------------
// The wire protocol
// ---------------------------------------------------------------------------

/**
 * One JSON-RPC envelope.
 *
 * The same shape carries a response, a notification and a request from the agent, so every
 * field is optional and the shape is decided by what is present.
 */
interface RpcFrame {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** The result of one call. */
interface RpcOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** The result of a prompt: the answer and why the turn ended. */
interface ClaudeAcpTurn {
  /** Why the agent ended the turn. */
  readonly stopReason: string;
  /** The text the agent produced. */
  readonly text: string;
}

/** A record of a message that waits behind the running turn. */
interface QueuedMessage {
  readonly text: string;
  /** The turn this message will run as. */
  readonly turn: number;
  /** A question waits for the answer of its turn; a plain message does not. */
  readonly ask?: {
    readonly resolve: (turn: ClaudeAcpTurn) => void;
    readonly reject: (error: unknown) => void;
  };
}

/** What the agent said about a tool call when it announced it. */
interface ToolCallFacts {
  /** Claude Code's own name of the tool. */
  readonly tool: string | undefined;
  /** The kind ACP gives the tool: `execute`, `edit`, `read`, ... */
  readonly kind: string | undefined;
  /** The paths the call acts on. */
  readonly paths: readonly string[];
}

/** How many tool calls a session remembers the facts of. */
const TOOL_CALLS_KEPT = 256;

/** How much of a tool's input a question shows as its detail. */
const DETAIL_CHARS = 500;

/**
 * What a permission question holds when the agent offered nothing it could be answered with: the
 * only answer there is. It is never picked; the request ends as cancelled.
 */
const REJECT_ONLY: QuestionOption = { id: OptionIdSchema.parse("cancel"), label: "Cancel", flavor: "reject_once" };

/** The paths of a tool call's `locations`, when it names some. */
function locationsOf(locations: readonly Acp.ToolCallLocation[] | null | undefined): string[] | undefined {
  const paths = (locations ?? []).map((location) => location.path);
  return paths.length === 0 ? undefined : paths;
}

/** The name of Claude Code's advisor, a server tool the adapter announces as a tool call of kind `other`. */
const ADVISOR_TOOL = "advisor";

/**
 * What an update of the advisor's tool call says about the advisor: its call began, or its answer
 * came (`completed`) or failed. Any other update of the call is only a sign of life.
 */
function advisorPhase(sessionUpdate: "tool_call" | "tool_call_update", status: Acp.ToolCallStatus | null | undefined): "started" | "completed" | "failed" | undefined {
  if (sessionUpdate === "tool_call") return "started";
  return status === "completed" || status === "failed" ? status : undefined;
}

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * What one live session holds: the child, the session the agent named, the turn counter and the
 * people watching.
 */
class LiveSession {
  /** The id the agent gave the session. */
  nativeId = "";

  /** The Claude Code tools switched off for this session, as given when it was started or loaded. */
  disabledTools: readonly string[] = [];

  /** Where this session's reverse requests go, when it has been given a place for them. */
  reverse: ReverseHandler | undefined;

  /** What the agent said about its tool calls, by call id: what a permission request for one is about. */
  readonly toolCalls = new Map<string, ToolCallFacts>();

  /** The reverse requests waiting for an answer, each with the call that asked it: aborted when the agent stops waiting. */
  private readonly asking = new Map<AbortController, string | undefined>();

  /** The turns this session has run. */
  turn = 0;

  /** Whether a turn is running right now. */
  busy = false;

  /** Whether the child is gone. */
  ended = false;

  /** Whether a stop was asked for. */
  stopping = false;

  /** Why the child died, when it died badly. */
  failure?: string;

  /** The text the agent produced in the turn that is running, or in the last one. */
  text = "";

  /**
   * Where each answer segment starts in the text.
   *
   * A segment ends when a tool runs: what the agent says after the tool is the answer to the
   * question the tool answered, and what it said before is not.
   */
  readonly segmentStarts: number[] = [0];

  /** The watchers of the signs of life. */
  readonly watchers = new Set<(event: LifeEvent) => void>();

  /**
   * The turn signs before anyone watched: the first turn begins inside `start`, before the
   * caller has the session to watch. The first watcher is given them; after it nothing is kept.
   */
  private unwatched: LifeEvent[] | undefined = [];

  /** The calls in flight, by request id. */
  readonly pending = new Map<number, (outcome: RpcOutcome) => void>();

  /** The request-id counter. */
  nextId = 1;

  /** The messages that wait behind the running turn. */
  readonly queue: QueuedMessage[] = [];

  /** Whether a cancel was asked for and the agent has not yet confirmed it. */
  cancelled = false;

  /** Those waiting for the running turn to be over. */
  private readonly idleWaiters: Array<() => void> = [];

  /** The watchers of the end of the session: they are told once, with `undefined`. */
  private readonly endWatchers = new Set<() => void>();

  constructor(readonly child: AgentProcess) {}

  /** Remember what the agent said about a tool call; the oldest are forgotten past a bound. */
  rememberToolCall(callId: string, facts: ToolCallFacts): void {
    this.toolCalls.set(callId, facts);
    if (this.toolCalls.size > TOOL_CALLS_KEPT) {
      const oldest = this.toolCalls.keys().next().value;
      if (oldest !== undefined) this.toolCalls.delete(oldest);
    }
  }

  /** A reverse request begins to wait: the signal is aborted when the agent stops waiting for it. */
  startAsking(callId: string | undefined): { readonly signal: AbortSignal; readonly done: () => void } {
    const controller = new AbortController();
    this.asking.set(controller, callId);
    return { signal: controller.signal, done: () => this.asking.delete(controller) };
  }

  /** The agent no longer waits for the reverse requests of one call, or of all of them. */
  cancelAsking(callId?: string): void {
    for (const [controller, asked] of [...this.asking]) {
      if (callId !== undefined && asked !== callId) continue;
      this.asking.delete(controller);
      controller.abort();
    }
  }

  /** Resolves when no turn is running, or when the session ends. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** A turn is over: say so to everyone who waits for it. */
  settleIdle(): void {
    this.busy = false;
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  /** Tell `watcher` when the session ends. */
  onEnd(watcher: () => void): () => void {
    this.endWatchers.add(watcher);
    return () => {
      this.endWatchers.delete(watcher);
    };
  }

  /** The child is gone: every call in flight and every waiter is released, every watcher told. */
  end(failure?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (failure !== undefined) {
      this.failure = failure;
      this.emit({ kind: "activity", at: Date.now(), detail: failure });
    }
    const reason = this.failure ?? "the session process closed";
    this.cancelAsking();
    this.dropQueue(reason);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const settle of pending) settle({ ok: false, error: reason });
    this.settleIdle();
    for (const watcher of [...this.endWatchers]) watcher();
  }

  /** Watch the signs of life; the first watcher also gets the turn signs that came before it. */
  watch(watcher: (event: LifeEvent) => void): void {
    const missed = this.unwatched ?? [];
    this.unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  /** Drop what waits behind the running turn; a question that waited is told why. */
  dropQueue(reason: string): void {
    for (const message of this.queue.splice(0)) message.ask?.reject(new Error(reason));
  }

  /** Announce a sign of life to everyone watching. */
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
}

// ---------------------------------------------------------------------------
// The control side
// ---------------------------------------------------------------------------

/**
 * Build the control side for Claude Code's ACP dialect.
 *
 * The returned object implements the `SessionControl` contract the harness package defines.
 * It owns every process it starts, and it terminates them itself.
 */
export function claudeAcpControl(options: ClaudeAcpControlOptions): ClaudeAcpSessionControl {
  const [program, ...args] = options.command;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const defaultModel = options.model;
  const defaultEffort = options.effort;
  const permissions: ClaudeAcpPermissionPolicy = options.permissions ?? "allow";

  /** The harness id, as the identity type wants it. */
  const harnessId = HarnessIdSchema.parse(options.harness);

  /** The sessions this control side owns, by native id. */
  const sessions = new Map<string, LiveSession>();

  /** Every child this control side started, including those still starting. */
  const owned = new Set<LiveSession>();
  let disposed = false;

  // -- the JSON-RPC client --------------------------------------------------

  /** Write one JSON-RPC line to the child. */
  function writeLine(session: LiveSession, line: string): void {
    const stdin = session.child.stdin;
    if (stdin === null || stdin.destroyed || session.stopping || session.ended) {
      throw new Unavailable(harnessId, "control", "send", "the session is not running");
    }
    stdin.write(`${line}\n`);
  }

  /**
   * One call: write the request and wait for its answer.
   *
   * The id is matched, not guessed: every call has its own id, and the answer to one call can
   * never settle another.
   *
   * A call that is over its time and has an `overdue` is not abandoned at once: `overdue` is run
   * (it cancels the work), and the call stays registered until the agent answers it or the
   * grace is over. Either way it fails with the timeout, so the caller never learns of a
   * cancelled answer as of a success.
   */
  function call(
    session: LiveSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = callTimeoutMs,
    overdue?: () => void,
  ): Promise<RpcOutcome> {
    const id = session.nextId;
    session.nextId += 1;

    // The wait is registered before the request is written, so an answer that arrives in the
    // same read as the write is never missed.
    return new Promise<RpcOutcome>((resolve) => {
      const timedOut: RpcOutcome = { ok: false, error: `the call ${method} timed out` };
      let late = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        if (!session.pending.has(id)) return;
        if (overdue === undefined) {
          session.pending.delete(id);
          resolve(timedOut);
          return;
        }
        late = true;
        try {
          overdue();
        } catch {
          // The child is gone; there is nothing to cancel.
        }
        grace = setTimeout(() => {
          if (session.pending.delete(id)) resolve(timedOut);
        }, callTimeoutMs);
        if (typeof grace.unref === "function") grace.unref();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      session.pending.set(id, (outcome) => {
        clearTimeout(timer);
        clearTimeout(grace);
        resolve(late ? timedOut : outcome);
      });
      try {
        writeLine(session, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        // A child that cannot be written to is going: its own end says why, and that is the
        // answer, not the refusal to write to it. The call stays registered for that end.
        if (!session.ended) return;
        clearTimeout(timer);
        session.pending.delete(id);
        resolve({ ok: false, error: session.failure ?? (error instanceof Error ? error.message : String(error)) });
      }
    });
  }

  /** A notification: no id, no answer expected. */
  function notify(session: LiveSession, method: string, params: Record<string, unknown> = {}): void {
    writeLine(session, JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  // -- the demux ------------------------------------------------------------

  /**
   * Read one line of stdout and act on it.
   *
   * One demux, one place where a frame is understood: a response settles a call, a
   * notification is a sign of life, and a request from the agent is answered.
   */
  function handleLine(session: LiveSession, line: string): void {
    if (line.length === 0) return;

    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch (error) {
      session.emit({
        kind: "activity",
        at: Date.now(),
        detail: `a line of the output stream could not be read: ${String(error)}`,
      });
      return;
    }

    // A frame that is not JSON-RPC is not ours.
    if (frame.jsonrpc !== "2.0") return;

    const method = frame.method;
    const hasId = frame.id !== undefined && frame.id !== null;

    // A request from the agent: it must be answered, or the agent waits forever.
    if (method !== undefined && hasId) {
      answerAgentRequest(session, frame);
      return;
    }

    // A response: it settles exactly one call.
    if (method === undefined && typeof frame.id === "number") {
      const settle = session.pending.get(frame.id);
      if (settle === undefined) return;
      session.pending.delete(frame.id);
      if (frame.error !== undefined) {
        settle({ ok: false, error: frame.error.message ?? "the call failed" });
      } else {
        settle({ ok: true, result: frame.result });
      }
      return;
    }

    // A notification: a sign of life.
    if (method !== undefined) {
      handleNotification(session, frame);
    }
  }

  /** A message the snapshot of the protocol does not know: recorded as it came, never a crash. */
  function emitUnknown(session: LiveSession, unknown: UnknownVariant): void {
    for (const sign of unknownVariantSigns(Date.now(), unknown.protocol, unknown.variant, unknown.raw)) session.emit(sign);
  }

  /** Refuse a request of the agent, so it never waits on this side. */
  function refuse(session: LiveSession, frame: RpcFrame, method: string): void {
    writeLine(
      session,
      JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `this control side cannot serve ${method}` } }),
    );
  }

  /**
   * Answer a request the agent makes of the client.
   *
   * A permission request and the questions of a tool call (`_niwa/ask_user_question`, which niwa's
   * own adapter entry sends) have answers this side can give: a session that has a place for its
   * reverse requests sends them there, and any other session answers a permission by its policy.
   * Every other request is refused with a shape the agent understands, so the agent never waits.
   */
  function answerAgentRequest(session: LiveSession, frame: RpcFrame): void {
    const read = readVariant(ClaudeAgentRequest, frame, CLAUDE_ACP_PROTOCOL, acpVariant);
    if (!read.ok) {
      emitUnknown(session, read.unknown);
      refuse(session, frame, read.unknown.variant);
      return;
    }
    const request = read.value;
    switch (request.method) {
      case "session/request_permission":
        void answerPermission(session, frame, request.params);
        return;
      case "_niwa/ask_user_question":
        if (session.reverse === undefined) refuse(session, frame, request.method);
        else void answerQuestions(session, frame, session.reverse);
        return;
      // The client advertises no file system and no terminal, so the adapter never asks for them.
      case "fs/read_text_file":
      case "fs/write_text_file":
      case "terminal/create":
      case "terminal/kill":
      case "terminal/output":
      case "terminal/release":
      case "terminal/wait_for_exit":
        refuse(session, frame, request.method);
        return;
      default:
        assertNever(request, "Claude Code ACP request");
    }
  }

  /** Answer an agent's request, once; a session that is gone has nobody to answer. */
  function reply(session: LiveSession, frame: RpcFrame, result: Record<string, unknown>): void {
    try {
      writeLine(session, JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    } catch {
      // The child is gone; its end says why.
    }
  }

  /** The `outcome` of a permission answer, in the agent's words: a chosen option, or a cancel. */
  function outcomeOf(optionId: string | undefined): Record<string, unknown> {
    return { outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
  }

  /**
   * Answer a permission request, with the policy's decision, or by what the one who answers says.
   *
   * The agent offers its options and this side picks one of them: an id the agent does not
   * know is a refusal, so the id must come from the offer.
   */
  async function answerPermission(session: LiveSession, frame: RpcFrame, params: Acp.RequestPermissionRequest): Promise<void> {
    const options: ClaudeAcpPermissionOption[] = params.options.map((option) => ({
      kind: option.kind,
      optionId: option.optionId,
      name: option.name,
    }));
    const toolCall = params.toolCall;
    const title = toolCall.title ?? undefined;
    const request: ClaudeAcpPermissionRequest = {
      sessionId: params.sessionId,
      tool: title,
      toolCallId: toolCall.toolCallId,
      title,
      input: toolCall.rawInput,
      options,
    };

    if (session.reverse !== undefined) {
      const answer = await askPermission(session, session.reverse, request, toolCall, options, frame.params);
      reply(session, frame, outcomeOf(nativeOptionOf(options, answer)));
      return;
    }

    let decision: ClaudeAcpPermissionDecision;
    try {
      decision =
        permissions === "allow"
          ? { behavior: "allow" }
          : permissions === "deny"
            ? { behavior: "deny", message: "this control side does not allow tools" }
            : await permissions(request);
    } catch (error) {
      decision = {
        behavior: "deny",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (decision.behavior === "allow") {
      // The agent offered nothing to allow with: the request is refused.
      reply(session, frame, outcomeOf(decision.optionId ?? pickAllowOption(options)));
      return;
    }

    // A refusal: the agent understands both a cancelled outcome and a reject option.
    reply(session, frame, outcomeOf(options.find((option) => option.kind?.startsWith("reject"))?.optionId));
  }

  /** The native option an answer picked: the id the adapter offered it under, never an `always` one. */
  function nativeOptionOf(offered: readonly ClaudeAcpPermissionOption[], answer: Answer): string | undefined {
    if (!("ids" in answer)) return undefined;
    const id = answer.ids[0];
    return offered.find((option) => option.optionId === id)?.optionId;
  }

  /**
   * The permission request, as a question for whoever answers for the session.
   *
   * Only the once-only options the agent offered are carried: niwa remembers an "always" itself
   * and never picks the agent's own. The tool and what it acts on come from what the agent said
   * when it announced the call, else from the request itself.
   */
  async function askPermission(
    session: LiveSession,
    handler: ReverseHandler,
    request: ClaudeAcpPermissionRequest,
    toolCall: Acp.ToolCallUpdate,
    offered: readonly ClaudeAcpPermissionOption[],
    raw: unknown,
  ): Promise<Answer> {
    const known = request.toolCallId === undefined ? undefined : session.toolCalls.get(request.toolCallId);
    const paths = locationsOf(toolCall.locations) ?? known?.paths ?? [];
    const title = request.title ?? known?.tool ?? "a tool";
    const options: QuestionOption[] = offered.flatMap((option) => {
      if (option.kind !== "allow_once" && option.kind !== "reject_once") return [];
      return [{ id: OptionIdSchema.parse(option.optionId), label: option.name ?? option.kind, flavor: option.kind }];
    });
    const question: Question = {
      kind: "permission",
      title,
      ...(request.input === undefined ? {} : { detail: stableJson(request.input).slice(0, DETAIL_CHARS) }),
      options: options.length === 0 ? [REJECT_ONLY] : options,
      subject: {
        ...(known?.tool === undefined ? {} : { tool: known.tool }),
        kind: toolCall.kind ?? known?.kind ?? "other",
        target: paths.length > 0 ? paths.join("\n") : request.input === undefined ? title : stableJson(request.input),
      },
    };
    return await reverseAnswer(session, handler, question, { method: "session/request_permission", params: raw }, request.toolCallId);
  }

  /**
   * Answer the questions of an AskUserQuestion call, one niwa question each.
   *
   * The tool's answer to a question is the label of the option picked, or the words given instead;
   * a multi-select question joins the labels with a comma. A question left without an answer
   * ends the call: the tool is told nobody answered.
   */
  async function answerQuestions(session: LiveSession, frame: RpcFrame, handler: ReverseHandler): Promise<void> {
    const parsed = AskUserQuestionParams.safeParse(frame.params);
    if (!parsed.success) {
      writeLine(
        session,
        JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "the questions of the tool call are not well formed" } }),
      );
      return;
    }
    const answers: Record<string, string> = {};
    for (const asked of parsed.data.questions) {
      const options: QuestionOption[] = asked.options.map((option, index) => ({
        id: OptionIdSchema.parse(`option-${index + 1}`),
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        flavor: "plain",
      }));
      const question: Question = {
        kind: asked.multiSelect === true ? "multi" : "choice",
        title: asked.question,
        ...(asked.header === undefined ? {} : { detail: asked.header }),
        options,
        allowOther: true,
      };
      const answer = await reverseAnswer(session, handler, question, { method: "_niwa/ask_user_question", params: frame.params }, parsed.data.toolCallId);
      if ("text" in answer) {
        answers[asked.question] = answer.text;
      } else if ("ids" in answer) {
        answers[asked.question] = pickedOptions(question, answer)
          .map((option) => option.label)
          .join(", ");
      } else {
        reply(session, frame, { cancelled: true });
        return;
      }
    }
    reply(session, frame, { answers });
  }

  /**
   * Hand a question to the place a session's reverse requests go, and wait for the answer.
   *
   * The agent's wait is the request's: when the agent stops waiting (a cancel, the end of the turn,
   * the end of the process) the request is aborted. A handler that fails answers nothing.
   */
  async function reverseAnswer(
    session: LiveSession,
    handler: ReverseHandler,
    question: Question,
    raw: { readonly method: string; readonly params: unknown },
    callId: string | undefined,
  ): Promise<Answer> {
    const asking = session.startAsking(callId);
    try {
      return await handler(makeSessionId(harnessId, session.nativeId), { question, raw, signal: asking.signal });
    } catch {
      return { cancelled: true };
    } finally {
      asking.done();
    }
  }

  /** The option that allows the tool, when the agent offered one. */
  function pickAllowOption(options: readonly ClaudeAcpPermissionOption[]): string | undefined {
    const byKind = options.find((option) => option.kind === "allow_once");
    if (byKind !== undefined) return byKind.optionId;
    const byName = options.find((option) => option.kind?.startsWith("allow"));
    if (byName !== undefined) return byName.optionId;
    return options.find((option) => option.optionId.startsWith("allow"))?.optionId;
  }

  /** The notifications that are signs of life. */
  function handleNotification(session: LiveSession, frame: RpcFrame): void {
    const read = readVariant(ClaudeAgentNotification, frame, CLAUDE_ACP_PROTOCOL, acpVariant);
    if (!read.ok) {
      emitUnknown(session, read.unknown);
      return;
    }
    const at = Date.now();
    const notification = read.value;
    switch (notification.method) {
      case "_niwa/cancel_request":
        // The agent stopped waiting for the answer to the questions of one tool call.
        session.cancelAsking(notification.params.toolCallId);
        session.emit({ kind: "activity", at, detail: notification.method });
        return;
      case "_niwa/session_model":
        // The program named the model the session runs: the one it was asked for is an alias until now.
        session.emit({ kind: "model", model: notification.params.model });
        session.emit({ kind: "activity", at, detail: notification.method });
        return;
      case "session/update":
        handleUpdate(session, notification.params.update, at);
        return;
      case "$/cancel_request":
        // The adapter withdraws its questions through `_niwa/cancel_request`, which names the tool
        // call they are keyed by; the protocol's own cancel names only a request id.
        session.emit({ kind: "activity", at, detail: notification.method });
        return;
      default:
        assertNever(notification, "Claude Code ACP notification");
    }
  }

  /** One `session/update`: the turn's progress, each a sign of life. */
  function handleUpdate(session: LiveSession, update: Acp.SessionUpdate, at: number): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = answerText(update.content);
        if (text !== "") session.text += text;
        session.emit({ kind: "activity", at, detail: "text" });
        return;
      }
      case "agent_thought_chunk":
        // The agent is thinking. A silent run and a hung run look the same without this.
        session.emit({ kind: "activity", at, detail: "thinking" });
        return;
      case "tool_call":
      case "tool_call_update": {
        // An update may leave the tool's name out: the call it belongs to was remembered with it.
        const tool = claudeToolName(update._meta) ?? session.toolCalls.get(update.toolCallId)?.tool;
        if (update.sessionUpdate === "tool_call") {
          session.rememberToolCall(update.toolCallId, {
            tool,
            kind: update.kind,
            paths: locationsOf(update.locations) ?? [],
          });
        }
        // A tool call ends the answer segment: what comes after it is a new segment.
        session.segmentStarts.push(session.text.length);
        // The advisor is a server tool of Claude Code: its call and its result are its own sign. The
        // adapter does not say which model answered, and a failure has no code of Claude's to carry.
        if (tool === ADVISOR_TOOL) {
          const phase = advisorPhase(update.sessionUpdate, update.status);
          if (phase === "started") session.emit({ kind: "advisor", at, phase, callId: update.toolCallId });
          else if (phase === "completed") session.emit({ kind: "advisor", at, phase: "finished", callId: update.toolCallId, result: "text" });
          else if (phase === "failed") session.emit({ kind: "advisor", at, phase: "finished", callId: update.toolCallId, result: "error" });
        }
        session.emit({
          kind: "activity",
          at,
          detail: tool === ADVISOR_TOOL ? "advisor" : update.sessionUpdate,
          ...(tool === undefined ? {} : { tool }),
        });
        return;
      }
      // The history the adapter replays on a load, the plan (TodoWrite), the commands, the mode, the
      // config, the session's title and the usage: none is part of the answer, each a sign of life.
      case "user_message_chunk":
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        session.emit({ kind: "activity", at, detail: update.sessionUpdate });
        return;
      default:
        assertNever(update, "Claude Code session update");
    }
  }

  // -- the child ------------------------------------------------------------

  /**
   * Start the child and hold the ACP session with it.
   *
   * The handshake comes first: the agent wants to know who is talking to it before it will do
   * anything.
   */
  async function spawnSession(
    cwd: string | undefined,
    ability: string,
    plan: Pick<StartOptions, "env" | "box" | "claude">,
  ): Promise<LiveSession> {
    if (disposed) throw new Unavailable(harnessId, "control", ability, "the control side is disposed");
    if (program === undefined || program === "") {
      throw new Unavailable(harnessId, "control", "start", "the ACP command is empty");
    }

    let executable: string;
    try {
      executable = options.executable();
    } catch (error) {
      throw new Unavailable(harnessId, "control", ability, error instanceof Error ? error.message : String(error));
    }
    const childEnv: Record<string, string> = {
      ...CHILD_ENV,
      CLAUDE_CODE_EXECUTABLE: executable,
      ...plan.env,
      // The adapter passes its environment to Claude Code. A session's own options stand over the instance's.
      ...claudeEnv({ ...options.claude, ...plan.claude }),
    };

    const child = await spawnAgent({
      harness: harnessId,
      program,
      args,
      cwd,
      // The child leads its own process group, so a stop reaches everything it started and
      // nothing else.
      detached: true,
      unset: options.unsetEnv,
      env: childEnv,
      box: plan.box,
      needs: CLAUDE_NEEDS,
    }).catch((error: unknown) => {
      if (error instanceof SandboxUnavailable) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      throw new Unavailable(harnessId, "control", ability, `${[program, ...args].join(" ")}: ${cause}`);
    });

    const session = new LiveSession(child);
    owned.add(session);
    let buffer = "";
    let stderrTail = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        handleLine(session, line);
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        // One line longer than the budget is a transport failure, not a session.
        buffer = "";
        session.end("a line of the output stream was longer than the frame budget");
        void stopSession(session);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // stderr is where a failure before any frame shows: not signed in, unknown flag.
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
      const detail = chunk.trim();
      if (detail === "") return;
      session.emit({ kind: "activity", at: Date.now(), detail: `stderr: ${detail}` });
    });

    // A write to a dead child is reported by the closing child, not thrown as an unhandled event.
    child.stdin?.on("error", () => {});

    child.on("error", (error) => {
      owned.delete(session);
      session.end(`the session process failed: ${error.message}`);
    });

    child.on("close", () => {
      owned.delete(session);
      // Whatever the agent started may outlive it; the group is the unit of cleanup.
      if (child.pid !== undefined) signalGroup(session, child.pid, "SIGKILL");
      session.end(
        session.stopping
          ? "the session was stopped"
          : stderrTail.trim() === ""
            ? "the session process closed"
            : stderrTail.trim(),
      );
    });

    const initialized = await call(session, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "niwa", version: "0.1.0" },
    });
    if (!initialized.ok) {
      await stopSession(session);
      throw new Unavailable(
        harnessId,
        "control",
        ability,
        `${[program, ...args].join(" ")}: ${initialized.error ?? "the agent did not answer the handshake"}`,
      );
    }

    return session;
  }

  // -- stopping -------------------------------------------------------------

  /**
   * Stop a session: the process group gets a signal, and a group that does not go gets a hard
   * kill.
   *
   * The group is signalled, not the child alone: the agent starts children of its own, and a
   * child that outlives its parent is a leak.
   */
  async function stopSession(session: LiveSession): Promise<void> {
    const pid = session.child.pid;
    session.stopping = true;
    if (pid === undefined) {
      session.end();
      return;
    }

    if (!hasExited(session)) {
      // Closing stdin tells the agent the conversation is over.
      session.child.stdin?.end();
      signalGroup(session, pid, "SIGTERM");
      if (!(await waitForExit(session, stopGraceMs))) {
        signalGroup(session, pid, "SIGKILL");
        await waitForExit(session, stopGraceMs);
      }
    }
    // The agent's own children may outlive the leader.
    signalGroup(session, pid, "SIGKILL");
    session.end();
  }

  function hasExited(session: LiveSession): boolean {
    return session.child.exitCode !== null || session.child.signalCode !== null;
  }

  /** Signal the child's process group. */
  function signalGroup(session: LiveSession, pid: number, signal: NodeJS.Signals): void {
    try {
      // A negative pid is the group. The child's own pid is the group's leader, because the
      // child was spawned detached.
      process.kill(-pid, signal);
    } catch {
      try {
        session.child.kill(signal);
      } catch {
        // The group is already gone.
      }
    }
  }

  /** Wait for the child to be gone, up to a ceiling. */
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
      if (typeof timer.unref === "function") timer.unref();
      session.child.once("close", onClose);
    });
  }

  // -- the turns ------------------------------------------------------------

  /** The text of a prompt: its sections, in the order they are sent. */
  function promptText(prompt: Prompt): string {
    return prompt.sections.map((section) => section.text).join("\n\n");
  }

  function unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(harnessId, "control", ability, detail);
  }

  /** Open a turn: the session is busy, the answer text starts empty, the turn is announced. */
  function beginTurn(session: LiveSession, turn: number): void {
    session.busy = true;
    session.text = "";
    session.segmentStarts.length = 0;
    session.segmentStarts.push(0);
    session.emit({ kind: "turn-started", turn, at: Date.now() });
  }

  /**
   * Run one turn: send the prompt, wait for the agent's answer.
   *
   * The turn ends at the agent's answer and nowhere else. A turn cut off before it did not
   * end, it stopped.
   */
  async function runTurn(session: LiveSession, text: string, ability: string): Promise<ClaudeAcpTurn> {
    if (session.busy) throw unavailable(ability, "a turn is already running");
    session.turn += 1;
    const turn = session.turn;
    beginTurn(session, turn);
    return await prompt(session, text, turn);
  }

  /**
   * A turn on an idle session, or behind the turn that runs and what already waits: ACP forbids
   * two prompts at once, so a prompt never goes into a busy session. The result of the turn is
   * waited for.
   */
  function turnOn(session: LiveSession, text: string, ability: string): Promise<ClaudeAcpTurn> {
    if (!session.busy) return runTurn(session, text, ability);
    session.turn += 1;
    const turn = session.turn;
    return new Promise<ClaudeAcpTurn>((resolve, reject) => {
      session.queue.push({ text, turn, ask: { resolve, reject } });
    });
  }

  /**
   * Deliver a message the way a send does, and say what became of it.
   *
   * A busy session queues the message behind the running turn; an idle one begins a turn with
   * it. Nothing waits for the turn to end: its end and its failure are signs of life.
   */
  function deliver(session: LiveSession, message: string): DeliveryReceipt {
    const at = Date.now();
    session.turn += 1;
    const turn = session.turn;

    if (session.busy) {
      // A turn is running and the protocol forbids two prompts at once, so the message waits
      // behind it. The queue is a FIFO: the second message must never overwrite the first.
      session.queue.push({ text: message, turn });
      return { status: "queued", turn, at };
    }

    // The session is idle: the message begins a turn. The prompt goes out now and the turn
    // ends when the agent answers it; the receipt does not wait for the answer. A turn that
    // fails is reported through the signs of life, so it is not an unhandled rejection.
    beginTurn(session, turn);
    void prompt(session, message, turn).catch(() => {});
    return { status: "started", turn, at };
  }

  /** The session a session id names, while it can still be driven. */
  function requireSession(id: SessionId, ability: string): LiveSession {
    const session = sessions.get(id.native);
    if (session === undefined) {
      throw unavailable(ability, `the session ${id.native} is not held by this control side`);
    }
    return session;
  }

  /** The session id of a `session/new` or `session/load` result. */
  function sessionIdOf(result: unknown): string | undefined {
    if (typeof result !== "object" || result === null) return undefined;
    const id = (result as Record<string, unknown>).sessionId;
    return typeof id === "string" && id !== "" ? id : undefined;
  }

  /**
   * The `_meta` of a session: the tools switched off and the effort. The adapter passes
   * `_meta.claudeCode.options` to the Claude Code SDK, whose `disallowedTools` takes the names of
   * Claude Code's own tools ("Bash", "WebFetch", ...) and whose `extraArgs` are flags of the
   * program. Nothing to set adds nothing.
   */
  function sessionMetaOf(
    disabled: readonly string[],
    tools: ToolAllowance | undefined,
    effort: string | undefined,
    reverse: ReverseHandler | undefined,
  ): Record<string, unknown> {
    const off = [...new Set([...disabled, ...(tools === undefined ? [] : claudeToolsOff(tools.allow))])];
    const given = {
      ...(off.length === 0 ? {} : { disallowedTools: off }),
      // The program's own `--effort <level>`, for the whole life of the session.
      ...(effort === undefined || effort === "" ? {} : { extraArgs: { effort } }),
    };
    const meta = {
      ...(Object.keys(given).length === 0 ? {} : { claudeCode: { options: given } }),
      // A session whose questions have somewhere to go keeps AskUserQuestion (niwa's adapter entry reads this).
      ...(reverse === undefined ? {} : { niwa: { askUserQuestion: true } }),
    };
    return Object.keys(meta).length === 0 ? {} : { _meta: meta };
  }

  /** Whether two lists name the same tools, in any order. */
  function sameTools(a: readonly string[], b: readonly string[]): boolean {
    const one = new Set(a);
    const two = new Set(b);
    return one.size === two.size && [...one].every((tool) => two.has(tool));
  }

  /**
   * The MCP servers of a session, in Claude Code's ACP dialect.
   *
   * ACP names the servers of the session it opens: the name, the command, its arguments and
   * its environment. The environment is a list of pairs here, each with its name and its
   * value: the same environment niwa names, carried the way this protocol carries it.
   */
  function mcpServersOf(servers: readonly McpServerSpec[] | undefined): Array<Record<string, unknown>> {
    return (servers ?? []).map((server) => ({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    }));
  }

  /** Puts the session in its working mode. A mode the adapter does not take fails the start: a session never runs in another. */
  async function setMode(session: LiveSession, nativeId: string, mode: SessionMode, ability: "start" | "resume"): Promise<void> {
    const chosen = await call(session, "session/set_mode", { sessionId: nativeId, modeId: ADAPTER_MODES[mode] });
    if (!chosen.ok) {
      throw unavailable(ability, `the agent did not take the mode "${mode}": ${chosen.error ?? "unknown reason"}`);
    }
  }

  /** Puts the session on a model. A model the adapter does not take fails the start or the resume: a session never runs on another. */
  async function setModel(session: LiveSession, nativeId: string, model: string, ability: "start" | "resume"): Promise<void> {
    const chosen = await call(session, "session/set_model", { sessionId: nativeId, modelId: model });
    if (!chosen.ok) {
      throw unavailable(ability, `the agent did not take the model "${model}": ${chosen.error ?? "unknown reason"}`);
    }
  }

  /** Stop a session that did not come to life, and forget it. */
  async function abandon(session: LiveSession): Promise<void> {
    if (session.nativeId !== "") sessions.delete(session.nativeId);
    await stopSession(session);
  }

  // -- the contract ---------------------------------------------------------

  return {
    async start(startOptions: StartOptions): Promise<StartedSession> {
      const session = await spawnSession(startOptions.cwd, "start", startOptions);
      try {
        const disabled = startOptions.visible?.disabledTools ?? [];
        const created = await call(session, "session/new", {
          cwd: startOptions.cwd ?? process.cwd(),
          mcpServers: mcpServersOf(startOptions.servers),
          ...sessionMetaOf(disabled, startOptions.tools, startOptions.effort ?? defaultEffort, startOptions.reverse),
        });
        if (!created.ok) {
          throw unavailable("start", created.error ?? "the agent did not start a session");
        }

        const nativeId = sessionIdOf(created.result);
        if (nativeId === undefined) {
          throw unavailable("start", "the agent started a session without naming it");
        }
        session.nativeId = nativeId;
        session.disabledTools = disabled;
        session.reverse = startOptions.reverse;
        sessions.set(nativeId, session);

        // The model and the mode are set on the session that now exists. The adapter chooses
        // its own model when the session is made, so a model given by the environment would be
        // overridden by it.
        const model = startOptions.model ?? defaultModel;
        if (model !== undefined && model !== "") await setModel(session, nativeId, model, "start");
        const mode = modeOf(startOptions.mode, options.mode);
        await setMode(session, nativeId, mode, "start");

        const id = makeSessionId(harnessId, nativeId);
        // The session exists once the agent has named it. The prompt is its first turn,
        // delivered like a send: the start does not wait for the agent to finish it.
        const text = promptText(startOptions.prompt);
        if (text === "") return { session: id, mode };
        return { session: id, first: deliver(session, text), mode };
      } catch (error) {
        // A session whose start failed is not handed to anyone, so nobody could stop it later.
        await abandon(session);
        throw error;
      }
    },

    async resume(id: SessionId, resumeOptions?: ResumeOptions): Promise<void> {
      const text = resumeOptions?.prompt === undefined ? "" : promptText(resumeOptions.prompt);

      // A session this control side already holds continues in the child it already owns: a
      // second child would be a second writer.
      const held = sessions.get(id.native);
      if (held !== undefined && !held.ended && !held.stopping) {
        if (resumeOptions?.tools !== undefined || resumeOptions?.box !== undefined) {
          throw new Unsupported(harnessId, "control", "resume", LIVE_PROCESS_REFUSAL);
        }
        // The session was given its tools when it was started or loaded, and a running one
        // cannot take another set: the same set is no change, a different one is refused.
        const wanted = resumeOptions?.visible?.disabledTools;
        if (wanted !== undefined && !sameTools(wanted, held.disabledTools)) {
          throw new Unsupported(harnessId, "control", "resume", "a running session cannot take another tool set");
        }
        // The one who resumes names where its reverse requests go from now on.
        if (resumeOptions?.reverse !== undefined) held.reverse = resumeOptions.reverse;
        // Its first turn, or another, may still run: the prompt waits behind it.
        if (text !== "") await turnOn(held, text, "resume");
        return;
      }

      // A session this control side does not hold is reattached by the id the agent gave it.
      const session = await spawnSession(resumeOptions?.cwd, "resume", resumeOptions ?? {});
      try {
        const disabled = resumeOptions?.visible?.disabledTools ?? [];
        const loaded = await call(session, "session/load", {
          sessionId: id.native,
          cwd: resumeOptions?.cwd ?? process.cwd(),
          mcpServers: mcpServersOf(resumeOptions?.servers),
          ...sessionMetaOf(disabled, resumeOptions?.tools, defaultEffort, resumeOptions?.reverse),
        });
        if (!loaded.ok) {
          throw unavailable("resume", loaded.error ?? "the agent did not resume the session");
        }
        session.disabledTools = disabled;
        session.reverse = resumeOptions?.reverse;
        const nativeId = sessionIdOf(loaded.result);
        if (nativeId !== undefined && nativeId !== id.native) {
          // A session that came back under another id is not the session that was asked for.
          throw unavailable("resume", "the agent resumed a different session");
        }

        session.nativeId = id.native;
        sessions.set(id.native, session);
        // The adapter chooses its own model when it loads the session: the one the session ran stays.
        if (resumeOptions?.model !== undefined) await setModel(session, id.native, resumeOptions.model, "resume");
        await setMode(session, id.native, modeOf(resumeOptions?.mode, options.mode), "resume");
        if (text !== "") await runTurn(session, text, "resume");
      } catch (error) {
        await abandon(session);
        throw error;
      }
    },

    async send(id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> {
      const session = requireSession(id, "send");
      if (session.ended || session.stopping) {
        throw unavailable("send", session.failure ?? "the session is not running");
      }
      if (sendOptions?.into === "turn" && session.busy) {
        throw new Unsupported(harnessId, "control", "send", "ACP cannot deliver into a running turn");
      }
      return deliver(session, message);
    },

    async interrupt(id: SessionId): Promise<void> {
      const session = requireSession(id, "interrupt");
      if (!session.busy) throw unavailable("interrupt", "no turn is running");

      // An explicit stop clears the queue: firing the messages that waited behind a turn the
      // caller just stopped would be a surprise, not a delivery.
      session.dropQueue("the turn was interrupted");
      session.cancelled = true;

      // The cancel is a hint; only the agent ending the turn proves it. The session stays
      // usable: the turn ends, the child lives.
      notify(session, "session/cancel", { sessionId: id.native });
      // A cancelled turn is answered with cancelled to what it still asks, as ACP wants.
      session.cancelAsking();
      const confirmed = await Promise.race([
        session.whenIdle().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), callTimeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      if (!confirmed) {
        session.cancelled = false;
        throw unavailable("interrupt", "the agent did not confirm the cancel");
      }
    },

    async ask<T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> {
      const session = requireSession(id, "ask");
      // ACP carries no schema in the protocol, so the schema is put into the question and the
      // answer is validated here. The value that comes back is the one that passed.
      const schema = claudeAcpJsonSchema(askOptions.schema);
      const text = `${promptText(askOptions.prompt)}\n\n${schemaText(schema)}`;

      if (session.ended || session.stopping) {
        throw unavailable("ask", session.failure ?? "the session is not running");
      }
      // A busy session takes the question after what runs and what already waits, as its own
      // turn: the question is a queued turn whose answer is waited for.
      const answered = await turnOn(session, text, "ask");
      if (answered.stopReason !== STOP_TURN) {
        throw unavailable("ask", `the agent ended the question with ${answered.stopReason}`);
      }

      const value = askOptions.schema.parse(parseJson(answered.text));
      return { session: id, value, at: timestamp(Date.now()) };
    },

    life(id: SessionId): AsyncIterable<LifeEvent> {
      const session = requireSession(id, "life");
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<LifeEvent> {
          const queue: LifeEvent[] = [];
          let finished = session.ended;
          let wake: (() => void) | undefined;

          const watcher = (event: LifeEvent): void => {
            queue.push(event);
            wake?.();
          };
          session.watch(watcher);
          const unwatchEnd = session.onEnd(() => {
            finished = true;
            wake?.();
          });

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
            unwatchEnd();
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

  /**
   * The last answer segment of the turn.
   *
   * A turn may say several things: what it says before a tool runs is not the answer, and the
   * last segment is. When the turn ended on a tool call, the segment before it is the answer.
   */
  function finalSegment(session: LiveSession): string {
    for (let index = session.segmentStarts.length - 1; index >= 0; index -= 1) {
      const start = session.segmentStarts[index];
      if (start === undefined) continue;
      const segment = session.text.slice(start).trim();
      if (segment !== "") return segment;
    }
    return session.text.trim();
  }

  /** Send the message that waited behind the turn that just ended. */
  function drainQueue(session: LiveSession): void {
    if (session.ended || session.stopping) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    // The queued message begins its own turn, and the turn is announced like any other. A turn
    // that fails drains the next one itself, so the queue never stalls.
    beginTurn(session, next.turn);
    const answered = prompt(session, next.text, next.turn);
    if (next.ask === undefined) void answered.catch(() => {});
    else void answered.then(next.ask.resolve, next.ask.reject);
  }

  /**
   * Send one prompt and wait for the agent's answer.
   *
   * The turn ends at the agent's answer and nowhere else: a turn cut off before it did not end,
   * it stopped.
   */
  async function prompt(session: LiveSession, message: string, turn: number): Promise<ClaudeAcpTurn> {
    // A turn over its time is cancelled, and it ends only when the agent answers the cancelled
    // prompt: until then the agent still holds the prompt and refuses the next one ("a prompt is
    // already active"), so the queue must not drain. An agent that does not answer the cancel
    // within the call timeout has the turn failed all the same.
    const answered = await call(
      session,
      "session/prompt",
      { sessionId: session.nativeId, prompt: [{ type: "text", text: message }] },
      turnTimeoutMs,
      () => {
        session.emit({ kind: "activity", at: Date.now(), detail: "the turn did not end in time: it was cancelled" });
        notify(session, "session/cancel", { sessionId: session.nativeId });
        session.cancelAsking();
      },
    );

    // The turn is over: nothing it asked is waited for any more.
    session.cancelAsking();
    const wasCancelled = session.cancelled;
    session.cancelled = false;
    // The answer is read before the next turn can reset the text.
    const text = finalSegment(session);

    session.settleIdle();
    session.emit({ kind: "turn-ended", turn, at: Date.now() });
    // The queue drains when the turn is over, unless the turn was stopped on request: the
    // messages that waited behind it were dropped on purpose.
    if (wasCancelled) session.dropQueue("the turn was interrupted");
    else drainQueue(session);

    if (!answered.ok) {
      const reason = answered.error ?? "the agent refused the prompt";
      session.emit({ kind: "activity", at: Date.now(), detail: `the turn failed: ${reason}` });
      throw unavailable("send", reason);
    }

    const result = typeof answered.result === "object" && answered.result !== null ? (answered.result as Record<string, unknown>) : {};
    const stopReason = typeof result.stopReason === "string" ? result.stopReason : STOP_MISSING;
    return { stopReason, text };
  }
}

/**
 * The JSON Schema of a zod schema, as a question can carry it.
 *
 * The `$schema` keyword zod adds is removed: it names a dialect that has nothing to do with
 * the shape being asked for.
 */
function claudeAcpJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return stripSchemaKeyword(json);
}

/** Remove the `$schema` keyword from a schema, at every level. */
function stripSchemaKeyword(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "$schema") continue;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      output[key] = stripSchemaKeyword(entry);
    } else if (Array.isArray(entry)) {
      output[key] = entry.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? stripSchemaKeyword(item)
          : item,
      );
    } else {
      output[key] = entry;
    }
  }
  return output;
}

/** The schema as the question carries it. */
function schemaText(schema: Record<string, unknown>): string {
  return [
    "Answer with one JSON object and nothing else. It must match this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

/** Parse a JSON text, or nothing when it is not JSON. */
function parseJson(text: string | undefined): unknown {
  if (text === undefined || text === "") return undefined;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // The answer may be wrapped in a fenced block.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced !== null && fenced[1] !== undefined) {
      try {
        return JSON.parse(fenced[1].trim()) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
