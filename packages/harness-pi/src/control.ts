/**
 * The pi control side: how niwa starts, steers and stops pi's sessions.
 *
 * pi speaks its own dialect, and this side speaks it and nothing else. In its RPC mode pi reads
 * one JSON object per line from stdin and writes one JSON object per line to stdout:
 *
 * - a **request** goes out as `{ "type": "<command>", "id": "<n>", ... }`;
 * - its **answer** comes back as `{ "type": "response", "command": "<command>", "success": true, "data"?: ... }`,
 *   or with `"success": false` and an `"error"`;
 * - everything else on stdout is an **event** of pi's own: `agent_start`, `agent_end`,
 *   `message_start`, `tool_execution_start` and the rest.
 *
 * pi has no greeting, so the first request is the proof that it is there: `get_state` answers with
 * the id and the file of the session, and those two are the identity of the session.
 *
 * The turns of niwa are pi's runs: from `agent_start` to `agent_end`. The `turn_start` and
 * `turn_end` of pi are the inner steps of a run — one per request to the model — and they are not
 * the turns of niwa, so they are not what this side reports.
 *
 * What the RPC mode really supports, and so what this side declares:
 *
 * - **start**: a session is a pi process, and it is started with `--mode rpc`.
 * - **send**: a message is delivered with pi's `prompt`. A session that is working refuses a
 *   prompt, so the message is queued with `follow_up`, or steered into the running turn with
 *   `steer` when the caller asks for that.
 * - **interrupt**: pi's `abort` stops the run in flight.
 * - **resume**: a session is opened again by starting pi with `--session <file>`, the file pi
 *   itself named. `--resume` and `--continue` are not used: they open a picker or a guess, and
 *   the picker is a person, which a control side has not got.
 * - **ask**: pi asks its questions through its own extension protocol, not through this dialect,
 *   so a question cannot be put to a pi session from here.
 * - **reverse requests**: pi has no permission requests of its own; an extension that gates a tool
 *   asks through the same dialogs as any other question. A session given a `reverse` handler
 *   routes every dialog (`select`, `confirm`, `input`, `editor`) to it as a question.
 * - **structuredOutput**: pi's events carry pi's messages, not a structured result.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { assertNever, OptionIdSchema, pickedOptions } from "@niwa-labs/core";
import type { Answer, Question, QuestionOption } from "@niwa-labs/core";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  modeOf,
  modelName,
  requireLaunch,
  sessionId as makeSessionId,
  Unavailable,
  Unsupported,
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
  ModelName,
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
import { PI_PROTOCOL, PiCommandSchema, RequestIdSchema, describeUnknown, parseLine, unknownVariantName } from "./protocol/index.ts";
import type {
  PiUnknownVariant,
  DialogId,
  DialogRequest,
  PiCommandFields,
  PiCommandName,
  PiEvent,
  PiIncoming,
  PiJson,
  PiOutgoing,
  PiUiReply,
  PiUiResponse,
  RequestId,
  ResponseCommand,
  SessionState as PiSessionState,
  SuccessResponse,
} from "./protocol/index.ts";

/** What pi needs inside a box: its own directory. Its model endpoint depends on the model, so the grant names it. */
const PI_NEEDS: HarnessNeeds = { write: [homePath(".pi")], net: [] };

/**
 * pi's flags for an allow-list of its own tools (`docs/cli.md`): `--tools` replaces the selection
 * with exactly the tools named, built-in, extension or custom. With none named `--no-tools` starts
 * with every tool off, the extensions pi loads by itself among them: those are pi's, not niwa's.
 */
export function piToolFlags(allow: readonly string[]): string[] {
  return allow.length === 0 ? ["--no-tools"] : ["--tools", allow.join(",")];
}

/**
 * The flags for a tool mode. pi's RPC mode takes no MCP server, so a session of niwa's tools only
 * has none of pi's: `--no-tools`, the same as an empty allow-list.
 */
export function piToolsModeFlags(tools: ToolsMode): string[] {
  if (tools === "all") return [];
  return piToolFlags(tools === "niwa-only" ? [] : tools.allow);
}

/**
 * What a pi session takes at launch: a model by `--model`, a thinking level by `--thinking`. pi has
 * no modes and never asks, which is `full`: an instance sets it as its default, since every
 * harness's default is `auto`.
 */
export const PI_LAUNCH: LaunchCapabilities = {
  model: true,
  effort: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  modes: ["full"],
};

/** What this side can do, as pi's RPC mode really is. */
export const PI_CONTROL_CAPABILITIES = {
  start: true,
  resume: true,
  send: true,
  interrupt: true,
  ask: false,
  structuredOutput: false,
} as const;

/** The options of the pi control side. */
export interface PiControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;
  /** The pi to run. A bare name is resolved through PATH; the default is `pi`. */
  readonly binary?: string;
  /** The model pi is asked for, in pi's own words. */
  readonly model?: string;
  /** The thinking level, when the caller does not choose one per start. */
  readonly effort?: string;
  /** The working mode, when the caller does not choose one per start. pi has only `full`, so an instance sets it. */
  readonly mode?: SessionMode;
  /** The directory the sessions are worked in. */
  readonly cwd?: string;
  /** pi's own home: its sessions live in `<home>/sessions`. */
  readonly home?: string;
  /** How long one request waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;
  /** How long a turn waits for its end, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** How long a graceful stop waits before the hard kill, in milliseconds. */
  readonly stopGraceMs?: number;
  /** The environment pi is run in, on top of niwa's own. */
  readonly env?: Readonly<Record<string, string>>;
}
/** A `SessionControl` that also owns the processes it started. */
export interface PiSessionControl extends SessionControl {
  /** Stops a session and the process it owns. */
  stop(id: SessionId): Promise<void>;
  /** Stops every session this control side owns. */
  dispose(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
/** The most bytes one line of the wire may hold. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How much of stderr is kept to explain a death. */
const STDERR_TAIL_CHARS = 2_000;

/** How a request ends: pi answered it, or the process went away before it did. */
type Settled =
  | { readonly kind: "answer"; readonly incoming: Extract<PiIncoming, { kind: "response" }> }
  | { readonly kind: "gone"; readonly error: string };

/** A dialog of pi, with the line it came in as. */
interface PendingDialog {
  readonly request: DialogRequest;
  readonly raw: PiJson;
}

/** The model pi says it runs, as `--model` takes it: `provider/id`, or the id alone when pi names no provider. */
function runningModel(state: PiSessionState): ModelName | undefined {
  const model = state.model;
  if (model === undefined || model.id === "") return undefined;
  return modelName(model.provider === undefined || model.provider === "" ? model.id : `${model.provider}/${model.id}`);
}

/** A watcher gets the signs of life, then `undefined` once when the session is gone. */
type Watcher = (event: LifeEvent | undefined) => void;

/** The text of a prompt, in pi's own way: the sections, one after another. */
function promptText(prompt: Prompt): string {
  return prompt.sections.map((section) => section.text).join("\n\n");
}

/** How many turn signs are kept for the first stream of life of a session. */
const UNWATCHED_LIMIT = 64;

/** The session of one pi process. */
class LiveSession {
  readonly child: AgentProcess;
  readonly watchers = new Set<Watcher>();
  /** pi's own id of the session. */
  nativeId = "";
  /** The file of the session, as pi named it. */
  sessionFile: string | null = null;
  /** The runs niwa has seen; the running one, if any, has this number. */
  turn = 0;
  /** Whether a run is in flight. */
  busy = false;
  /** Whether the session is on its way out. */
  stopping = false;
  /** Whether the process is gone. */
  ended = false;
  /** What stderr said, kept for the error that explains a death. */
  stderrTail = "";
  /** The answers of pi that are waited for. */
  readonly pending = new Map<RequestId, (settled: Settled) => void>();
  /** The frames pi was told, kept for the tests. */
  readonly frames: PiOutgoing[] = [];
  /** The part of the wire that has not ended in a line yet. */
  buffer = "";
  /** The number of the next request. */
  nextId = 1;
  /** Where the dialogs of pi go, when the session has been given a place for them. */
  reverse: ReverseHandler | undefined;
  /** The dialogs waiting for an answer by pi's id of them, each aborted when pi stops waiting for it. */
  readonly dialogs = new Map<DialogId, AbortController>();
  /** The dialogs pi asked before it named the session: they wait for the name. */
  early: PendingDialog[] = [];

  constructor(child: AgentProcess, reverse: ReverseHandler | undefined) {
    this.child = child;
    this.reverse = reverse;
  }

  /** The process is gone: nobody waits for the dialogs, and their questions are closed. */
  abortDialogs(): void {
    for (const dialog of this.dialogs.values()) dialog.abort();
    this.dialogs.clear();
  }

  /**
   * The turn signs before anyone watched the life of the session: a turn can run inside `start`,
   * before the caller has the session to watch. `life` gives them to its first stream; after it
   * nothing is kept. At most the newest few are kept.
   */
  #unwatched: LifeEvent[] | undefined = [];

  /** Starts a stream of the signs of life; the first one also gets the turn signs that came before it. */
  watchLife(watcher: Watcher): void {
    const missed = this.#unwatched ?? [];
    this.#unwatched = undefined;
    for (const event of missed) watcher(event);
    this.watchers.add(watcher);
  }

  /** Tells the watchers of a sign of life. */
  emit(event: LifeEvent): void {
    if (this.#unwatched !== undefined && event.kind !== "activity") {
      this.#unwatched.push(event);
      if (this.#unwatched.length > UNWATCHED_LIMIT) this.#unwatched.shift();
    }
    for (const watcher of this.watchers) watcher(event);
  }

  /** Ends the stream of the signs of life. */
  finish(): void {
    for (const watcher of this.watchers) watcher(undefined);
  }
}

/**
 * The pi control side.
 *
 * It runs pi in its RPC mode and speaks pi's dialect to it. Every session owns one pi process,
 * and this side owns them all: they are stopped when the side is disposed.
 */
export class PiControl implements PiSessionControl {
  readonly #harness: HarnessId;
  readonly #options: PiControlOptions;
  readonly #sessions = new Map<string, LiveSession>();
  /** Every process this side owns, named or not yet named. */
  readonly #owned = new Set<LiveSession>();
  /** The file of every session this side has seen, so a session can be opened again. */
  readonly #files = new Map<string, string>();
  #disposed = false;

  constructor(options: PiControlOptions) {
    this.#harness = options.harness as HarnessId;
    this.#options = options;
  }

  /** The harness this side belongs to. */
  get harness(): HarnessId {
    return this.#harness;
  }

  /** What this side can do. */
  get capabilities(): typeof PI_CONTROL_CAPABILITIES {
    return PI_CONTROL_CAPABILITIES;
  }

  /** The frames pi was told, for the tests that look at the wire. */
  get frames(): readonly PiOutgoing[] {
    return [...this.#owned].flatMap((session) => session.frames);
  }

  // -- the side -------------------------------------------------------------

  async start(options: StartOptions): Promise<StartedSession> {
    if (this.#disposed) {
      throw new Unavailable(this.#harness, "control", "start", "the control side is disposed");
    }
    this.#refuseSeen("start", options.visible, options.servers);
    const mode = modeOf(options.mode, this.#options.mode, PI_LAUNCH);
    requireLaunch(this.#harness, PI_LAUNCH, {
      model: options.model ?? this.#options.model,
      effort: options.effort ?? this.#options.effort,
      mode,
    });
    const cwd = resolve(options.cwd ?? this.#options.cwd ?? process.cwd());
    // pi names the session in its answer to `get_state`, before any prompt.
    const session = await this.#spawn(cwd, undefined, "start", options.model, options.effort, options);
    const id = makeSessionId(this.#harness, session.nativeId);
    // The prompt is the first turn, delivered like a send: the start waits for pi to take it,
    // never for the run to end.
    const text = promptText(options.prompt);
    if (text.trim().length === 0) return { session: id, mode };
    try {
      return { session: id, first: await this.#submit(session, text), mode };
    } catch (error) {
      // pi refused the first message: the session was never given its work, and nobody holds
      // its id to stop it later.
      this.#sessions.delete(session.nativeId);
      await this.#stopSession(session);
      throw error;
    }
  }

  async resume(id: SessionId, options?: ResumeOptions): Promise<void> {
    this.#refuseSeen("resume", options?.visible, options?.servers);
    // A session whose process ended is remembered for its file only: it is not held, and a
    // resume that took it for held would report a session nothing is running.
    const known = this.#sessions.get(id.native);
    const held = known !== undefined && !known.ended && !known.stopping ? known : undefined;
    if (held !== undefined) {
      if (options?.tools !== undefined || options?.box !== undefined) {
        throw new Unsupported(this.#harness, "control", "resume", LIVE_PROCESS_REFUSAL);
      }
      // The one who resumes names where the dialogs go from now on.
      if (options?.reverse !== undefined) held.reverse = options.reverse;
      const text = options?.prompt === undefined ? "" : promptText(options.prompt);
      if (text.trim().length > 0) await this.#deliver(held, text, true);
      return;
    }
    // A session is opened again by its file: pi's `--session`. The file is the one pi named,
    // and it is remembered; when it is not, it is looked for in the way pi names its files.
    // pi writes no file until a turn has run, so a remembered name proves nothing: the file must
    // be there, or the session cannot be opened again and the refusal says so.
    const remembered = this.#files.get(id.native);
    const file =
      remembered !== undefined && (await stat(remembered).then(() => true, () => false))
        ? remembered
        : await this.#findFile(id.native);
    if (file === undefined) {
      throw new Unavailable(
        this.#harness,
        "control",
        "resume",
        `the session "${id.native}" has no file to be opened again by: pi writes one only after a turn has run`,
      );
    }
    requireLaunch(this.#harness, PI_LAUNCH, { mode: modeOf(options?.mode, this.#options.mode, PI_LAUNCH) });
    const cwd = resolve(this.#options.cwd ?? process.cwd());
    const session = await this.#spawn(cwd, file, "resume", options?.model, undefined, options ?? {});
    // pi opened the file it was given; a session it names otherwise is not the one that was
    // asked for, and holding it under the old id would continue a conversation that is not it.
    if (session.nativeId !== id.native) {
      // The spawn filed it under the id it named: that id is not held by it either.
      if (this.#sessions.get(session.nativeId) === session) this.#sessions.delete(session.nativeId);
      await this.#stopSession(session);
      throw new Unavailable(
        this.#harness,
        "control",
        "resume",
        `pi opened the session "${session.nativeId}", not the session "${id.native}" that was asked for`,
      );
    }
    await this.#firstTurn(session, options?.prompt === undefined ? "" : promptText(options.prompt));
  }

  async send(id: SessionId, message: string, options?: SendOptions): Promise<DeliveryReceipt> {
    return this.#submit(this.#require(id, "send"), message, options);
  }

  /** Delivers a message and says what became of it; nothing waits for the run to end. */
  async #submit(session: LiveSession, message: string, options?: SendOptions): Promise<DeliveryReceipt> {
    const at = Date.now();
    // The runs counted before the message goes out: pi may begin the run in the same read as
    // its answer, and the receipt of a run it starts names that run, not the one after it.
    const before = session.turn;
    if (session.busy) {
      // The queueing is pi's own `prompt` with a `streamingBehavior`: pi decides, atomically,
      // whether it is working. A bare `steer` or `follow_up` sent after the run ended in the
      // same read would be kept by an idle pi and never delivered; this one just starts a run.
      if (options?.into === "turn") {
        // Only a caller that asks for it gets its message into the running turn.
        await this.#call(session, "prompt", { message, streamingBehavior: "steer" });
        return { status: "delivered", turn: session.turn, at };
      }
      // The default: pi keeps the message for the answer that comes after the running one.
      await this.#call(session, "prompt", { message, streamingBehavior: "followUp" });
      return { status: "queued", turn: session.turn + 1, at };
    }
    try {
      await this.#call(session, "prompt", { message });
    } catch (error) {
      // pi refuses a bare prompt while it is working. The side may not have seen the run begin
      // yet, so the refusal is taken at its word and the message is queued instead.
      if (!isBusyRefusal(error)) throw error;
      await this.#call(session, "prompt", { message, streamingBehavior: "followUp" });
      return { status: "queued", turn: session.turn + 1, at };
    }
    // The caller does not wait for the end of the run; the signs of life report it.
    return { status: "started", turn: before + 1, at };
  }

  async interrupt(id: SessionId): Promise<void> {
    const session = this.#require(id, "interrupt");
    // A run that is interrupted no longer waits for its dialogs. pi is answered for each of them at
    // once, so that what blocks the run is let go of before `abort` waits for it.
    for (const [dialog, waiting] of session.dialogs) {
      session.dialogs.delete(dialog);
      this.#write(session, uiResponse(dialog, CANCELLED));
      waiting.abort();
    }
    await this.#call(session, "abort");
  }

  async ask<T>(_id: SessionId, _options: AskOptions<T>): Promise<AskAnswer<T>> {
    throw new Unsupported(
      this.#harness,
      "control",
      "ask",
      "pi asks its questions through its own extension protocol, not through the RPC mode",
    );
  }

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
        session.watchLife(watcher);
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

  async state(id: SessionId): Promise<SessionState> {
    const session = this.#sessions.get(id.native);
    // A session that is not held, or whose process is gone, proves nothing about now.
    if (session === undefined || session.ended || session.stopping) return "unknown";
    return session.busy ? "running" : "idle";
  }

  async stop(id: SessionId): Promise<void> {
    const session = this.#sessions.get(id.native);
    if (session === undefined) return;
    this.#sessions.delete(id.native);
    await this.#stopSession(session);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#sessions.clear();
    for (const session of [...this.#owned]) {
      await this.#stopSession(session);
    }
  }

  // -- the session ----------------------------------------------------------

  /** The environment pi is run in. */
  #env(): Record<string, string> {
    const env: Record<string, string> = { ...this.#options.env };
    const home = this.#options.home;
    if (home !== undefined) {
      // pi reads its own home from the environment: its settings, its extensions and the
      // directory it keeps its sessions in. The name is pi's own. The sessions themselves are
      // left to pi: it keeps them in a directory named after the working directory, under
      // `<home>/sessions`, which is where the reading side looks for them.
      env.PI_CODING_AGENT_DIR = home;
    }
    return env;
  }

  /** The session of an id, or a complaint that there is none. */
  #require(id: SessionId, ability: string): LiveSession {
    const session = this.#sessions.get(id.native);
    if (session === undefined) {
      throw new Unavailable(
        this.#harness,
        "control",
        ability,
        `the session "${id.native}" is not held`,
      );
    }
    return session;
  }

  /**
   * Starts pi and waits until it says what its session is.
   *
   * The first request is `get_state`: pi has no greeting, and this is the answer that names the
   * session and its file. That file is what a later start opens again.
   */
  async #spawn(
    cwd: string,
    file: string | undefined,
    ability: string,
    model: string | undefined,
    effort: string | undefined,
    plan: Pick<StartOptions, "env" | "tools" | "box" | "reverse">,
  ): Promise<LiveSession> {
    const binary = this.#options.binary ?? "pi";
    const args = ["--mode", "rpc"];
    if (file !== undefined) args.push("--session", file);
    const chosen = model ?? this.#options.model;
    if (chosen !== undefined) args.push("--model", chosen);
    const chosenEffort = effort ?? this.#options.effort;
    if (chosenEffort !== undefined) args.push("--thinking", chosenEffort);
    if (plan.tools !== undefined) args.push(...piToolsModeFlags(plan.tools));

    const child = await spawnAgent({
      harness: this.#harness,
      program: binary,
      args,
      cwd,
      env: { ...this.#env(), ...plan.env },
      box: plan.box,
      needs: PI_NEEDS,
    });
    const session = new LiveSession(child, plan.reverse);
    this.#owned.add(session);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#read(session, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error: Error) => this.#gone(session, error));
    child.on("close", (code: number | null) =>
      this.#gone(session, new Error(`pi: the process ended with code ${String(code)}`)),
    );

    try {
      const state = await this.#state(session);
      const native = state.sessionId;
      if (native.length === 0) {
        throw new Unavailable(this.#harness, "control", ability, "pi did not name its session");
      }
      session.nativeId = native;
      const running = runningModel(state);
      if (running !== undefined) session.emit({ kind: "model", model: running });
      session.sessionFile = state.sessionFile ?? null;
      // The file is remembered, so the session can be opened again by it.
      if (session.sessionFile !== null) this.#files.set(native, session.sessionFile);
      this.#sessions.set(native, session);
      // The dialogs pi asked before it named the session can be handed over now.
      const early = session.early;
      session.early = [];
      for (const dialog of early) this.#answerDialog(session, dialog);
      return session;
    } catch (error) {
      // pi refused to start, and it says why on stderr. The reason is part of the error.
      const reason = session.stderrTail.trim();
      await this.#stopSession(session);
      throw error instanceof Unavailable && reason === ""
        ? error
        : new Unavailable(
            this.#harness,
            "control",
            ability,
            reason === ""
              ? error instanceof Error
                ? error.message
                : String(error)
              : reason,
          );
    }
  }

  /**
   * Reads the wire of pi.
   *
   * The framing is strict: pi writes one JSON object per line, and a line ends at a newline and
   * nowhere else. So the reader splits on the newline alone, and never on a character that may
   * legitimately be inside a JSON string.
   */
  #read(session: LiveSession, chunk: string): void {
    let buffer = session.buffer + chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      this.#handleLine(session, line.endsWith("\r") ? line.slice(0, -1) : line);
      newline = buffer.indexOf("\n");
    }
    session.buffer = buffer;
    if (session.buffer.length > MAX_LINE_BYTES) {
      // A line that never ends is not pi's. The session is lost, and it is said so.
      this.#gone(session, new Error("pi: a line of the wire did not end"));
    }
  }

  /** One line of the wire, understood. */
  #handleLine(session: LiveSession, line: string): void {
    if (line.trim().length === 0) return;
    const incoming = parseLine(line);
    switch (incoming.kind) {
      case "response": {
        // An answer settles exactly one request, by the id of its envelope, whatever its body is.
        const id = incoming.envelope.id;
        if (id === undefined) {
          // pi answers a line it could not read without an id, since it has none to echo.
          session.emit({
            kind: "activity",
            at: Date.now(),
            detail: `pi answered without an id: ${incoming.envelope.error ?? incoming.envelope.command ?? "no command"}`,
          });
          return;
        }
        const settle = session.pending.get(id);
        if (settle === undefined) return;
        session.pending.delete(id);
        settle({ kind: "answer", incoming });
        return;
      }
      case "dialog":
        // A question of pi's: it waits for an answer, and nothing must make it wait forever.
        this.#answerDialog(session, { request: incoming.request, raw: incoming.raw });
        return;
      case "notice":
        // A notice says something to an interface (a status line, a title, a widget): niwa has none,
        // pi waits for no answer, and it is not a sign of the run.
        return;
      case "event":
        this.#handleEvent(session, incoming.event);
        return;
      case "extension-error":
        session.emit({
          kind: "activity",
          at: Date.now(),
          detail: `an extension of pi failed: ${incoming.error.extensionPath} (${incoming.error.event}): ${incoming.error.error}`,
        });
        return;
      case "unknown":
        this.#emitUnknown(session, incoming.variant);
        // A request pi made that this side cannot place still waits for an answer: it is refused.
        if (incoming.requestId !== undefined) this.#write(session, uiResponse(incoming.requestId, CANCELLED));
        return;
      case "unreadable":
        // A line that is not JSON is not pi's. It is ignored, as the protocol says it must be.
        session.emit({ kind: "activity", at: Date.now(), detail: incoming.reason });
        return;
      default:
        return assertNever(incoming, "pi line");
    }
  }

  /** A line this snapshot cannot place: the typed unknown, and the words of it in the log. */
  #emitUnknown(session: LiveSession, variant: PiUnknownVariant): void {
    for (const sign of unknownVariantSigns(Date.now(), PI_PROTOCOL, unknownVariantName(variant), variant.raw, describeUnknown(variant))) {
      session.emit(sign);
    }
  }

  /** The events of pi: the run, and the steps inside it. */
  #handleEvent(session: LiveSession, event: PiEvent): void {
    switch (event.type) {
      case "agent_start": {
        session.busy = true;
        session.turn += 1;
        session.emit({ kind: "turn-started", turn: session.turn, at: Date.now() });
        return;
      }
      case "agent_end": {
        session.busy = false;
        session.emit({ kind: "turn-ended", turn: session.turn, at: Date.now() });
        return;
      }
      // Everything else is a step of the run, or something pi says about its session. Each is a sign
      // of life, named by its type, so that a session that is only thinking is not a session that is
      // hung. None of them is a turn of niwa: `turn_start` and `turn_end` are the steps of a run.
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "agent_settled":
      case "queue_update":
      case "compaction_start":
      case "compaction_end":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update": {
        session.emit({ kind: "activity", at: Date.now(), detail: event.type });
        return;
      }
      default:
        return assertNever(event, "pi event");
    }
  }

  /**
   * Answers a question of pi's.
   *
   * pi asks through its extension protocol: a dialog — a choice, a confirmation, a line of text —
   * waits for an answer, and a session that waits forever is a hung session. A session with a
   * place for its reverse requests hands the dialog over as a question and sends pi the answer;
   * a session without one has the dialog declined at once, said out loud as an activity with the
   * raw request kept in the detail.
   */
  #answerDialog(session: LiveSession, pending: PendingDialog): void {
    const { request, raw } = pending;
    const handler = session.reverse;
    if (handler === undefined) {
      session.emit({
        kind: "activity",
        at: Date.now(),
        detail: `pi asked: ${JSON.stringify(raw)}`,
      });
      // The answer is the one pi understands as a refusal: the dialog is cancelled.
      this.#write(session, uiResponse(request.id, CANCELLED));
      return;
    }
    if (session.nativeId === "") {
      session.early.push(pending);
      return;
    }
    void this.#routeDialog(session, handler, pending);
  }

  /** A dialog handed to the place the session's reverse requests go, and its answer sent to pi. */
  async #routeDialog(session: LiveSession, handler: ReverseHandler, pending: PendingDialog): Promise<void> {
    const { request, raw } = pending;
    const id = request.id;
    const dialog = dialogQuestion(request);
    if (dialog === undefined) {
      this.#write(session, uiResponse(id, CANCELLED));
      return;
    }
    const waiting = new AbortController();
    session.dialogs.set(id, waiting);
    // pi resolves a dialog with a timeout by itself: when it does, nobody waits for the answer, and
    // there is no answer to send.
    const timeout = dialogTimeout(request);
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            session.dialogs.delete(id);
            waiting.abort();
          }, timeout);
    let answer: Answer;
    try {
      answer = await handler(makeSessionId(this.#harness, session.nativeId), {
        question: dialog.question,
        raw: { method: request.method, params: raw },
        signal: waiting.signal,
      });
    } catch {
      answer = { cancelled: true };
    } finally {
      clearTimeout(timer);
    }
    // A dialog that is no longer open was answered already (an interrupt) or pi gave it up (its timeout).
    if (session.ended || session.dialogs.get(id) !== waiting) return;
    session.dialogs.delete(id);
    this.#write(session, uiResponse(id, dialog.reply(answer)));
  }

  /** Writes a frame to pi. */
  #write(session: LiveSession, frame: PiOutgoing): void {
    session.frames.push(frame);
    session.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Asks pi to do something, and waits for its answer.
   *
   * pi answers a request with a response frame. A refusal is an outcome, not a crash: the answer
   * says so, and the side says so too. So is an answer this side cannot read: the request it
   * answers is settled by its id, and fails with the reason, instead of waiting for a timeout.
   */
  async #call<C extends PiCommandName & ResponseCommand>(
    session: LiveSession,
    command: C,
    ...args: {} extends PiCommandFields<C> ? [fields?: PiCommandFields<C>] : [fields: PiCommandFields<C>]
  ): Promise<SuccessResponse> {
    if (session.ended) {
      throw new Unavailable(this.#harness, "control", command, "the pi process is gone");
    }
    const id = RequestIdSchema.parse(String(session.nextId));
    session.nextId += 1;
    const answered = new Promise<Settled>((resolve) => {
      session.pending.set(id, resolve);
    });
    // What is written is checked against the commands pi has, so a frame that pi would not take does not leave.
    this.#write(session, PiCommandSchema.parse({ ...args[0], type: command, id }));
    let settled: Settled;
    try {
      settled = await withTimeout(
        answered,
        this.#options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        `pi: the command "${command}" took too long`,
      );
    } catch (error) {
      session.pending.delete(id);
      throw error;
    }
    if (settled.kind === "gone") {
      throw new Unavailable(this.#harness, "control", command, settled.error);
    }
    const { response, variant } = settled.incoming;
    if (response === undefined) {
      const detail = variant === undefined ? "an answer this side cannot read" : describeUnknown(variant);
      if (variant === undefined) session.emit({ kind: "activity", at: Date.now(), detail });
      else this.#emitUnknown(session, variant);
      throw new Unavailable(this.#harness, "control", command, detail);
    }
    if (!response.success) {
      throw new Unavailable(this.#harness, "control", command, response.error);
    }
    if (response.command !== command) {
      throw new Unavailable(
        this.#harness,
        "control",
        command,
        `pi answered "${response.command}" to the command "${command}"`,
      );
    }
    return response;
  }

  /** What pi says about its session: the identity of it is the id and the file. */
  async #state(session: LiveSession): Promise<PiSessionState> {
    const response = await this.#call(session, "get_state");
    if (response.command !== "get_state") {
      throw new Unavailable(this.#harness, "control", "get_state", `pi answered "${response.command}"`);
    }
    return response.data;
  }

  /**
   * Delivers a message, and waits for the run it starts when it is asked to.
   *
   * The wait is registered before the message goes out, so a run that ends in the same read as
   * its start is not missed.
   */
  async #deliver(session: LiveSession, message: string, wait: boolean): Promise<void> {
    const ended = wait ? this.#waitForEnd(session) : null;
    try {
      if (session.busy) {
        await this.#call(session, "prompt", { message, streamingBehavior: "followUp" });
      } else {
        await this.#call(session, "prompt", { message });
      }
    } catch (error) {
      ended?.cancel();
      throw error;
    }
    if (ended === null) return;
    await withTimeout(
      ended.done,
      this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "pi: the turn took too long",
    );
  }

  /** The wait for the end of a run: the promise, and the way to give it up. */
  #waitForEnd(session: LiveSession): { readonly done: Promise<void>; cancel(): void } {
    let settle: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // A death while the request is still out is reported by the request; this one is for the wait.
    done.catch(() => undefined);
    const watcher: Watcher = (event) => {
      if (event === undefined) {
        // The process went away: the end of the run will never come.
        session.watchers.delete(watcher);
        fail?.(
          new Unavailable(this.#harness, "control", "turn", this.#deathReason(session)),
        );
      } else if (event.kind === "turn-ended") {
        session.watchers.delete(watcher);
        settle?.();
      }
    };
    session.watchers.add(watcher);
    return {
      done,
      cancel: () => {
        session.watchers.delete(watcher);
      },
    };
  }

  /** Why the process is gone, with what it said on stderr. */
  #deathReason(session: LiveSession): string {
    const tail = session.stderrTail.trim();
    return tail === "" ? "the pi process is gone" : `the pi process is gone: ${tail}`;
  }

  /** The process is gone: the session proves nothing about now. */
  #gone(session: LiveSession, reason: Error): void {
    if (session.ended) return;
    session.ended = true;
    session.busy = false;
    session.abortDialogs();
    for (const settle of session.pending.values()) {
      const tail = session.stderrTail.trim();
      settle({ kind: "gone", error: tail === "" ? reason.message : `${reason.message}: ${tail}` });
    }
    session.pending.clear();
    session.finish();
  }

  /**
   * pi's RPC mode has no way to give a session niwa actions, servers or a tool switch, and a
   * session promised them would wait for a call that never comes: the request is refused.
   */
  #refuseSeen(
    ability: "start" | "resume",
    visible: VisibleActions | undefined,
    servers: readonly McpServerSpec[] | undefined,
  ): void {
    const seen = visible !== undefined && (visible.actions.length > 0 || visible.disabledTools.length > 0);
    if (!seen && (servers === undefined || servers.length === 0)) return;
    throw new Unsupported(
      this.#harness,
      "control",
      ability,
      "pi's RPC mode takes neither niwa actions, MCP servers nor a tool switch",
    );
  }

  /** The turn a resume carries into a session just opened; a session whose turn fails is not left running. */
  async #firstTurn(session: LiveSession, text: string): Promise<void> {
    if (text.trim().length === 0) return;
    try {
      await this.#deliver(session, text, true);
    } catch (error) {
      this.#sessions.delete(session.nativeId);
      await this.#stopSession(session);
      throw error;
    }
  }

  /** Stops a session and the process it owns. */
  async #stopSession(session: LiveSession): Promise<void> {
    this.#owned.delete(session);
    if (session.ended) return;
    session.stopping = true;
    const grace = this.#options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    session.child.kill("SIGTERM");
    const gone = await Promise.race([
      new Promise<boolean>((resolve) => session.child.once("close", () => resolve(true))),
      delay(grace).then(() => false),
    ]);
    if (!gone) {
      session.child.kill("SIGKILL");
    }
    this.#gone(session, new Error("pi: the process was stopped"));
  }

  /**
   * The file of a session, looked for the way pi names its files.
   *
   * pi names a session file `<time>_<id>.jsonl` in the directory of the project, and the
   * directory is named after the working directory.
   */
  async #findFile(native: string): Promise<string | undefined> {
    const cwd = resolve(this.#options.cwd ?? process.cwd());
    const directory = this.#sessionDirectory(cwd);
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.sort().reverse()) {
      if (!name.endsWith(".jsonl")) continue;
      const at = name.indexOf("_");
      if (at < 0) continue;
      if (name.slice(at + 1, name.length - ".jsonl".length) === native) {
        return join(directory, name);
      }
    }
    return undefined;
  }

  /** The directory pi keeps the sessions of a working directory in. */
  #sessionDirectory(cwd: string): string {
    const home = this.#options.home ?? join(homedir(), ".pi", "agent");
    return join(home, "sessions", projectOf(cwd));
  }
}

/** A dialog of pi as a common question, and how an answer to it goes back to pi. */
interface Dialog {
  readonly question: Question;
  /** The fields of the `extension_ui_response` for an answer; anything that does not answer the dialog cancels it. */
  reply(answer: Answer): PiUiReply;
}

const CANCELLED: PiUiReply = { cancelled: true };

/** The answer to a dialog, addressed to it. */
function uiResponse(id: DialogId, reply: PiUiReply): PiUiResponse {
  return { type: "extension_ui_response", id, ...reply };
}

/** The option ids pi's dialogs are given: pi has none of its own, so they are numbered. */
function optionOf(position: number, label: string): QuestionOption {
  return { id: OptionIdSchema.parse(`option-${position}`), label: label === "" ? `option ${position}` : label, flavor: "plain" };
}

/** How long pi waits for a dialog before it resolves it itself, in milliseconds; the editor has no timeout. */
function dialogTimeout(request: DialogRequest): number | undefined {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
      return request.timeout !== undefined && request.timeout > 0 ? request.timeout : undefined;
    case "editor":
      return undefined;
    default:
      return assertNever(request, "pi dialog");
  }
}

/**
 * The question a dialog of pi is: `select` a choice, `confirm` a yes or no, `input` and `editor` a
 * free text. A `select` with nothing to choose has no question and is cancelled.
 */
function dialogQuestion(request: DialogRequest): Dialog | undefined {
  const text = (value: string | undefined): string | undefined => (value !== undefined && value !== "" ? value : undefined);
  const title = text(request.title) ?? request.method;
  switch (request.method) {
    case "select": {
      const labels = request.options;
      if (labels.length === 0) return undefined;
      const options = labels.map((label, index) => optionOf(index + 1, label));
      const question: Question = { kind: "choice", title, options, allowOther: false };
      return {
        question,
        reply: (answer) => {
          const picked = pickedOptions(question, answer)[0];
          // The value is pi's own option string, which the option's label is.
          const label = picked === undefined ? undefined : labels[options.indexOf(picked)];
          return label === undefined ? CANCELLED : { value: label };
        },
      };
    }
    case "confirm": {
      const options = [optionOf(1, "Yes"), optionOf(2, "No")];
      const detail = text(request.message);
      const question: Question = { kind: "confirm", title, ...(detail === undefined ? {} : { detail }), options, allowOther: false };
      return {
        question,
        reply: (answer) => {
          const picked = pickedOptions(question, answer)[0];
          return picked === undefined ? CANCELLED : { confirmed: picked === options[0] };
        },
      };
    }
    case "input":
    case "editor": {
      // What pi suggests (a placeholder, the text to edit) is shown with the question.
      const detail = text(request.method === "input" ? request.placeholder : request.prefill);
      const question: Question = { kind: "text", title, ...(detail === undefined ? {} : { detail }) };
      return { question, reply: (answer) => ("text" in answer ? { value: answer.text } : CANCELLED) };
    }
    default:
      return assertNever(request, "pi dialog");
  }
}

/**
 * The directory pi keeps the sessions of a working directory in.
 *
 * pi encodes the working directory into a name of its own: the path without its leading slash,
 * with the separators turned into dashes.
 */
function projectOf(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Whether pi refused a command because it was working. */
function isBusyRefusal(error: unknown): boolean {
  if (!(error instanceof Unavailable)) return false;
  return error.message.includes("already processing");
}

/** Waits for a promise, or gives up on it. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Waits for a while. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}
