/**
 * The control side for MiniMax Code.
 *
 * It speaks ACP — the Agent Client Protocol — over the child's stdin/stdout: a JSON-RPC
 * conversation with `mcode acp`. It never scrapes stdout: the protocol names the session, the
 * turns and the answers, and everything below is read off it.
 *
 * It owns every `mcode` child it starts, each in its own process group, and stops them itself:
 * an in-protocol `session/cancel`, then SIGTERM to the group, then SIGKILL.
 *
 * The wire discipline: the handshake, the request/reply table, the turn accounting, `followUp`
 * as a FULL `session/prompt` request (so delivery is confirmed), the FIFO queue of follow-ups,
 * and the stop ladder: in-protocol cancel, then SIGTERM, a grace window, then SIGKILL to the
 * group.
 *
 * The mcode-specific facts: the `acp` subcommand, the `initialize` protocol version (the
 * integer 1), the extension gate in `clientCapabilities` (`minimax-code/extensions`, without
 * which mcode offers no steer, no queue and no notifications), the `permissionMode` config
 * option, and the model option's compact `m:<provider>:<model>:u` encoding.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assertNever, timestamp } from "@niwa-labs/core";
import type { Answer, Question } from "@niwa-labs/core";
import {
  InputNotSent,
  InputPossiblySent,
  describeToolsMode,
  modeOf,
  requireLaunch,
  Unavailable,
  Unsupported,
  DEFAULT_TURN_TIMEOUT_MS,
  modelName,
  unknownVariantSigns,
  HarnessIdSchema,
  sessionId as makeSessionId,
} from "@niwa-labs/harness";
import type {
  Dispatch,
  LaunchCapabilities,
  SessionMode,
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  LifeEvent,
  McpServerSpec,
  ModelName,
  PermissionMark,
  Prompt,
  ResumeOptions,
  SendOptions,
  SessionControl,
  SessionState,
  StartOptions,
  StartedSession,
  ToolsMode,
  TurnOutcome,
  VisibleActions,
  SessionId,
  ReverseHandler,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess } from "@niwa-labs/sandbox";

import { AcpClient, acpVariant, answerText, readVariant } from "@niwa-labs/acp";
import type { AgentNotification, AgentRequest, RequestId, RpcOutcome, UnknownVariant } from "@niwa-labs/acp";

import {
  NCODE_ACP_PROTOCOL,
  PERMISSION_MODE_META,
  TURN_STATUS,
  TurnStatusResult,
  ncodeMarks,
  refusesSessionMode,
} from "../ncode/protocol.ts";
import type {
  NcodePermissionMark,
  NcodeSessionMeta,
  NcodeUpdateMarks,
  TurnStatusResult as TurnStatus,
} from "../ncode/protocol.ts";
import { homeOfProfile } from "./paths.ts";
import { externalToolsProgram, NCODE_EXTERNAL_TOOL_FLAGS, ncodeLauncher } from "../ncode/launcher.ts";
import { inputOpen, writeLine } from "./transport.ts";
import { formFields, formSteps, isQuestionnaire, permissionAsk } from "./reverse.ts";
import { Acp, EXTENSIONS_META, MCODE_ACP_PROTOCOL, McodeAgentNotification, McodeAgentRequest, McodeInitializeMeta } from "./protocol.ts";
import type { McodeMethod, McodePermissionMode } from "./protocol.ts";

/**
 * What an mcode session takes at launch: a model and the `thinkingEffort` option, set on the
 * session, and the `permissionMode` option for a working mode. Its own `auto` is a classifier that
 * decides each tool call, so every working mode of niwa has one.
 */
export const MCODE_LAUNCH: LaunchCapabilities = {
  model: true,
  effort: ["default", "low", "medium", "high", "xhigh", "max"],
  modes: ["ask", "auto", "full"],
};

/** The `permissionMode` of an mcode session for each working mode. */
const PERMISSION_MODES = {
  ask: "default",
  auto: "auto",
  full: "bypassPermissions",
} as const satisfies Record<SessionMode, McodePermissionMode>;

/**
 * The two lineages of the harness, which share the wire and the files: `upstream` is the
 * published `@minimax-ai/code`, `fork` is the owner's own build of it. The fork also takes the
 * working mode in `session/new` and marks each tool call with the permission decision.
 */
export type MinimaxLineage = "upstream" | "fork";

/** The program of each lineage when the caller names none: a bare name, resolved through PATH. */
export const DEFAULT_BINARIES: Readonly<Record<MinimaxLineage, string>> = {
  upstream: "mcode",
  fork: "ncode",
};

/**
 * Whether the build of a lineage takes `--profile` on `mcode acp`. The published build exits with
 * its usage text on it, so a profile named for it is refused, never passed on.
 */
export const PROFILE_SUPPORT: Readonly<Record<MinimaxLineage, boolean>> = {
  upstream: false,
  fork: true,
};

export interface McodeControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The lineage of the harness (`upstream` by default). */
  readonly lineage?: MinimaxLineage;
  /** The binary; a bare name is resolved through PATH. Each lineage has a default of its own. */
  readonly binary?: string;
  /** The working mode of sessions, when the caller does not choose one per start. */
  readonly mode?: SessionMode;
  /**
   * What happens when a tool asks for permission, in a mode that can ask. `"allow"` (the default)
   * grants every request, `"deny"` refuses every request. A function answers each request itself;
   * a function that throws denies.
   */
  readonly permissions?: PermissionPolicy;
  /** The model, when the caller does not choose one per start. */
  readonly model?: string;
  /** The thinking effort, when the caller does not choose one per start. */
  readonly effort?: string;
  /** The account profile, when the caller pins one. Each profile is a separate account. */
  readonly profile?: string;
  /** The directory the installation keeps its sessions in; the home of the profile when absent. */
  readonly home?: string;
  /** How long one call (the handshake, a config option, a turn status) waits, in milliseconds. */
  readonly callTimeoutMs?: number;
  /** How long the agent has to let a cancelled turn go, in milliseconds; the call timeout by default. */
  readonly cancelGraceMs?: number;
  /** How long a turn waits for its result, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a graceful stop waits before the hard kill, in milliseconds. */
  readonly stopGraceMs?: number;
}

/** A tool the agent asks to use. */
export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
}

/** What to do with a permission request. */
export type PermissionDecision =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message?: string };

/** How permission requests are answered. */
export type PermissionPolicy =
  | "allow"
  | "deny"
  | ((request: PermissionRequest) => Promise<PermissionDecision>);

/** A `SessionControl` that can also stop what it started. */
export interface McodeSessionControl extends SessionControl {
  /** Stops a session and lets it go: the contract's release of one session. */
  close(id: SessionId): Promise<void>;

  /** Stops a session and the process it owns. */
  stop(id: SessionId): Promise<void>;
  /** Stops every process this control side started, including a start still in progress. */
  dispose(): Promise<void>;
}

/** A request that failed, and how far it got: only an `uncertain` one may have been done. */
class RequestFailed extends Error {
  constructor(
    message: string,
    readonly dispatch: Dispatch,
  ) {
    super(message);
  }
}

/** An error the agent answered with, as JSON-RPC, and the code it came with. */
class AgentRefusal extends RequestFailed {
  constructor(
    message: string,
    readonly code: number | undefined,
    dispatch: Dispatch,
  ) {
    super(message, dispatch);
  }
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
/** The most bytes one stdout line may hold. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How much of stderr is kept to explain a death. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * The extension gate.
 *
 * Without it mcode offers no steer, no queue, no goal and no delegation methods or
 * notifications (the extension version is read from the initialize reply's `_meta`).
 */
const EXTENSION_META = { [EXTENSIONS_META]: { version: 1, notifications: true } } as const;

/** Whether an initialize reply advertises one of the extension methods (the fork's included). */
function servesMethod(reply: Record<string, unknown>, method: McodeMethod | typeof TURN_STATUS): boolean {
  const meta = McodeInitializeMeta.safeParse(reply["_meta"]);
  return meta.success && meta.data[EXTENSIONS_META].methods.includes(method);
}

/**
 * The lineage an initialize reply gives away. The fork serves two requests the published build
 * does not (`turn_status` and `session/history`); a reply that advertises the extensions without
 * them is the published build's. A reply with no extension advertisement says nothing.
 */
export function lineageOfReply(reply: Record<string, unknown>): MinimaxLineage | undefined {
  const meta = McodeInitializeMeta.safeParse(reply["_meta"]);
  if (!meta.success) return undefined;
  const methods = meta.data[EXTENSIONS_META].methods;
  return FORK_ONLY_METHODS.some((method) => methods.includes(method)) ? "fork" : "upstream";
}

/** The requests only the fork serves. */
const FORK_ONLY_METHODS: readonly string[] = [TURN_STATUS, "session/history"];

/** Whether an initialize reply advertises the steer request. */
export function servesSteer(reply: Record<string, unknown>): boolean {
  return servesMethod(reply, "mcode/session/steer");
}

/** How often a turn this side did not send is asked about, in milliseconds. */
const FOREIGN_TURN_POLL_MS = 500;

/** The shape of an ACP model option value: `m:<provider>:<model>:<variant>`. */
const OPTION_VALUE = /^m:[^:]*:[^:]+:(?:u|v:.*)$/;

/**
 * The ACP model option value.
 *
 * A model id is `provider/model` or `provider/model#variant`, and it travels as a compact
 * record: `m:<provider>:<model>:<variant>`. The variant is `u` for "none selected" and
 * `v:<variant>` when one is named.
 *
 * The agent refuses a value it does not advertise: the options it offers are read from the
 * session, and a value outside them is "Model selection is not advertised". So the value is
 * matched against what the session advertised, and the advertised one that fits the id wins.
 *
 * A value that is already an option value is the agent's own naming of a model (the model a
 * session ran): it is taken as it is.
 */
export function mcodeModelOptionValue(
  modelId: string,
  advertised?: readonly { value: string; name?: string }[],
): string {
  if (OPTION_VALUE.test(modelId)) return modelId;
  const [modelPart = modelId, variant] = modelId.split("#", 2);
  const separator = modelPart.indexOf("/");
  const provider = separator === -1 ? "" : modelPart.slice(0, separator);
  const model = separator === -1 ? modelPart : modelPart.slice(separator + 1);
  const suffix =
    variant === undefined || variant === "" ? "u" : `v:${encodeURIComponent(variant)}`;
  const wanted = `m:${encodeURIComponent(provider)}:${encodeURIComponent(model)}:${suffix}`;

  if (advertised !== undefined && advertised.length > 0) {
    const exact = advertised.find((option) => option.value === wanted);
    if (exact !== undefined) return exact.value;
    // A variant that was named is the variant that is asked for: another one is another model's
    // behaviour, so it is left to the agent to refuse.
    if (suffix !== "u") return wanted;
    // The agent offers the same model, of the provider that was named, with other variants. A
    // variant that is empty (`v:`) means "no thinking", and some models — MiniMax-M3.1-Flash
    // among them — refuse it with an internal error, so a named variant is preferred over an
    // empty one.
    const sameModel = advertised.filter((option) => {
      const parts = option.value.split(":");
      return (
        parts.length >= 3 &&
        parts[2] === encodeURIComponent(model) &&
        (provider === "" || parts[1] === encodeURIComponent(provider))
      );
    });
    const named = sameModel.find((option) => {
      const parts = option.value.split(":");
      const variant = parts.slice(3).join(":");
      return variant.startsWith("v:") && variant.length > "v:".length;
    });
    if (named !== undefined) return named.value;
    if (sameModel.length > 0) return sameModel[0]?.value ?? wanted;
  }
  return wanted;
}

/**
 * The model an agent says a session runs: the current value of its `model` config option, as the
 * agent names it. It is an option value, so asking for it again takes it as it is.
 */
function currentModelOf(configOptions: unknown): ModelName | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions as Array<Record<string, unknown>>) {
    const current = option["currentValue"];
    if ((option["id"] === "model" || option["configId"] === "model") && typeof current === "string" && current !== "") {
      return modelName(current);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** The fork's decision on a tool call, as niwa records it: without the fork's free-text reason. */
function permissionMarkOf(mark: NcodePermissionMark): PermissionMark {
  return { decision: mark.decision, decidedBy: mark.decidedBy, ruleKind: mark.ruleKind, mode: mark.mode };
}

/** An upstream update carries no marks: its reading never looks at the fork's `_meta`. */
const UPSTREAM_MARKS: NcodeUpdateMarks = { informational: false, permission: undefined };

/** The people waiting for a turn to settle. */
interface TurnWaiters {
  readonly resolve: (result: TurnResult) => void;
  readonly reject: (error: Error) => void;
}

/** The result of a turn. */
interface TurnResult {
  readonly stopReason: string;
  readonly text: string;
}

/** A message that waits behind the running turn. */
interface QueuedMessage {
  readonly text: string;
  /** The turn this message will run as: the receipt named it. */
  readonly turn: number;
  /** A question waits for the answer of its turn; a plain message does not. */
  readonly ask?: TurnWaiters;
}

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

/** A watcher gets the events, then `undefined` once when the child is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** The stop reason that means the agent finished its turn. */
const STOP_TURN = "end_turn";

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

/** One ACP session: the child, the session id and the turn accounting. */
class AcpSession {
  /** The last turn number handed out; a receipt names the number its turn will run as. */
  turn = 0;
  /** The turn that is running, when one is. */
  current = 0;
  /** Whether a turn is running. */
  running = false;
  /**
   * Whether the agent said, in its initialize reply, that it serves `mcode/session/steer`: the
   * request that lands a message in the turn that is running. Only a fork of mcode may, so
   * nothing is assumed.
   */
  steerable = false;
  /**
   * Whether the agent serves `mcode/session/turn_status`: the read of the turn a session has
   * active, whichever client started it.
   */
  statusable = false;
  /** Whether the child is gone. */
  ended = false;
  /** Whether a stop was asked for: no more writes. */
  stopping = false;
  /** The native session id, once the agent has named it. */
  nativeId = "";
  /**
   * What marks the MCP servers this agent was given.
   *
   * mcode does not start them itself: a long-lived daemon does, in a process group of its own,
   * so neither the agent's group nor its children reach them. The mark is in their environment,
   * and a stop finds them by it.
   */
  readonly mark = randomUUID();
  /**
   * Why the session takes no new work, while the agent holds a turn it did not let go of after its
   * cancel and its grace: what is sent meanwhile would wait behind a turn that may never end.
   */
  held: string | undefined;
  /** The last line written to the child, settled when its input has taken it or failed it. */
  accepted: Promise<void> = Promise.resolve();
  /** The text of the turn that is running. */
  text = "";
  /** The messages written while a turn ran; each becomes its turn when the previous one ends. */
  readonly queued: QueuedMessage[] = [];
  /** Where this session's reverse requests go, when it has been given a place for them. */
  reverse: ReverseHandler | undefined;
  /** The requests of the agent that wait for an answer, by the id the agent gave them. */
  private readonly asking = new Map<AbortController, string>();

  readonly watchers = new Set<Watcher>();
  /**
   * The turn signs before anyone watched: the first turn begins inside `start`, before the
   * caller has the session to watch. The first watcher is given them; after it nothing is kept.
   */
  private unwatched: LifeEvent[] | undefined = [];
  /** The connection to the agent: set as soon as the child is spawned, before anything is written. */
  client!: AcpClient;
  /** Who is waiting for the running turn to settle. */
  turnWaiters: TurnWaiters | undefined;
  /** Who is waiting for no turn to be running. */
  private readonly idleWaiters: Array<() => void> = [];

  /**
   * Why the running turn is over its time, once it is: the turn was cancelled, and it ends as a
   * failure when the agent answers the cancelled prompt.
   */
  overdue: Error | undefined;

  /**
   * Who follows a turn the agent did not let go of in time, when the agent can say when it is
   * over (`turn_status`). Unset, such a turn fails at the end of the grace and what waits goes out.
   */
  follow: ((turn: number, cancelledAt: number) => void) | undefined;

  constructor(
    readonly child: AgentProcess,
    readonly cwd: string,
    readonly niwaOnly: boolean,
    readonly turnTimeoutMs: number,
    /** How long a cancelled turn may take to answer before it is given up on. */
    readonly cancelGraceMs: number,
  ) {}

  /** The agent named the session. */
  named(nativeId: string): void {
    if (this.nativeId !== "") return;
    this.nativeId = nativeId;
  }

  /** Watch the signs of life; the first watcher also gets the turn signs that came before it. */
  watch(watcher: Watcher): void {
    const missed = this.unwatched ?? [];
    this.unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  /** Drop what waits behind the running turn; a question that waited is told why. */
  dropQueue(reason: string): void {
    for (const message of this.queued.splice(0)) message.ask?.reject(new Error(reason));
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

  /** A request of the agent begins to wait: the signal is aborted when the agent stops waiting for it. */
  startAsking(requestId: string): { readonly signal: AbortSignal; readonly done: () => void } {
    const controller = new AbortController();
    this.asking.set(controller, requestId);
    return { signal: controller.signal, done: () => this.asking.delete(controller) };
  }

  /** The agent no longer waits for one request, or for any of them. */
  cancelAsking(requestId?: string): void {
    for (const [controller, asked] of [...this.asking]) {
      if (requestId !== undefined && asked !== requestId) continue;
      this.asking.delete(controller);
      controller.abort();
    }
  }

  /** Hand out the number of the next turn. */
  reserveTurn(): number {
    this.turn += 1;
    return this.turn;
  }

  beginTurn(turn: number): void {
    this.current = turn;
    this.running = true;
    this.overdue = undefined;
    this.text = "";
    this.emit({ kind: "turn-started", turn, at: Date.now() });
  }

  /** Resolves when no turn is running. */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** The turn is over, however it ended: say how, and release those who wait for the idle. */
  private settle(outcome: TurnOutcome): void {
    this.running = false;
    this.held = undefined;
    // The turn is over: nothing it asked is waited for any more.
    this.cancelAsking();
    this.emit({ kind: "turn-ended", turn: this.current, at: Date.now(), outcome });
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  /** The agent answered the prompt: the turn ended. */
  endTurn(result: TurnResult): void {
    // Only an answer that says the turn ended of itself completed it; a cancel, a refusal or a limit did not.
    this.settle(result.stopReason === STOP_TURN ? "completed" : "failed");
    const waiters = this.turnWaiters;
    this.turnWaiters = undefined;
    waiters?.resolve(result);
    this.drain();
  }

  /**
   * The turn did not end with an answer: the agent refused the prompt, or it ran out of time. It
   * failed, unless nobody can tell what became of it.
   */
  failTurn(reason: Error, outcome: TurnOutcome = "failed"): void {
    this.emit({ kind: "activity", at: Date.now(), detail: `the turn failed: ${reason.message}` });
    this.settle(outcome);
    const waiters = this.turnWaiters;
    this.turnWaiters = undefined;
    waiters?.reject(reason);
    this.drain();
  }

  /** A message that waited becomes the next turn. */
  private drain(): void {
    if (this.ended || this.stopping) return;
    const next = this.queued.shift();
    if (next === undefined) return;
    this.beginTurn(next.turn);
    // The waiter for this turn goes in before the prompt goes out, or the reply that ends it
    // would find nobody waiting. A question that waited gets the result of its turn; a plain
    // message has nobody waiting: a failed turn is reported by the signs of life, and the next
    // queued message drains itself.
    const settled = this.awaitTurn();
    if (next.ask === undefined) settled.catch(() => undefined);
    else settled.then(next.ask.resolve, next.ask.reject);
    this.sendPrompt(next.text);
  }

  /** The child is gone: everyone waiting is released, the watchers are told to finish. */
  end(failure: string | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.cancelAsking();
    const reason = new Error(failure ?? "the mcode process is gone");
    this.dropQueue(reason.message);
    this.client.close(reason.message);
    const waiters = this.turnWaiters;
    this.turnWaiters = undefined;
    waiters?.reject(reason);
    for (const waiter of this.idleWaiters.splice(0)) waiter();
    for (const watcher of [...this.watchers]) watcher(undefined);
  }

  /**
   * Register the waiter for the turn that is about to run.
   *
   * The waiter goes in first: the reply to `session/prompt` is what ends the turn, and it may
   * arrive before the line that writes the prompt has returned. A turn that is not answered in
   * time is cancelled, and it fails when the agent answers the cancelled prompt: until then the
   * agent still holds the prompt and refuses the next one ("A prompt is already active"), so the
   * next prompt is never a second prompt at once. An agent that does not answer the cancel
   * within the grace has the turn failed all the same.
   */
  awaitTurn(): Promise<TurnResult> {
    if (this.ended) return Promise.reject(new Error("the mcode process is gone"));
    return new Promise<TurnResult>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        if (this.turnWaiters !== waiters) return;
        const overdue = new Error("the turn did not end in time");
        this.overdue = overdue;
        const cancelledAt = Date.now();
        this.notify("session/cancel", { sessionId: this.nativeId });
        // A cancelled turn is answered with cancelled to what it still asks, as ACP wants.
        this.cancelAsking();
        this.emit({ kind: "activity", at: Date.now(), detail: "the turn did not end in time: it was cancelled" });
        grace = setTimeout(() => {
          if (this.turnWaiters !== waiters) return;
          if (this.follow !== undefined) {
            // The agent can say when the turn is over: whoever waited for it is told it failed,
            // and the turn stays running until the agent lets it go, so nothing is sent into it.
            this.turnWaiters = undefined;
            waiters.reject(overdue);
            this.emit({ kind: "activity", at: Date.now(), detail: "the cancelled turn was not let go: it is followed" });
            this.follow(this.current, cancelledAt);
            return;
          }
          this.failTurn(overdue);
        }, this.cancelGraceMs);
      }, this.turnTimeoutMs);
      const waiters: TurnWaiters = {
        resolve: (result) => {
          clearTimeout(timer);
          clearTimeout(grace);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          clearTimeout(grace);
          reject(error);
        },
      };
      this.turnWaiters = waiters;
    });
  }

  /** Send a notification; a child that is stopping or gone is not written to. */
  notify(method: string, params: Record<string, unknown>): void {
    this.client.notify(method, params);
  }

  /**
   * Send one `session/prompt` for the running turn.
   *
   * The reply to it is what ends the turn: it carries the stop reason, and the text that was
   * streamed while it ran. The reason is returned when the line could not be written at all.
   */
  sendPrompt(text: string): { readonly dispatch: Dispatch; readonly error: string } | undefined {
    const turn = this.current;
    let failed: { readonly dispatch: Dispatch; readonly error: string } | undefined;
    this.client.send(
      "session/prompt",
      { sessionId: this.nativeId, prompt: [{ type: "text", text }] },
      (outcome) => {
        // A line the child's input refused, or failed on, is told before `send` returns.
        if (!outcome.ok && (outcome.dispatch === "unsent" || (outcome.dispatch === "uncertain" && outcome.code === undefined && outcome.timedOut === undefined))) {
          failed = { dispatch: outcome.dispatch, error: outcome.error };
        }
        this.promptAnswered(turn, outcome);
      },
      { timeoutMs: null },
    );
    return failed;
  }

  /**
   * The answer to the prompt of `turn`. Only the answer of the turn that is running ends a turn:
   * the late answer of a turn that was given up on says nothing about the one that came after it.
   */
  promptAnswered(turn: number, outcome: RpcOutcome): void {
    if (turn !== this.current || !this.running) return;
    if (!outcome.ok) {
      // A prompt the agent answered with an error is not a turn that ended.
      this.failTurn(outcome.code === undefined ? new Error(outcome.error) : new AgentRefusal(outcome.error, outcome.code, outcome.dispatch));
      return;
    }
    if (this.overdue !== undefined) {
      // The answer to a prompt that was cancelled for its time: the turn is over now, and it failed.
      this.failTurn(this.overdue);
      return;
    }
    const result = isRecord(outcome.result) ? outcome.result : {};
    this.endTurn({ stopReason: typeof result["stopReason"] === "string" ? result["stopReason"] : "", text: this.text });
  }
}

// ---------------------------------------------------------------------------
// The control side
// ---------------------------------------------------------------------------

export function mcodeControl(options: McodeControlOptions): McodeSessionControl {
  const lineage = options.lineage ?? "upstream";
  const binary = options.binary ?? DEFAULT_BINARIES[lineage];
  const launcher = lineage === "fork" ? ncodeLauncher(binary) : undefined;
  const permissions = options.permissions ?? "allow";
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const cancelGraceMs = options.cancelGraceMs ?? callTimeoutMs;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const defaultModel = options.model;
  const defaultEffort = options.effort;
  const harnessId = HarnessIdSchema.parse(options.harness);
  const home = options.home ?? homeOfProfile(options.profile);

  /** The sessions reachable by id. */
  const sessions = new Map<string, AcpSession>();
  /** Every child this side started and has not seen close, so none can be forgotten. */
  const owned = new Set<AcpSession>();
  /** The processes being started: not owned yet, so a dispose waits for them. */
  const launching = new Set<Promise<AcpSession>>();
  let disposed = false;

  /** Both lineages refuse per-tool policies. Only the fork can take the two isolation flags. */
  function checkTools(ability: string, visible: VisibleActions | undefined, tools?: ToolsMode): void {
    if (typeof tools === "object" || (tools === "niwa-only" && lineage !== "fork")) {
      const detail = lineage === "fork"
        ? "ncode's ACP takes no exact tool flag"
        : "mcode's ACP takes no tool flag, and its --permission policy belongs to `mcode exec`";
      throw new Unsupported(harnessId, "control", ability, `${describeToolsMode(tools)}: ${detail}`);
    }
    const disabled = visible?.disabledTools ?? [];
    if (disabled.length > 0) {
      throw new Unsupported(
        harnessId,
        "control",
        ability,
        `mcode cannot switch off its tools (${disabled.map((tool) => `"${tool}"`).join(", ")})`,
      );
    }
  }

  function unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(harnessId, "control", ability, detail);
  }

  /** A failure of the wire, as the refusal the contract names. */
  function refusal(ability: string, error: unknown): Unavailable {
    if (error instanceof Unavailable) return error;
    return unavailable(ability, error instanceof Error ? error.message : String(error));
  }

  // -- the wire -------------------------------------------------------------

  /** A line of the child's stdout that is not JSON: a warning, never a crash. */
  function handleGarbage(session: AcpSession, line: string): void {
    session.emit({
      kind: "activity",
      at: Date.now(),
      detail: `a line of the agent's output could not be read: ${line.slice(0, 200)}`,
    });
  }

  /** The protocol of this side's lineage, as the unknowns it records name it. */
  const protocol = lineage === "fork" ? NCODE_ACP_PROTOCOL : MCODE_ACP_PROTOCOL;

  /** A message the snapshot of the protocol does not know: recorded as it came, never a crash. */
  function emitUnknown(session: AcpSession, unknown: UnknownVariant): void {
    for (const sign of unknownVariantSigns(Date.now(), unknown.protocol, unknown.variant, unknown.raw)) session.emit(sign);
  }

  /** Refuse a request of the agent, so it never waits on this side. */
  function refuse(session: AcpSession, requestId: RequestId, method: string): void {
    session.client.refuse(requestId, -32601, `niwa does not serve ${method}`);
  }

  /** Refuse a request of a known method whose params do not fit it, with the fields that do not. */
  function refuseParams(session: AcpSession, requestId: RequestId, method: string, invalid: string): void {
    session.client.refuse(requestId, -32602, `invalid params of ${method}: ${invalid}`);
  }

  /** A request of the agent: a permission or a questionnaire is answered, anything else refused. */
  function answerRequest(session: AcpSession, requestId: RequestId, message: AgentRequest): void {
    const read = readVariant(McodeAgentRequest, message, protocol, acpVariant);
    if (!read.ok) {
      emitUnknown(session, read.unknown);
      if (read.invalid === undefined) refuse(session, requestId, read.unknown.variant);
      else refuseParams(session, requestId, read.unknown.variant, read.invalid);
      return;
    }
    const asked = read.value;
    // The params as they came, with what the snapshot of the protocol does not name.
    const params = isRecord(message.params) ? message.params : undefined;
    switch (asked.method) {
      case "session/request_permission":
        void answerPermission(session, requestId, asked.params, params);
        return;
      case "elicitation/create":
        if (session.reverse === undefined) refuse(session, requestId, asked.method);
        else void answerElicitation(session, requestId, params, session.reverse);
        return;
      // The client advertises no file system, no terminal and no MCP transport, and mcode asks for none.
      case "fs/read_text_file":
      case "fs/write_text_file":
      case "terminal/create":
      case "terminal/kill":
      case "terminal/output":
      case "terminal/release":
      case "terminal/wait_for_exit":
      case "mcp/connect":
      case "mcp/disconnect":
      case "mcp/message":
        refuse(session, requestId, asked.method);
        return;
      default:
        assertNever(asked, "mcode ACP request");
    }
  }

  /** A notification: each one is a sign of life, so a silent run and a hung run do not look the same. */
  function handleNotification(session: AcpSession, message: AgentNotification): void {
    const read = readVariant(McodeAgentNotification, message, protocol, acpVariant);
    if (!read.ok) {
      emitUnknown(session, read.unknown);
      return;
    }
    const notification = read.value;
    const at = Date.now();
    switch (notification.method) {
      case "session/update": {
        const update = notification.params.update;
        handleUpdate(session, update, lineage === "fork" ? ncodeMarks(update) : UPSTREAM_MARKS, at);
        return;
      }
      case "$/cancel_request": {
        // The agent stopped waiting for the answer to one of its requests.
        const requestId = notification.params.requestId;
        if (requestId !== null) session.cancelAsking(String(requestId));
        return;
      }
      // The end of a questionnaire niwa answers in one reply, a message of an MCP transport niwa does
      // not offer, and the session, queue, goal and delegation news of the extensions: niwa keeps its
      // own queue and turns, so each is only a sign of life.
      case "elicitation/complete":
      case "mcp/message":
      case "mcode/session/current_session_update":
      case "mcode/session/queue_update":
      case "mcode/session/goal_update":
      case "mcode/session/delegation_update":
        session.emit({ kind: "activity", at, detail: notification.method });
        return;
      default:
        assertNever(notification, "mcode ACP notification");
    }
  }

  /** One `session/update`, with what the fork marked it with (nothing, for upstream). */
  function handleUpdate(session: AcpSession, update: Acp.SessionUpdate, marks: NcodeUpdateMarks, at: number): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        // Service speech rides the same channel as the answer: it must never end up in the
        // text the caller reads.
        if (marks.informational) {
          session.emit({ kind: "activity", at, detail: "informational" });
          return;
        }
        session.text += answerText(update.content);
        session.emit({ kind: "activity", at, detail: "text" });
        return;
      case "tool_call":
      case "tool_call_update": {
        const permission = marks.permission === undefined ? undefined : permissionMarkOf(marks.permission);
        session.emit({ kind: "activity", at, detail: update.sessionUpdate, ...(permission === undefined ? {} : { permission }) });
        return;
      }
      // The replayed history, the thinking, the plan, the commands, the mode, the config, the
      // session's title and the usage: none is part of the answer, each a sign of life.
      case "user_message_chunk":
      case "agent_thought_chunk":
      case "plan":
      case "plan_update":
      case "plan_removed":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        session.emit({ kind: "activity", at, detail: update.sessionUpdate });
        return;
      default:
        assertNever(update, "mcode session update");
    }
  }

  /**
   * Answer the agent's permission request.
   *
   * A session with a place for its reverse requests sends the request there, as a question; any
   * other session answers by its policy. The agent offers its options and this side picks one of
   * them, always a once-only one: an id the agent did not offer is not a choice. When nothing
   * fits the decision, the request is cancelled.
   */
  async function answerPermission(
    session: AcpSession,
    requestId: RequestId,
    asked: Acp.RequestPermissionRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (session.reverse !== undefined) {
      const ask = permissionAsk(params);
      const [answer] = (await reverseAnswer(session, session.reverse, requestId, [ask.question], "session/request_permission", params)) ?? [];
      replyTo(session, requestId, { outcome: answer === undefined ? { outcome: "cancelled" } : ask.outcomeOf(answer) });
      return;
    }

    // A question for a person is not a tool to be allowed: with nobody to ask, it ends as cancelled.
    if (isQuestionnaire(params)) {
      session.emit({ kind: "activity", at: Date.now(), detail: "a question was left unanswered: the session has nowhere to ask it" });
      replyTo(session, requestId, { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall = asked.toolCall;
    const tool = toolCall.title ?? "";
    let decision: PermissionDecision = { behavior: "allow" };
    if (permissions === "deny") {
      decision = { behavior: "deny", message: "niwa denied this request" };
    } else if (typeof permissions === "function") {
      try {
        decision = await permissions({ tool, input: toolCall.rawInput });
      } catch {
        decision = { behavior: "deny", message: "niwa denied this request" };
      }
    }
    const wanted = decision.behavior === "allow" ? "allow_once" : "reject_once";
    const picked = asked.options.find((option) => option.kind === wanted)?.optionId;
    replyTo(session, requestId, {
      outcome: picked === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: picked },
    });
  }

  /**
   * Answer the questionnaire of the agent (`elicitation/create`), one niwa question for each of
   * its steps. A step left without an answer ends the questionnaire: the agent is told it was
   * cancelled, and nothing is answered for the person.
   */
  async function answerElicitation(
    session: AcpSession,
    requestId: RequestId,
    params: Record<string, unknown> | undefined,
    handler: ReverseHandler,
  ): Promise<void> {
    const steps = formSteps(params);
    if (steps === undefined) {
      session.client.refuse(requestId, -32602, "the questionnaire is not a form niwa can ask");
      return;
    }
    const answers = await reverseAnswer(session, handler, requestId, steps.map((step) => step.question), "elicitation/create", params);
    const content: Record<string, string | string[]> = {};
    for (const [index, step] of steps.entries()) {
      const answer = answers?.[index];
      const fields = answer === undefined ? undefined : formFields(step, answer);
      if (fields === undefined) {
        replyTo(session, requestId, { action: "cancel" });
        return;
      }
      Object.assign(content, fields);
    }
    replyTo(session, requestId, { action: "accept", content });
  }

  /**
   * Hand questions to the place a session's reverse requests go, one after the other, and wait for
   * the answers. The agent's wait is the request's: when the agent stops waiting (a cancel, the
   * end of the turn, the end of the process) the questions are aborted and nothing is returned.
   * A handler that fails, or answers nothing, ends the wait as no answer.
   */
  async function reverseAnswer(
    session: AcpSession,
    handler: ReverseHandler,
    requestId: RequestId,
    questions: readonly Question[],
    method: string,
    raw: unknown,
  ): Promise<Answer[] | undefined> {
    const asking = session.startAsking(String(requestId));
    try {
      const answers: Answer[] = [];
      for (const question of questions) {
        if (asking.signal.aborted) return undefined;
        const answer = await handler(makeSessionId(harnessId, session.nativeId), {
          question,
          raw: { method, params: raw },
          signal: asking.signal,
        });
        if ("cancelled" in answer) return undefined;
        answers.push(answer);
      }
      return asking.signal.aborted ? undefined : answers;
    } catch {
      return undefined;
    } finally {
      asking.done();
    }
  }

  /** Answer a request of the agent, once. */
  function replyTo(session: AcpSession, requestId: RequestId, result: Record<string, unknown>): void {
    session.client.reply(requestId, result);
  }

  // -- the child ------------------------------------------------------------

  /** The id of a session that is gone no longer names it, unless a newer process of the same session took the id. */
  function forget(session: AcpSession): void {
    if (sessions.get(session.nativeId) === session) sessions.delete(session.nativeId);
  }

  /** Signal the child's process group: the child leads it, so the signal reaches what it started. */
  function signalGroup(session: AcpSession, signal: NodeJS.Signals): void {
    signalChild(session.child, signal);
  }

  function signalChild(child: AgentProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The group is already gone.
      }
    }
  }

  /**
   * Spawn one agent and wire its streams. Process mode (`MCODE_SERVER_MODE=off`): the agent lives
   * in this process of its own, with the environment of its session, not in the shared daemon
   * `mcoded`, which no wrapper reaches and which could not tell one session's environment from
   * another's.
   */
  async function startProcess(ability: "start" | "resume", cwd: string, plan: Pick<StartOptions, "env" | "box" | "tools">): Promise<AcpSession> {
    if (options.profile !== undefined && !PROFILE_SUPPORT[lineage]) {
      throw new Unsupported(
        harnessId,
        "control",
        "profile",
        `the ${lineage} build of MiniMax Code takes no --profile (it would exit on it); drop the profile "${options.profile}" or use the fork`,
      );
    }
    const launch = launchProcess(ability, cwd, plan);
    launching.add(launch);
    try {
      return await launch;
    } finally {
      launching.delete(launch);
    }
  }

  async function launchProcess(ability: "start" | "resume", cwd: string, plan: Pick<StartOptions, "env" | "box" | "tools">): Promise<AcpSession> {
    const args = ["acp"];
    const niwaOnly = plan.tools === "niwa-only";
    let program = binary;
    const env: Record<string, string> = { MCODE_DISABLE_TELEMETRY: "1", MCODE_SERVER_MODE: "off", ...plan.env };
    if (niwaOnly) {
      // Recheck the bound path on every launch. A launcher can have been replaced since binding.
      // Only the host's PATH may resolve the interpreter of a launcher with an env shebang.
      const isolated = launcher === undefined ? undefined : externalToolsProgram(launcher);
      if (launcher === undefined || isolated === undefined) {
        throw new Unsupported(harnessId, "control", ability, "niwa-only requires an Ncode executable with both --no-builtin-tools and --session-mcp-only");
      }
      program = isolated;
      env.PATH = launcher.searchPath;
      env.MCODE_SERVER_MODE = "off";
      args.push(...NCODE_EXTERNAL_TOOL_FLAGS);
    }
    if (options.profile !== undefined) args.push("--profile", options.profile);
    const child = await spawnAgent({
      harness: harnessId,
      program,
      args,
      cwd,
      env,
      detached: true,
      box: plan.box,
    });
    if (disposed) {
      // The control side was closed while the process was being started: nothing owns it yet, so it goes here.
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      signalChild(child, "SIGKILL");
      await Promise.race([closed, sleep(stopGraceMs)]);
      throw unavailable("start", "the control side is closed");
    }
    const session = new AcpSession(child, cwd, niwaOnly, turnTimeoutMs, cancelGraceMs);
    owned.add(session);

    // A write to a dead child is reported by the closing child, not thrown as an unhandled event.
    child.stdin?.on("error", () => undefined);

    session.client = new AcpClient({
      write: (line) => {
        // A session that is stopping or gone is not written to, and neither is a closed input: the
        // line is certainly unsent then. A line the stream took is accepted, and the stream's own
        // report of it (its callback) is kept for whoever must know the line went out.
        const stdin = child.stdin;
        if (session.ended || session.stopping || !inputOpen(stdin)) return "unsent";
        // A stream that throws on the write leaves it unknown what became of the line: the client says so.
        const taken = writeLine(stdin, line);
        taken.catch(() => undefined);
        session.accepted = taken;
        return "accepted";
      },
      onRequest: (request) => answerRequest(session, request.id, request),
      onNotification: (notification) => handleNotification(session, notification),
      onUnreadable: (line) => handleGarbage(session, line),
      onOverflow: () => {
        // One line longer than the budget is a transport failure, not a session.
        session.end("a line of the agent's output was longer than the frame budget");
        void stopSession(session);
      },
      callTimeoutMs,
      maxLineBytes: MAX_LINE_BYTES,
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => session.client.feed(chunk));

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    child.once("close", (code: number | null) => {
      owned.delete(session);
      forget(session);
      // Whatever the agent started may outlive it; the group is the unit of cleanup, and the MCP
      // servers it was given, which are in no group of its own, go by their mark.
      signalGroup(session, "SIGKILL");
      // A stop that is under way reaps them itself.
      if (!session.stopping) void stopMarked(session.mark);
      session.end(
        `${binary} exited with code ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
      );
    });
    child.once("error", (error: Error) => {
      owned.delete(session);
      if (!session.stopping) void stopMarked(session.mark);
      session.end(`${binary} could not be run: ${error.message}`);
    });

    return session;
  }

  /**
   * Send a request and wait for its reply. A failure is a `RequestFailed` that says how far the
   * request got: an error of the agent is an `AgentRefusal` with its code, and refused only when the
   * code says nothing ran; an answer that did not come in time is uncertain, since whether the
   * agent acted on the request is unknown.
   */
  async function request(
    session: AcpSession,
    method: string,
    params: Record<string, unknown>,
    label: string,
  ): Promise<Record<string, unknown>> {
    if (session.ended || session.stopping) throw new RequestFailed("the agent process is gone", "unsent");
    const outcome = await session.client.request(method, params);
    if (outcome.ok) return isRecord(outcome.result) ? outcome.result : {};
    if (outcome.code !== undefined) throw new AgentRefusal(outcome.error, outcome.code, outcome.dispatch);
    if (outcome.timedOut === true) throw new RequestFailed(`${label} did not finish in time`, "uncertain");
    throw new RequestFailed(outcome.error, outcome.dispatch);
  }

  /** The refusal of an old daemon, which cannot take the mode of a session, as an error that says what to do. */
  function withModeSupport(error: unknown, method: string): unknown {
    if (error instanceof AgentRefusal && refusesSessionMode(error.code, error.message)) {
      return new Error(
        `${method} was refused: the running mcode daemon cannot take a permission mode per session; restart mcoded (the agent said: ${error.message})`,
      );
    }
    return error;
  }

  /** The handshake: initialize, then session/new or session/load, then the config options. */
  async function handshake(
    session: AcpSession,
    model: string | undefined,
    effort: string | undefined,
    mode: SessionMode,
    existing: string | undefined,
    servers: readonly McpServerSpec[] | undefined,
  ): Promise<string> {
    const initialized = await request(
      session,
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "niwa", version: "0.1.0" },
        // A session that has a place for its reverse requests can be asked a questionnaire as a form.
        clientCapabilities: {
          _meta: EXTENSION_META,
          ...(session.reverse === undefined ? {} : { elicitation: { form: {} } }),
        },
      },
      "the initialize handshake",
    );
    // Executables can be overridden or installed under aliases. Refuse a binary that answers
    // with the other lineage before sending it a session request.
    const answered = lineageOfReply(initialized);
    if (lineage === "fork" ? answered !== "fork" : answered === "fork") {
      throw unavailable(
        existing === undefined ? "start" : "resume",
        `${binary} answered as ${answered === "fork" ? "the fork" : answered === undefined ? "a build that names no lineage" : "the published build"}, and this side speaks to ${lineage === "fork" ? "the fork" : "the published build"}`,
      );
    }
    session.steerable = servesSteer(initialized);
    session.statusable = servesMethod(initialized, TURN_STATUS);
    if (session.statusable) {
      session.follow = (turn, cancelledAt) => void followForeignTurn(session, turn, cancelledAt);
    }

    const permissionMode = PERMISSION_MODES[mode];
    const params: Record<string, unknown> = { cwd: session.cwd, mcpServers: mcpServersOf(servers, session.mark) };
    const method = existing === undefined ? "session/new" : "session/load";
    if (existing !== undefined) params["sessionId"] = existing;
    // The fork binds the mode of a session on each open: a load that names none opens it in
    // `default`, not in the mode it had before.
    if (lineage === "fork") params["_meta"] = { [PERMISSION_MODE_META]: permissionMode } satisfies NcodeSessionMeta;
    const result = await request(session, method, params, method).catch((error: unknown) => {
      throw lineage === "fork" ? withModeSupport(error, method) : error;
    });
    // ACP `session/load` answers without a session id (the session is the one that was asked
    // for); only `session/new` names one.
    const reported = existing !== undefined ? existing : result["sessionId"];
    if (typeof reported !== "string" || reported === "") {
      throw new Error(`${method} did not return a session id`);
    }
    if (existing !== undefined && typeof result["sessionId"] === "string" && result["sessionId"] !== existing) {
      throw new Error("the agent named another session than the one that was resumed");
    }
    session.named(reported);

    // The model and the permission mode are config options, applied after the session opens.
    // The model must be one the session advertises: the agent refuses anything else.
    const settings: Array<{ configId: string; value: unknown }> = [];
    settings.push({ configId: "permissionMode", value: permissionMode });
    if (model !== undefined) {
      const advertised = (
        (result["configOptions"] as Array<Record<string, unknown>> | undefined) ?? []
      )
        .filter((option) => option["id"] === "model" || option["configId"] === "model")
        .flatMap((option) => (option["options"] as Array<Record<string, unknown>> | undefined) ?? [])
        .map((option) => ({
          value: String(option["value"] ?? ""),
          name: typeof option["name"] === "string" ? option["name"] : undefined,
        }));
      settings.push({ configId: "model", value: mcodeModelOptionValue(model, advertised) });
    }
    // The agent refuses an effort the selected model does not advertise, and the start fails.
    if (effort !== undefined && effort !== "") settings.push({ configId: "thinkingEffort", value: effort });
    // Each answer to a setting lists the options as they stand: the last one that does says the model the session runs.
    let listed: unknown = result["configOptions"];
    for (const setting of settings) {
      const applied = await request(
        session,
        "session/set_config_option",
        { sessionId: reported, configId: setting.configId, value: setting.value },
        "session/set_config_option",
      );
      listed = applied["configOptions"] ?? listed;
    }
    const running = currentModelOf(listed);
    if (running !== undefined) session.emit({ kind: "model", model: running });
    return reported;
  }

  /** The text of a prompt: the sections, in the order they are sent. */
  function promptText(prompt: Prompt): string {
    return prompt.sections.map((section) => section.text).join("\n\n");
  }

  /** The session of an id, or a refusal. */
  function sessionOf(id: SessionId, ability: string): AcpSession {
    const session = sessions.get(id.native);
    if (session === undefined || session.ended || session.stopping) {
      throw unavailable(ability, `there is no running session "${id.native}"`);
    }
    return session;
  }

  /**
   * The MCP servers of a session, in the dialect of mcode.
   *
   * mcode takes the environment of a server as a list of pairs, each with its name and its
   * value: the same environment niwa names, carried the way this protocol carries it.
   */
  function mcpServersOf(
    servers: readonly McpServerSpec[] | undefined,
    mark: string,
  ): Array<Record<string, unknown>> {
    return (servers ?? []).map((server) => ({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.entries({ ...server.env, [MARK_ENV]: mark }).map(([name, value]) => ({ name, value })),
    }));
  }

  /**
   * Run one turn and wait for its end.
   *
   * The turn ends at the agent's answer and nowhere else: a turn that was refused, cut off or
   * out of time did not end, it failed, and that is a refusal here.
   */
  async function runTurn(session: AcpSession, text: string, ability: string): Promise<TurnResult> {
    if (session.running) throw unavailable(ability, "a turn is already running");
    session.beginTurn(session.reserveTurn());
    // The waiter goes in first: the reply can arrive before the write returns.
    const settled = session.awaitTurn();
    session.sendPrompt(text);
    try {
      return await settled;
    } catch (error) {
      throw refusal(ability, error);
    }
  }

  /**
   * A turn behind what runs and what already waits: the text is queued, and its result is waited
   * for. A turn that failed is a refusal here.
   */
  async function queueTurn(session: AcpSession, text: string, ability: string): Promise<TurnResult> {
    try {
      return await new Promise<TurnResult>((resolve, reject) => {
        session.queued.push({ text, turn: session.reserveTurn(), ask: { resolve, reject } });
      });
    } catch (error) {
      throw refusal(ability, error);
    }
  }

  /**
   * A turn on a running session, or behind the turn that runs: a prompt never goes into a session
   * that is busy, because mcode refuses it ("local_session_busy").
   */
  function turnOn(session: AcpSession, text: string, ability: string): Promise<TurnResult> {
    if (session.held !== undefined) return Promise.reject(unavailable(ability, session.held));
    return session.running ? queueTurn(session, text, ability) : runTurn(session, text, ability);
  }

  /**
   * Take on the turn a loaded session already has active.
   *
   * The turns of mcode run in its daemon, not in the process this side talks to: a turn whose
   * client died (the host was killed, its child with it) runs on, and the session refuses a new
   * prompt until it ends. A loaded session learns of it from `turn_status`. Such a turn is a turn
   * of this session like any other: it has a number, it starts and ends in the signs of life, and
   * what is sent meanwhile waits behind it. Its end is not a reply to a prompt of ours, so it is
   * read off `turn_status` until no turn is active; then what waits goes out. An agent that does
   * not serve `turn_status` cannot say, and nothing is assumed.
   */
  /** The fork's `turn_status` of a session; a reply not of the shape fails like a refusal. */
  async function turnStatus(session: AcpSession): Promise<TurnStatus> {
    return TurnStatusResult.parse(await request(session, TURN_STATUS, { sessionId: session.nativeId }, "the turn status"));
  }

  async function adoptActiveTurn(session: AcpSession): Promise<void> {
    if (!session.statusable) return;
    let status: TurnStatus;
    try {
      status = await turnStatus(session);
    } catch (error) {
      // An agent that advertises the request and cannot answer it is one that cannot say: the
      // resume goes on without it, and nothing is assumed.
      if (session.ended || session.stopping) throw error;
      session.emit({
        kind: "activity",
        at: Date.now(),
        detail: `the turn status could not be read, so no active turn is assumed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (status.activeTurn === null) return;
    const turn = session.reserveTurn();
    session.beginTurn(turn);
    void followForeignTurn(session, turn);
  }

  /**
   * Follow a turn this side did not send until the agent says no turn is active.
   *
   * A turn that runs past the turn timeout is cancelled once, and it is still followed: it is over
   * only when the agent says so, or the next prompt would be refused. A turn the agent still holds
   * a grace after its cancel is held: what waits behind it is dropped, and a question that waited
   * is told which turn holds the session, so nobody waits for it without end. The session stays
   * running, so nothing is sent into it. A status that cannot be read fails the turn, and the
   * child that dies ends it.
   */
  async function followForeignTurn(session: AcpSession, turn: number, cancelledAt?: number): Promise<void> {
    const deadline = Date.now() + turnTimeoutMs;
    let cancelled = cancelledAt;
    let dropped = false;
    const mine = (): boolean => !session.ended && !session.stopping && session.running && session.current === turn;
    for (;;) {
      await sleep(FOREIGN_TURN_POLL_MS);
      if (!mine()) return;
      let status: TurnStatus;
      try {
        status = await turnStatus(session);
      } catch (error) {
        if (!mine()) return;
        session.failTurn(
          new Error(`the turn status could not be read: ${error instanceof Error ? error.message : String(error)}`),
          "unknown",
        );
        return;
      }
      if (!mine()) return;
      // Any active turn makes the session busy, a compaction included: mcode refuses a prompt into
      // either ("local_session_busy").
      if (status.activeTurn === null) {
        // A turn that was cancelled for its time was not answered: it is over, and it failed.
        if (cancelled !== undefined) session.failTurn(new Error("the turn did not end in time"));
        else session.endTurn({ stopReason: STOP_TURN, text: "" });
        return;
      }
      if (cancelled === undefined && Date.now() >= deadline) {
        cancelled = Date.now();
        session.notify("session/cancel", { sessionId: session.nativeId });
        session.emit({ kind: "activity", at: Date.now(), detail: "the turn did not end in time: it was cancelled" });
      }
      if (!dropped && cancelled !== undefined && Date.now() >= cancelled + cancelGraceMs) {
        dropped = true;
        const reason = `the agent holds turn "${status.activeTurn.turnId}" of the session and did not let it go after it was cancelled`;
        session.emit({ kind: "activity", at: Date.now(), detail: reason });
        session.held = reason;
        session.dropQueue(reason);
      }
    }
  }

  /**
   * Deliver a message the way a send does, and say what became of it.
   *
   * A busy session queues the message behind the running turn, with the turn it will run as; an
   * idle one begins a turn with it. Nothing waits for the turn to end: its end and its failure
   * are signs of life.
   */
  async function deliver(session: AcpSession, text: string): Promise<DeliveryReceipt> {
    const at = Date.now();
    const turn = session.reserveTurn();
    if (session.running) {
      // The session is busy: the message waits for the current turn to end, and it goes out
      // as a full session/prompt request, so its delivery is confirmed. The queue is a FIFO.
      session.queued.push({ text, turn });
      return { status: "queued", turn, at };
    }
    session.beginTurn(turn);
    // The waiter for this turn goes in before the prompt goes out: the reply to
    // `session/prompt` is what ends the turn, and it may arrive before this line returns.
    session.awaitTurn().catch(() => undefined);
    const failed = session.sendPrompt(text);
    if (failed !== undefined) {
      if (failed.dispatch === "unsent") throw new InputNotSent(harnessId, "send", failed.error);
      throw new InputPossiblySent(harnessId, "send", failed.error);
    }
    // An agent that does not read its input leaves a large line waiting in the pipe: the wait is bounded,
    // and what is written of it may still be read, so it is not said to be unsent.
    let accepted: "taken" | "slow";
    try {
      accepted = await Promise.race([session.accepted.then(() => "taken" as const), sleep(callTimeoutMs).then(() => "slow" as const)]);
    } catch (error) {
      // The input took the line and failed it: the message did not go out, and the turn it began never ran.
      const reason = error instanceof Error ? error.message : String(error);
      if (session.running && session.current === turn) session.failTurn(new Error(`the prompt could not be written: ${reason}`));
      throw new InputNotSent(harnessId, "send", reason);
    }
    if (accepted === "slow") {
      throw new InputPossiblySent(harnessId, "send", `the agent's input did not take the message within ${callTimeoutMs} ms; part of it may have been read`);
    }
    return { status: "started", turn, at };
  }


  /** The cold resumes in progress, by native session id: a session has one process, however many ask for it. */
  const resuming = new Map<string, Promise<void>>();

  async function resume(id: SessionId, resumeOptions?: ResumeOptions): Promise<void> {
    for (;;) {
      if (disposed) throw unavailable("resume", "the control side is closed");
      checkTools("resume", resumeOptions?.visible, resumeOptions?.tools);
      const session = sessions.get(id.native);
      const text = resumeOptions?.prompt === undefined ? "" : promptText(resumeOptions.prompt);
      // A session that is still live is resumed by resuming its own process: the agent keeps
      // its context, and the prompt is another turn of it.
      if (session !== undefined && !session.ended && !session.stopping) {
        const requested = resumeOptions?.tools;
        if (requested !== undefined && (requested === "niwa-only") !== session.niwaOnly) {
          throw new Unsupported(harnessId, "control", "resume", "cannot change the tool mode of a running Ncode process");
        }
        if (resumeOptions?.box !== undefined) {
          throw new Unsupported(harnessId, "control", "resume", LIVE_PROCESS_REFUSAL);
        }
        // The one who resumes names where its reverse requests go from now on.
        if (resumeOptions?.reverse !== undefined) session.reverse = resumeOptions.reverse;
        if (text.length === 0) return;
        if (session.held !== undefined) throw unavailable("resume", session.held);
        if (session.running) {
          session.queued.push({ text, turn: session.reserveTurn() });
          return;
        }
        await runTurn(session, text, "resume");
        return;
      }
      // A resume of this session is already bringing its process up: wait for it, then resume what
      // it brought up, with this caller's own prompt and reverse handler. If it failed, this one tries.
      const inflight = resuming.get(id.native);
      if (inflight !== undefined) {
        await inflight.catch(() => undefined);
        continue;
      }
      const work = resumeCold(id, resumeOptions, session?.cwd, text);
      resuming.set(id.native, work);
      try {
        await work;
      } finally {
        if (resuming.get(id.native) === work) resuming.delete(id.native);
      }
      return;
    }
  }

  /** Bring a session whose process is gone back up in a new one. */
  async function resumeCold(
    id: SessionId,
    resumeOptions: ResumeOptions | undefined,
    lastCwd: string | undefined,
    text: string,
  ): Promise<void> {
    const mode = modeOf(resumeOptions?.mode, options.mode, MCODE_LAUNCH);
    requireLaunch(harnessId, MCODE_LAUNCH, { mode });
    const fresh = await startProcess("resume", resumeOptions?.cwd ?? lastCwd ?? process.cwd(), resumeOptions ?? {});
    fresh.reverse = resumeOptions?.reverse;
    try {
      const nativeId = await handshake(fresh, resumeOptions?.model ?? defaultModel, defaultEffort, mode, id.native, resumeOptions?.servers);
      // The session may still have a turn running: the one that was cut off with the process
      // that sent it. What comes next waits behind it.
      await adoptActiveTurn(fresh);
      sessions.set(nativeId, fresh);
      if (text.length > 0) await turnOn(fresh, text, "resume");
    } catch (error) {
      await stopSession(fresh);
      throw refusal("resume", error);
    }
  }

  // -- the control side -----------------------------------------------------

  return {
    async start(startOptions: StartOptions): Promise<StartedSession> {
      if (disposed) throw unavailable("start", "the control side is closed");
      checkTools("start", startOptions.visible, startOptions.tools);
      const model = startOptions.model ?? defaultModel;
      const effort = startOptions.effort ?? defaultEffort;
      const mode = modeOf(startOptions.mode, options.mode, MCODE_LAUNCH);
      requireLaunch(harnessId, MCODE_LAUNCH, { model, effort, mode });
      const cwd = startOptions.cwd ?? process.cwd();
      const session = await startProcess("start", cwd, startOptions);
      session.reverse = startOptions.reverse;
      let nativeId: string;
      try {
        nativeId = await handshake(
          session,
          model,
          effort,
          mode,
          undefined,
          startOptions.servers,
        );
      } catch (error) {
        // A session whose start failed is not handed to anyone, so nobody could stop it later.
        await stopSession(session);
        throw refusal("start", error);
      }
      sessions.set(nativeId, session);
      const id = makeSessionId(harnessId, nativeId);
      // The caller knows the session before its prompt goes: a start cut off while its first turn
      // is on the way still finds it. A session whose name could not be kept is given no work.
      try {
        await startOptions.named?.(id);
      } catch (error) {
        await stopSession(session);
        throw error;
      }
      // The session exists once the agent has named it. The prompt is its first turn, delivered
      // like a send: the start does not wait for the agent to finish it.
      const text = promptText(startOptions.prompt);
      if (text.length === 0) return { session: id, mode };
      try {
        return { session: id, first: await deliver(session, text), mode };
      } catch (error) {
        // A start whose first message did not go out is not a start: nobody holds the id to stop it.
        await stopSession(session);
        throw error instanceof InputNotSent ? unavailable("start", `the first message could not be written: ${error.message}`) : error;
      }
    },

    resume,

    async send(id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> {
      const session = sessions.get(id.native);
      if (session === undefined || session.ended || session.stopping) {
        throw new InputNotSent(harnessId, "send", `there is no running session "${id.native}"`);
      }
      if (session.held !== undefined) throw new InputNotSent(harnessId, "send", session.held);
      const at = Date.now();
      if (sendOptions?.into === "turn" && session.running && session.steerable) {
        // Into the running turn: mcode joins the text to the turn between its tool calls and
        // answers with the turn it joined. If it refuses (the turn ended in the meantime, say),
        // the message goes the ordinary way below, which starts a turn or queues behind one. That
        // is so only for a refusal that says the message was not taken: any other failure may
        // have come after mcode took it, and the message is not sent again on a guess.
        const turn = session.current;
        try {
          await request(session, "mcode/session/steer", { sessionId: session.nativeId, text: message }, "the steer");
          return { status: "delivered", turn, at };
        } catch (error) {
          // The process went with the steer on its way, no reply came at all, or the steer failed
          // in a way that does not say it was not taken: mcode may have taken the message.
          if (session.ended || session.stopping) throw new InputPossiblySent(harnessId, "send", refusal("send", error).message);
          if (!(error instanceof RequestFailed) || error.dispatch === "uncertain") {
            const reason = error instanceof Error ? error.message : String(error);
            throw new InputPossiblySent(harnessId, "send", `${reason}; whether the message reached the turn is unknown`);
          }
        }
      }
      return await deliver(session, message);
    },

    async interrupt(id: SessionId): Promise<void> {
      const session = sessionOf(id, "interrupt");
      if (!session.running) throw unavailable("interrupt", "no turn is running");
      // An explicit stop drops what waited behind the turn: firing it would be a surprise.
      session.dropQueue("the turn was interrupted");
      // The cancel is a hint; only the agent ending the turn proves it.
      session.notify("session/cancel", { sessionId: session.nativeId });
      // A cancelled turn is answered with cancelled to what it still asks, as ACP wants.
      session.cancelAsking();
      const confirmed = await Promise.race([
        session.whenIdle().then(() => true),
        sleep(cancelGraceMs).then(() => false),
      ]);
      if (!confirmed) throw unavailable("interrupt", "the agent did not confirm the cancel");
    },

    async ask<T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> {
      const session = sessionOf(id, "ask");
      const schema = askOptions.schema;
      // The schema travels to the agent as a JSON schema, and the answer is checked against
      // the zod schema here: an answer that does not pass is not an answer.
      const jsonSchema = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Record<
        string,
        unknown
      >;
      const instruction = [
        promptText(askOptions.prompt),
        "",
        "Answer with JSON only, matching this schema exactly:",
        JSON.stringify(jsonSchema),
      ].join("\n");

      // A busy session takes the question after what runs and what already waits, as its own
      // turn: the question is a queued turn whose answer is waited for.
      const result = await turnOn(session, instruction, "ask");
      if (result.stopReason !== STOP_TURN) {
        throw unavailable("ask", `the agent ended the question with "${result.stopReason}"`);
      }
      const checked = schema.safeParse(parseJson(result.text));
      if (!checked.success) {
        throw unavailable(
          "ask",
          `the answer did not pass the schema: ${checked.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
        );
      }
      return { session: id, value: checked.data, at: timestamp(Date.now()) };
    },

    async *life(id: SessionId): AsyncIterable<LifeEvent> {
      const session = sessionOf(id, "life");
      // The stream carries what happens from now on: a watcher that arrives after a turn
      // began does not see that turn.
      const queue: LifeEvent[] = [];
      let done = false;
      let wake: (() => void) | undefined;
      const watcher: Watcher = (event) => {
        if (event === undefined) {
          done = true;
        } else {
          queue.push(event);
        }
        wake?.();
      };
      session.watch(watcher);
      try {
        for (;;) {
          const event = queue.shift();
          if (event !== undefined) {
            yield event;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        // Only this reader's watcher goes: the others keep theirs.
        session.watchers.delete(watcher);
      }
    },

    async state(id: SessionId): Promise<SessionState> {
      const session = sessions.get(id.native);
      // A session not held, or whose child is gone, proves nothing about now.
      if (session === undefined || session.ended || session.stopping) return "unknown";
      return session.running ? "running" : "idle";
    },

    /** The release the shared contract names: stops this session's process and no other. */
    async close(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      await stopSession(session);
    },

    async stop(id: SessionId): Promise<void> {
      const session = sessions.get(id.native);
      if (session === undefined) return;
      await stopSession(session);
    },

    async dispose(): Promise<void> {
      disposed = true;
      // A start that is still launching its process reaps it itself once the process exists.
      await Promise.allSettled([...launching]);
      await Promise.all([...owned].map((session) => stopSession(session)));
      owned.clear();
      sessions.clear();
    },
  };

  /** Stop one child: an in-protocol cancel, then SIGTERM to the group, then SIGKILL. */
  async function stopSession(session: AcpSession): Promise<void> {
    owned.delete(session);
    forget(session);
    const child = session.child;
    const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
    if (!gone() && !session.stopping) {
      // The polite way first, while writes still go out: the agent stops the turn itself.
      if (session.nativeId !== "") session.notify("session/cancel", { sessionId: session.nativeId });
      session.stopping = true;
    }
    // Everyone waiting is released now: a stop does not leave a call hanging.
    session.end(undefined);
    if (child.pid === undefined) return;
    if (!gone()) {
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      signalGroup(session, "SIGTERM");
      await Promise.race([closed, sleep(stopGraceMs)]);
    }
    // The agent's own children may outlive the leader, so the group gets the last word.
    signalGroup(session, "SIGKILL");
    // The MCP servers the agent was given are not in its group: they go by their mark.
    await stopMarked(session.mark);
  }
}

/** The environment variable that marks the MCP servers of one agent. */
const MARK_ENV = "NIWA_MCP_OWNER";

/** The pids of the processes that carry a mark in their environment. */
function markedPids(mark: string): number[] {
  // "ps e" shows the environment of the processes of the same user after the command. With every
  // environment the list easily passes the default 1 MB, and a list cut there misses the servers.
  const listed = spawnSync("ps", ["eww", "-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  }).stdout;
  const found: number[] = [];
  for (const line of listed.split("\n")) {
    if (!line.includes(`${MARK_ENV}=${mark}`)) continue;
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (Number.isInteger(pid) && pid !== process.pid) found.push(pid);
  }
  return found;
}

/** Stop the processes that carry a mark: SIGTERM, then SIGKILL for what stays. */
async function stopMarked(mark: string): Promise<void> {
  const signalAll = (signal: NodeJS.Signals): number[] => {
    const pids = markedPids(mark);
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    return pids;
  };
  if (signalAll("SIGTERM").length === 0) return;
  await sleep(200);
  signalAll("SIGKILL");
}

/** A wait that does not hold the loop open. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** The JSON in an answer, or the answer itself when it is not JSON. */
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // The agent may wrap the JSON in a fence; the first object or array in it is the answer.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced === null ? trimmed : fenced[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start === -1) return body;
    try {
      return JSON.parse(body.slice(start));
    } catch {
      return body;
    }
  }
}
