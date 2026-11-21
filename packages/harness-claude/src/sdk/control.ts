/**
 * The control side for the Claude Agent SDK.
 *
 * The SDK runs the owner's Claude Code (the `claude` on the PATH, unless the instance names
 * another program), so a session it starts is an ordinary Claude Code session: the same files,
 * the same ids. The session id and the model are the ones in the `system/init` message.
 * Every query has an AbortController and is stopped by `dispose`; a message sent while a turn
 * runs goes into the query's input stream and is counted as queued.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options as SdkOptions,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Answer, Question } from "@niwa-labs/core";
import { timestamp } from "@niwa-labs/core";
import {
  modeOf,
  requireLaunch,
  Unavailable,
  Unsupported,
  DEFAULT_TURN_TIMEOUT_MS,
  modelName,
  HarnessIdSchema,
  sessionId as makeSessionId,
} from "@niwa-labs/harness";
import type {
  LaunchCapabilities,
  SessionMode,
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  LifeEvent,
  ModelName,
  Prompt,
  ResumeOptions,
  SendOptions,
  SessionControl,
  SessionState,
  StartOptions,
  StartedSession,
  VisibleActions,
  HarnessId,
  ClaudeOptions,
  SessionId,
  ReverseHandler,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, requireBox, spawnAgentNow } from "@niwa-labs/sandbox";

import { localClaude } from "../code/control.ts";
import { CLAUDE_NEEDS } from "../code/needs.ts";
import { claudeEnv } from "../code/options.ts";

import { signsOf } from "./messages.ts";
import { answerText, permissionQuestion, permissionResult, questionsOf, rawRequest } from "./reverse.ts";
import { MessageStream } from "./stream.ts";

/** What a session's process is given beyond the options of the query: its environment, its tools, its box. */
type ProcessPlan = Pick<StartOptions, "env" | "tools" | "box" | "reverse"> & {
  readonly mode: SessionMode;
  readonly claude: ClaudeOptions;
};

/** The SDK's tool that asks a person questions. */
const ASK_USER_QUESTION = "AskUserQuestion";

/** A tool the session asks to use. */
export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly toolUseId: string | undefined;
}

/** What the owner decided about a tool. */
export type PermissionDecision =
  | { readonly behavior: "allow"; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message?: string };

/**
 * What happens when a tool asks for permission.
 *
 * `"allow"` (the default) lets the tool run. `"deny"` refuses every one of them. A function is
 * asked for each request and decides; a function that throws denies.
 */
export type PermissionPolicy =
  | "allow"
  | "deny"
  | ((request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision);

/**
 * What the control side uses of the SDK's `query`: a stream of messages in, a stream of messages
 * out, and the two calls that stop it. The real `query` is one; a test supplies another.
 */
export type SdkQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: SdkOptions;
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

/** The effort levels of the SDK's `effort` option. */
const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);

/**
 * What a Claude Agent SDK session takes at launch: a model, the SDK's effort level, and its
 * permission mode: `ask` is `default`, `auto` is `auto` (a classifier decides each call), `full`
 * is `bypassPermissions`.
 */
export const CLAUDE_SDK_LAUNCH: LaunchCapabilities = {
  model: true,
  effort: [...EffortLevel.options],
  modes: ["ask", "auto", "full"],
};

/** The SDK's permission mode for each working mode. */
const PERMISSION_MODES = { ask: "default", auto: "auto", full: "bypassPermissions" } as const;

/** What the control side needs. */
export interface ClaudeSdkControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The model, when the caller does not choose one per start. */
  readonly model?: string;
  /** The effort level, when the caller does not choose one per start. */
  readonly effort?: string;
  /** The working mode, when the caller does not choose one per start. Default: `auto`. */
  readonly mode?: SessionMode;
  /** What happens when a tool asks for permission, in the modes that can ask. */
  readonly permissions?: PermissionPolicy;
  /** How long a turn waits for its result, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a start waits for the SDK to name the session, in milliseconds. */
  readonly startTimeoutMs?: number;
  /**
   * The Claude Code program the SDK runs, as a path. It defaults to the `claude` on the PATH: the
   * owner's own Claude Code, never the copy the SDK carries. A start with neither this nor a
   * `claude` on the PATH fails and says so.
   */
  readonly executable?: string;
  /** The options of the Claude kind, when the caller does not give them per start. */
  readonly claude?: ClaudeOptions;
  /** The SDK's `query`. Default: the real one, over the executable; a test gives a fake that runs no process. */
  readonly query?: SdkQuery;
}

const DEFAULT_START_TIMEOUT_MS = 120_000;

/** A watcher gets events, then `undefined` once the query is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** How many turn signs are kept for the first watcher of a session. */
const UNWATCHED_LIMIT = 64;

/** One live session: its query, its turn accounting, and the people waiting on it. */
class LiveSession {
  /** The turns started so far; the running one, if any, has this number. */
  turn = 0;
  running = false;
  /** Messages written while a turn ran; each becomes a turn when the previous result arrives. */
  queued = 0;
  ended = false;
  /** The id the SDK gave the session; empty until the `system/init` message. */
  nativeId: string;
  /** The model the program named for the session in its `system/init` message; unset until then. */
  model: ModelName | undefined;
  /** Where the session's reverse requests go; the one who resumes it names it afresh. */
  reverse: ReverseHandler | undefined;
  /** The reverse requests waiting for an answer: aborted when the SDK stops waiting for them. */
  readonly #asking = new Set<AbortController>();

  readonly watchers = new Set<Watcher>();
  /**
   * The turn signs before anyone watched: the first turn begins inside `start`, before the
   * caller has the session to watch. The first watcher is given them; after it nothing is kept.
   */
  #unwatched: LifeEvent[] | undefined = [];
  readonly resultWaiters: Array<(result: SDKResultMessage | undefined) => void> = [];
  readonly nameWaiters: Array<{ resolve: (id: string) => void; reject: (error: Error) => void }> =
    [];

  constructor(
    readonly query: ReturnType<SdkQuery>,
    readonly input: MessageStream,
    readonly abort: AbortController,
    nativeId: string,
    reverse: ReverseHandler | undefined,
  ) {
    this.nativeId = nativeId;
    this.reverse = reverse;
  }

  /**
   * A reverse request begins to wait. Its signal is aborted when the SDK cancels the call, when the
   * turn ends, or when the query is gone: whenever nobody waits for the answer any more.
   */
  startAsking(cancelled: AbortSignal): { readonly signal: AbortSignal; readonly done: () => void } {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    if (cancelled.aborted) cancel();
    cancelled.addEventListener("abort", cancel, { once: true });
    this.#asking.add(controller);
    return {
      signal: controller.signal,
      done: () => {
        cancelled.removeEventListener("abort", cancel);
        this.#asking.delete(controller);
      },
    };
  }

  #stopAsking(): void {
    for (const controller of this.#asking) controller.abort();
  }

  /** The `system/init` message names the session. */
  named(nativeId: string): void {
    if (this.nativeId !== "") return;
    this.nativeId = nativeId;
    for (const waiter of this.nameWaiters.splice(0)) waiter.resolve(nativeId);
  }

  /** Watch the signs of life; the first watcher also gets the turn signs that came before it. */
  watch(watcher: Watcher): void {
    const missed = this.#unwatched ?? [];
    this.#unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  emit(event: LifeEvent): void {
    if (this.#unwatched !== undefined && event.kind !== "activity") {
      this.#unwatched.push(event);
      if (this.#unwatched.length > UNWATCHED_LIMIT) this.#unwatched.shift();
    }
    for (const watcher of [...this.watchers]) {
      try {
        watcher(event);
      } catch {
        // A broken watcher must not break the session.
      }
    }
  }

  /**
   * Resolves when no turn runs and none waits, or when the query is gone; `false` when a turn
   * did not end within the timeout.
   */
  async whenIdle(timeoutMs: number): Promise<boolean> {
    while (!this.ended && (this.running || this.queued > 0)) {
      if ((await this.awaitResult(timeoutMs)) === undefined && !this.ended) return false;
    }
    return true;
  }

  /** Resolves with the next result, or `undefined` on timeout or when the query is gone. */
  awaitResult(timeoutMs: number): Promise<SDKResultMessage | undefined> {
    if (this.ended) return Promise.resolve(undefined);
    return new Promise<SDKResultMessage | undefined>((resolve) => {
      const waiter = (result: SDKResultMessage | undefined): void => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const at = this.resultWaiters.indexOf(waiter);
        if (at !== -1) this.resultWaiters.splice(at, 1);
        resolve(undefined);
      }, timeoutMs);
      this.resultWaiters.push(waiter);
    });
  }

  beginTurn(): number {
    this.turn += 1;
    this.running = true;
    this.emit({ kind: "turn-started", turn: this.turn, at: Date.now() });
    return this.turn;
  }

  /** The result ended the running turn; a queued message, if any, is the next turn. */
  endTurn(result: SDKResultMessage): void {
    this.running = false;
    this.#stopAsking();
    this.emit({ kind: "turn-ended", turn: this.turn, at: Date.now() });
    for (const waiter of this.resultWaiters.splice(0)) waiter(result);
    if (this.queued > 0) {
      this.queued -= 1;
      this.beginTurn();
    }
  }

  /** The query is gone: everyone waiting is released and the watchers are told to finish. */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.queued = 0;
    this.#stopAsking();
    for (const waiter of this.resultWaiters.splice(0)) waiter(undefined);
    for (const waiter of this.nameWaiters.splice(0)) waiter.reject(new Error(reason));
    for (const watcher of [...this.watchers]) watcher(undefined);
  }

  /** Aborts the query, closes its input and releases everyone waiting. */
  stop(reason: string): void {
    this.abort.abort();
    this.input.close();
    this.query.close();
    this.end(reason);
  }
}

/** The control side of the Claude Agent SDK. */
export class ClaudeSdkControl implements SessionControl {
  readonly #harness: HarnessId;
  readonly #model: string | undefined;
  readonly #effort: string | undefined;
  readonly #mode: SessionMode | undefined;
  readonly #permissions: PermissionPolicy;
  readonly #turnTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #query: SdkQuery;
  readonly #claude: ClaudeOptions;
  /** The sessions reachable by id. */
  readonly #sessions = new Map<string, LiveSession>();
  /** Every query this side started and has not seen end, so none can be forgotten. */
  readonly #owned = new Set<LiveSession>();
  /** The resume in flight per session id. */
  readonly #resuming = new Map<string, Promise<void>>();
  /** The question in flight per session id: one query over a session at a time. */
  readonly #asking = new Map<string, Promise<unknown>>();
  /** What each session's process was given, so a question over the session runs under the same limits. */
  readonly #plans = new Map<string, ProcessPlan>();
  #disposed = false;

  constructor(options: ClaudeSdkControlOptions) {
    this.#harness = HarnessIdSchema.parse(options.harness);
    this.#model = options.model;
    this.#effort = options.effort;
    this.#mode = options.mode;
    this.#claude = options.claude ?? {};
    this.#permissions = options.permissions ?? "allow";
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#query = options.query ?? ((params) => this.#localQuery(options.executable, params));
  }

  /** The SDK's own `query`, run over the owner's Claude Code: the executable given, else the `claude` on the PATH. */
  #localQuery(executable: string | undefined, params: Parameters<SdkQuery>[0]): ReturnType<SdkQuery> {
    let program: string;
    try {
      program = executable ?? localClaude();
    } catch (error) {
      throw this.#unavailable("start", error instanceof Error ? error.message : String(error));
    }
    return sdkQuery({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: program } });
  }

  /**
   * Start a session; the id is the one the SDK named it with.
   *
   * The SDK names a session in the `system/init` message of its first turn, so the start returns
   * when that turn has begun and been named, not when it ends.
   */
  async start(options: StartOptions): Promise<StartedSession> {
    const { system, turn } = splitPrompt(options.prompt);
    if (turn === "") {
      throw new Unsupported(
        this.#harness,
        "control",
        "start",
        "a session is named on its first turn, so a start needs a volatile section",
      );
    }
    const model = options.model ?? this.#model;
    const effort = options.effort ?? this.#effort;
    const mode = modeOf(options.mode, this.#mode, CLAUDE_SDK_LAUNCH);
    requireLaunch(this.#harness, CLAUDE_SDK_LAUNCH, { model, effort, mode });
    await requireBox(options.box);
    const plan: ProcessPlan = {
      env: options.env,
      tools: options.tools,
      box: options.box,
      reverse: options.reverse,
      mode,
      claude: { ...this.#claude, ...options.claude },
    };
    const session = this.#open(
      this.#sdkOptions(model, effort, system, options.visible, options.cwd, plan),
      "",
      plan.reverse,
    );
    let first: DeliveryReceipt | undefined;
    const nativeId = await this.#ownedBy(session, async () => {
      first = this.#submit(session, turn);
      return await this.#awaitName(session);
    });
    this.#sessions.set(nativeId, session);
    this.#plans.set(nativeId, plan);
    const id = makeSessionId(this.#harness, nativeId);
    return first === undefined ? { session: id, mode } : { session: id, first, mode };
  }

  /** Resume a session; the SDK reads the same files back. */
  async resume(id: SessionId, options?: ResumeOptions): Promise<void> {
    // One query per session id: a resume waits for the one in flight, then finds it held.
    const previous = this.#resuming.get(id.native);
    const run = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#resumeOnce(id, options));
    this.#resuming.set(id.native, run);
    try {
      await run;
    } finally {
      if (this.#resuming.get(id.native) === run) this.#resuming.delete(id.native);
    }
  }

  /** Send into a session and say what became of the message. */
  async send(id: SessionId, message: string, options?: SendOptions): Promise<DeliveryReceipt> {
    const session = this.#require(id, "send");
    if (options?.into === "turn" && session.running) {
      throw new Unsupported(this.#harness, "control", "send", "the SDK cannot deliver into a running turn");
    }
    return this.#submit(session, message);
  }

  /** Interrupt the running turn; the session takes the next message afterwards. */
  async interrupt(id: SessionId): Promise<void> {
    const session = this.#require(id, "interrupt");
    if (!session.running) throw this.#unavailable("interrupt", "no turn is running");
    try {
      await session.query.interrupt();
    } catch (error) {
      throw this.#unavailable("interrupt", `the SDK refused the interrupt: ${String(error)}`);
    }
    if (session.running && (await session.awaitResult(this.#turnTimeoutMs)) === undefined) {
      throw this.#unavailable("interrupt", "the turn did not end after the interrupt");
    }
  }

  /**
   * Ask a session and return a value that passed the schema.
   *
   * The question runs in a query of its own over the same session, so it waits until the held
   * session has no turn running or waiting, and until the question before it is over: two
   * queries writing one session at once would be two writers.
   */
  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    const { turn } = splitPrompt(options.prompt);
    if (turn === "") {
      throw new Unsupported(this.#harness, "control", "ask", "a question needs a volatile section");
    }
    const previous = this.#asking.get(id.native);
    const run = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#askOnce(id, options));
    this.#asking.set(id.native, run);
    try {
      return await run;
    } finally {
      if (this.#asking.get(id.native) === run) this.#asking.delete(id.native);
    }
  }

  async #askOnce<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    const { system, turn } = splitPrompt(options.prompt);
    const busy = this.#sessions.get(id.native);
    if (busy !== undefined && !busy.ended && !(await busy.whenIdle(this.#turnTimeoutMs))) {
      throw this.#unavailable("ask", "the turn before the question did not end in time");
    }
    // Its own query over the same session id: the question cannot disturb a running turn. It runs
    // under the limits the session's own process was given.
    const stored = this.#plans.get(id.native) ?? { mode: modeOf(undefined, this.#mode, CLAUDE_SDK_LAUNCH), claude: this.#claude };
    // A question is asked on behalf of the session: what it asks of its client goes where the session's does.
    const plan: ProcessPlan = { ...stored, claude: { ...stored.claude, ...options.claude }, reverse: busy?.reverse ?? stored.reverse };
    await requireBox(plan.box);
    const session = this.#open(
      {
        ...this.#sdkOptions(busy?.model ?? this.#model, this.#effort, system, undefined, undefined, plan),
        resume: id.native,
        outputFormat: { type: "json_schema", schema: jsonSchemaOf(options.schema) },
      },
      id.native,
      plan.reverse,
    );
    // The question is a turn of the session, though it runs in its own query: whoever watches the
    // session sees it begin and end. While a turn runs, the question stays unseen, as it cannot
    // be numbered without clashing with that turn.
    const held = this.#sessions.get(id.native);
    const watched = held !== undefined && !held.ended && !held.running ? held : undefined;
    if (watched !== undefined) {
      watched.turn += 1;
      watched.emit({ kind: "turn-started", turn: watched.turn, at: Date.now() });
    }
    const asked = watched?.turn;
    try {
      session.input.push(userMessage(turn));
      const result = await this.#runTurn(session);
      const raw = result.structured_output ?? parseJson(result.result);
      return { session: id, value: options.schema.parse(raw), at: timestamp(Date.now()) };
    } finally {
      session.stop("the question is over");
      if (watched !== undefined && asked !== undefined) {
        watched.emit({ kind: "turn-ended", turn: asked, at: Date.now() });
      }
    }
  }

  /** The signs of life, as they happen. */
  life(id: SessionId): AsyncIterable<LifeEvent> {
    const session = this.#require(id, "life");
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
  }

  /** What the session is doing; `unknown` when this side cannot know. */
  async state(id: SessionId): Promise<SessionState> {
    const session = this.#sessions.get(id.native);
    if (session === undefined || session.ended) return "unknown";
    return session.running ? "running" : "idle";
  }

  /** Stops every query this side started, including a start still in progress. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#sessions.clear();
    for (const session of [...this.#owned]) session.stop("the control side is disposed");
  }

  // -- the internals --------------------------------------------------------

  /** Starts a query that reads its messages from a stream; it is owned from here on. */
  #open(options: SdkOptions, nativeId: string, reverse: ReverseHandler | undefined): LiveSession {
    if (this.#disposed) throw this.#unavailable("start", "the control side is disposed");
    const input = new MessageStream();
    const abort = new AbortController();
    // `full` lets every tool run and asks nothing, but a session with a place for its reverse
    // requests still takes the questions of its agent.
    const gated = options.permissionMode !== "bypassPermissions" || reverse !== undefined;
    const query = this.#query({
      prompt: input,
      options: {
        ...options,
        abortController: abort,
        ...(gated ? { canUseTool: (tool, toolInput, context) => this.#canUseTool(session, tool, toolInput, context) } : {}),
      },
    });
    const session = new LiveSession(query, input, abort, nativeId, reverse);
    this.#owned.add(session);
    void (async () => {
      try {
        for await (const message of query) this.#handle(session, message);
        session.end("the query ended");
      } catch (error) {
        session.end(`the query failed: ${String(error)}`);
      } finally {
        this.#owned.delete(session);
      }
    })();
    return session;
  }

  /** The options of the SDK, built from what the caller asked for. */
  #sdkOptions(
    model: string | undefined,
    effort: string | undefined,
    system: string,
    visible: VisibleActions | undefined,
    cwd: string | undefined,
    plan: ProcessPlan,
  ): SdkOptions {
    const claude = claudeEnv(plan.claude);
    const env = Object.keys(claude).length === 0 ? plan.env : { ...plan.env, ...claude };
    const options: SdkOptions = {
      ...(model === undefined ? {} : { model }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(effort === undefined || effort === "" ? {} : { effort: EffortLevel.parse(effort) }),
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      // The SDK's own allowlist of its built-in tools.
      ...(plan.tools === undefined ? {} : { tools: [...plan.tools.allow] }),
      // The process is born in the funnel, like every other.
      spawnClaudeCodeProcess: (spawnOptions) => this.#spawn(spawnOptions, plan),
      // Constant and stable sections are the system prompt, so the cacheable prefix stays stable.
      ...(system === ""
        ? {}
        : { systemPrompt: { type: "preset", preset: "claude_code", append: system } }),
      ...(visible === undefined || visible.disabledTools.length === 0
        ? {}
        : { disallowedTools: [...visible.disabledTools] }),
    };
    options.permissionMode = PERMISSION_MODES[plan.mode];
    if (plan.mode === "full") options.allowDangerouslySkipPermissions = true;
    return options;
  }

  /**
   * The SDK's spawn hook: the process of a query goes through the funnel. The SDK hands over its
   * whole environment, and the funnel takes what differs from the inherited one as the additions,
   * so a box is given only what is listed, not everything this process holds.
   */
  #spawn(spawnOptions: SpawnOptions, plan: ProcessPlan): SpawnedProcess {
    const additions: Record<string, string> = {};
    for (const [name, value] of Object.entries(spawnOptions.env)) {
      if (value !== undefined && process.env[name] !== value) additions[name] = value;
    }
    const child = spawnAgentNow({
      harness: this.#harness,
      program: spawnOptions.command,
      args: spawnOptions.args,
      cwd: spawnOptions.cwd,
      env: additions,
      unset: Object.keys(process.env).filter((name) => !(name in spawnOptions.env)),
      box: plan.box,
      needs: CLAUDE_NEEDS,
    });
    // The SDK reads no stderr; an undrained pipe would stall the process.
    child.stderr.resume();
    spawnOptions.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child;
  }

  /**
   * The permission handler of the SDK. A session with a place for its reverse requests sends them
   * there; any other is answered by the policy of this side.
   */
  async #canUseTool(
    session: LiveSession,
    tool: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const reverse = session.reverse;
    if (reverse === undefined) return await this.#byPolicy(tool, input, context.toolUseID);
    const asking = session.startAsking(context.signal);
    const raw = rawRequest(tool, input, context);
    const id = makeSessionId(this.#harness, session.nativeId);
    // Whatever happens to the handler, the SDK is answered: a turn never hangs on a question.
    const ask = async (question: Question): Promise<Answer> => {
      try {
        return await reverse(id, { question, raw, signal: asking.signal });
      } catch {
        return { cancelled: true };
      }
    };
    try {
      if (tool !== ASK_USER_QUESTION) {
        const question = permissionQuestion(tool, input, context);
        return permissionResult(question, await ask(question), input);
      }
      return await this.#answerQuestions(input, ask, asking.signal);
    } finally {
      asking.done();
    }
  }

  /**
   * The questions of an AskUserQuestion call go one by one, each its own niwa question; the answers
   * go back in the input of the call, keyed by the question's text. A question nobody answers ends
   * the call: the tool is told so.
   */
  async #answerQuestions(
    input: Record<string, unknown>,
    ask: (question: Question) => Promise<Answer>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const asked = questionsOf(input);
    if (asked === undefined) return { behavior: "deny", message: "the questions of the tool call are not well formed" };
    const answers: Record<string, string> = {};
    for (const { key, question } of asked) {
      const text = answerText(question, await ask(question));
      if (text === undefined || signal.aborted) return { behavior: "deny", message: "the questions were not answered" };
      answers[key] = text;
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /** What the policy of this side decides; a policy that fails denies. */
  async #byPolicy(tool: string, input: Record<string, unknown>, toolUseId: string | undefined): Promise<PermissionResult> {
    const policy = this.#permissions;
    let decision: PermissionDecision;
    if (policy === "allow") {
      decision = { behavior: "allow" };
    } else if (policy === "deny") {
      decision = { behavior: "deny" };
    } else {
      try {
        decision = await policy({ tool, input, toolUseId });
      } catch (error) {
        decision = { behavior: "deny", message: `the permission check failed: ${String(error)}` };
      }
    }
    return decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
      : { behavior: "deny", message: decision.message ?? "the tool is not allowed" };
  }

  /** One message of the SDK, as a sign of life. */
  #handle(session: LiveSession, message: SDKMessage): void {
    if (message.type === "result") {
      session.endTurn(message);
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      session.named(message.session_id);
      // The model the program says it runs: the alias a start asked for is resolved by now.
      if (message.model !== "") {
        session.model = modelName(message.model);
        session.emit({ kind: "model", model: session.model });
      }
    }
    for (const sign of signsOf(message, Date.now())) session.emit(sign);
  }

  /** Writes a user message and says what became of it; "delivered" is never claimed. */
  #submit(session: LiveSession, text: string): DeliveryReceipt {
    if (session.ended || session.input.closed) {
      throw this.#unavailable("send", "the session is not running");
    }
    session.input.push(userMessage(text));
    const at = Date.now();
    if (session.running) {
      session.queued += 1;
      return { status: "queued", turn: session.turn + session.queued, at };
    }
    return { status: "started", turn: session.beginTurn(), at };
  }

  /** Waits for the running turn and returns its result; a failed turn throws. */
  async #runTurn(session: LiveSession): Promise<SDKResultMessage & { subtype: "success" }> {
    const result = await session.awaitResult(this.#turnTimeoutMs);
    if (result === undefined) {
      throw this.#unavailable("turn", "the turn did not end in time");
    }
    if (result.subtype !== "success" || result.is_error) {
      const reason = result.subtype === "success" ? result.result : result.errors.join("; ");
      throw this.#unavailable("turn", reason || `the turn failed: ${result.subtype}`);
    }
    return result;
  }

  /**
   * Waits for the SDK to name the session.
   *
   * A first turn that ends before the session was named never will be: that is a refusal, not a
   * wait until the timeout.
   */
  #awaitName(session: LiveSession): Promise<string> {
    if (session.nativeId !== "") return Promise.resolve(session.nativeId);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.#unavailable("start", "the SDK did not name the session in time"));
      }, this.#startTimeoutMs);
      session.resultWaiters.push((result) => {
        if (session.nativeId !== "") return;
        clearTimeout(timer);
        const reason =
          result === undefined
            ? "the query ended"
            : result.subtype === "success"
              ? result.result
              : result.errors.join("; ");
        reject(this.#unavailable("start", `the first turn ended before the SDK named the session: ${reason}`));
      });
      session.nameWaiters.push({
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Resumes a session; a session already held continues in its own query. */
  async #resumeOnce(id: SessionId, options?: ResumeOptions): Promise<void> {
    const { system, turn } =
      options?.prompt === undefined ? { system: "", turn: "" } : splitPrompt(options.prompt);
    const visible = options?.visible;

    const held = this.#sessions.get(id.native);
    if (held !== undefined && !held.ended) {
      if (options?.tools !== undefined || options?.box !== undefined) {
        throw new Unsupported(this.#harness, "control", "resume", LIVE_PROCESS_REFUSAL);
      }
      if (system !== "" || (visible?.disabledTools.length ?? 0) > 0) {
        throw new Unsupported(
          this.#harness,
          "control",
          "resume",
          "a running session cannot take a new system prompt or tool set",
        );
      }
      // The one who resumes names where the session's reverse requests go from now on.
      if (options?.reverse !== undefined) {
        held.reverse = options.reverse;
        const plan = this.#plans.get(id.native);
        if (plan !== undefined) this.#plans.set(id.native, { ...plan, reverse: options.reverse });
      }
      if (turn !== "") this.#submit(held, turn);
      return;
    }

    const plan: ProcessPlan = {
      env: options?.env,
      tools: options?.tools,
      box: options?.box,
      reverse: options?.reverse,
      mode: modeOf(options?.mode, this.#mode, CLAUDE_SDK_LAUNCH),
      // A process launched again keeps the Claude options the session was started with: the ones the
      // resume names (niwa records them), else the ones this side held.
      claude: { ...(this.#plans.get(id.native)?.claude ?? this.#claude), ...options?.claude },
    };
    await requireBox(plan.box);
    const session = this.#open(
      { ...this.#sdkOptions(options?.model ?? this.#model, this.#effort, system, visible, undefined, plan), resume: id.native },
      id.native,
      plan.reverse,
    );
    this.#plans.set(id.native, plan);
    if (turn !== "") {
      await this.#ownedBy(session, async () => {
        this.#submit(session, turn);
        await this.#runTurn(session);
      });
    }
    this.#sessions.set(id.native, session);
  }

  /** Runs `work` on the query; if it fails, the query is stopped before the error goes up. */
  async #ownedBy<T>(session: LiveSession, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      session.stop(String(error));
      throw error;
    }
  }

  /** The session with that id, or a refusal. */
  #require(id: SessionId, ability: string): LiveSession {
    const session = this.#sessions.get(id.native);
    if (session === undefined) {
      throw this.#unavailable(ability, `the session ${id.native} is not held by this control side`);
    }
    return session;
  }

  #unavailable(ability: string, detail: string): Unavailable {
    return new Unavailable(this.#harness, "control", ability, detail);
  }
}

/** A user message, in the SDK's shape. */
function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Constant and stable sections are the system prompt, constant first so the cacheable prefix
 * stays stable; volatile sections are the turn.
 */
function splitPrompt(prompt: Prompt): { system: string; turn: string } {
  const texts = (...tiers: string[]): string =>
    tiers
      .flatMap((tier) => prompt.sections.filter((section) => section.tier === tier))
      .map((section) => section.text)
      .filter((text) => text !== "")
      .join("\n\n");
  return { system: texts("constant", "stable"), turn: texts("volatile") };
}

/** The JSON Schema of a zod schema, as the SDK wants it. */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
}

/** Parse JSON, when the text is JSON. */
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
