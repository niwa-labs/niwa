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
 * The turns of niwa are pi's runs: from `agent_start` to `agent_end`. A run that pi retries, or runs
 * again after compacting its context, is the same turn: an `agent_end` that ends a run for good holds
 * the turn open until pi says it settled, announces a compaction (which holds it until that ends), or
 * a short wait passes with nothing said. The `turn_start` and
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
 * - **ask**: pi asks its questions through its own extension protocol, not through this dialect, so
 *   this side's own `ask` is refused. A session is asked the other way: it is given niwa's
 *   `submit-answer` action (see below) and answers the question put to it by calling that.
 * - **reverse requests**: pi has no permission requests of its own; an extension that gates a tool
 *   asks through the same dialogs as any other question. A session given a `reverse` handler
 *   routes every dialog (`select`, `confirm`, `input`, `editor`) to it as a question.
 * - **structuredOutput**: pi's events carry pi's messages, not a structured result.
 * - **niwa's tools**: pi's RPC mode takes no MCP server, but an extension of pi can register one. A
 *   session given servers is started with `--extension` of this package's own (`mcp/extension.ts`) and
 *   the servers in its environment; the extension registers them, and their tools are pi's tools,
 *   `mcp__<server>__<tool>`. The servers are fixed when the process starts: a resume of a process
 *   that is held cannot change them.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNever, OptionIdSchema, pickedOptions } from "@niwa-labs/core";
import type { Answer, Question, QuestionOption } from "@niwa-labs/core";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  InputNotSent,
  InputPossiblySent,
  describeToolsMode,
  modeOf,
  modelName,
  NIWA_SESSION_ENV,
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
  TurnOutcome,
  VisibleActions,
} from "@niwa-labs/harness";
import { LIVE_PROCESS_REFUSAL, spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess } from "@niwa-labs/sandbox";
import { PI_INSTANCE_ENV } from "./insert/insert.ts";
import { PI_MCP_SERVERS_ENV, encodeServers, piToolPattern } from "./mcp/servers.ts";
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

/**
 * Why a name cannot be handed to pi's `--tools`, or `undefined` when it can.
 *
 * pi reads each entry of the list as a pattern of its own language: `*` matches any characters, a
 * leading `+` or `-` adds to or removes from the default selection, and `mcp__` addresses the tools
 * of its MCP servers. Only a plain name selects exactly that tool, which is all an allow-list of
 * niwa may promise.
 */
function unliteralToolName(name: string): string | undefined {
  if (name.trim() !== name || name === "") return "it is empty or has blank edges";
  if (/[\s,*]/.test(name)) return "pi reads `,`, `*` and blanks as the syntax of its own selection";
  if (name.startsWith("+") || name.startsWith("-")) return "pi reads a leading `+` or `-` as an edit of its defaults";
  if (name.startsWith("mcp__")) return "the tools of MCP servers are not tools of pi's own";
  return undefined;
}

/**
 * pi's flags for an allow-list of its own tools (`docs/cli.md`): `--tools` replaces the selection
 * with exactly the tools named, built-in, extension or custom, but it keeps every MCP tool unless
 * an entry names MCP tools itself (`mcp__<server>__*`), which then are the only MCP tools kept.
 *
 * `served` are the patterns of the MCP servers niwa gives the session: they go into the list, so
 * the list holds exactly the tools named and those of niwa's servers, and no other MCP tool. With
 * none, `--no-mcp` goes with the list; with no tool named either, `--no-tools` starts with every
 * tool off, the extensions and MCP servers pi loads by itself among them: those are pi's, not niwa's.
 *
 * A name pi would read as a pattern is refused with `Unsupported`: the list would reach more tools
 * than niwa named.
 */
export function piToolFlags(
  harness: HarnessId,
  ability: "start" | "resume",
  allow: readonly string[],
  served: readonly string[] = [],
): string[] {
  for (const name of allow) {
    const why = unliteralToolName(name);
    if (why !== undefined) {
      throw new Unsupported(harness, "control", ability, `${describeToolsMode({ allow })}: "${name}" cannot be named to pi exactly: ${why}`);
    }
  }
  if (served.length > 0) return ["--tools", [...allow, ...served].join(",")];
  return allow.length === 0 ? ["--no-tools"] : ["--tools", allow.join(","), "--no-mcp"];
}

/**
 * The flags for a tool mode. `servers` are the MCP servers niwa gives the session: the tools of
 * them are the tools of niwa.
 *
 * `niwa-only` switches off pi's built-in tools and keeps the tools of niwa's servers alone, so the
 * list names their pattern: pi's other MCP servers and the tools of its other extensions go with
 * the built-in ones. With no server there is no tool of niwa, and the session has none at all.
 */
export function piToolsModeFlags(
  harness: HarnessId,
  ability: "start" | "resume",
  tools: ToolsMode | undefined,
  servers: readonly McpServerSpec[] = [],
): string[] {
  if (tools === undefined || tools === "all") return [];
  const served = servers.map((server) => piToolPattern(server.name));
  if (tools === "niwa-only") return served.length === 0 ? ["--no-tools"] : ["--no-builtin-tools", "--tools", served.join(",")];
  return piToolFlags(harness, ability, tools.allow, served);
}

/**
 * Why pi cannot be given a server exactly as niwa describes it, or `undefined` when it can.
 *
 * The server goes to pi as an entry of its `mcpServers`, which pi reads with a syntax of its own: a
 * name is made of letters, digits, `_` and `-`, and two names that differ only in `-` and `_` are
 * one server; a leading `~/` of the command or an argument names the home directory; a value of the
 * environment may hold `${NAME}` and may be a `!command` to run. A server that pi would read
 * otherwise than niwa wrote it is refused, so a session never gets other tools than it was promised.
 */
function unliteralServer(server: McpServerSpec): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(server.name)) return `the server name "${server.name}" is not made of letters, digits, \`_\` and \`-\``;
  for (const word of [server.command, ...server.args]) {
    if (word.startsWith("~/")) return `pi reads a leading \`~/\` of "${word}" as its home directory`;
  }
  for (const [name, value] of Object.entries(server.env)) {
    if (value.startsWith("!") || value.includes("${")) return `pi would expand the value of ${name} as its own syntax`;
  }
  return undefined;
}

/** The refusal of a set of servers pi would not read as niwa wrote them, or nothing. */
function refuseServers(harness: HarnessId, ability: "start" | "resume", servers: readonly McpServerSpec[]): void {
  const seen = new Map<string, string>();
  for (const server of servers) {
    const why = unliteralServer(server);
    if (why !== undefined) throw new Unsupported(harness, "control", ability, `MCP server "${server.name}": ${why}`);
    const key = server.name.replace(/-/g, "_");
    const other = seen.get(key);
    if (other !== undefined) {
      throw new Unsupported(harness, "control", ability, `MCP servers "${other}" and "${server.name}" are one server to pi: its names differ only in \`-\` and \`_\``);
    }
    seen.set(key, server.name);
  }
}

/** The extension that registers a session's servers with pi: the file pi loads with `-e`. */
const TOOLS_EXTENSION = fileURLToPath(new URL("./mcp/extension.ts", import.meta.url));

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
  ask: true,
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
  /**
   * How long a turn is held open after a run ends for good, in milliseconds, for pi to say that a
   * compaction is under way or that it has settled. Default: 250.
   */
  readonly settleMs?: number;
  /** The environment pi is run in, on top of niwa's own. */
  readonly env?: Readonly<Record<string, string>>;
}
/** A `SessionControl` that also owns the processes it started. */
export interface PiSessionControl extends SessionControl {
  /** Stops a session and lets it go: the contract's release of one session. */
  close(id: SessionId): Promise<void>;

  /** Stops a session and the process it owns. */
  stop(id: SessionId): Promise<void>;
  /** Stops every session this control side owns. */
  dispose(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_SETTLE_MS = 250;
/** The most bytes one line of the wire may hold. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How much of stderr is kept to explain a death. */
const STDERR_TAIL_CHARS = 2_000;

/** How pi is told to queue a message that comes while it works. */
type StreamingBehavior = "steer" | "followUp";

/** What pi did with a prompt. */
type Disposition = "started" | "queued" | "handled";

/** What became of a message put into a session: what pi did with it, and how it was asked to queue it. */
interface Delivery {
  readonly disposition: Disposition;
  readonly behavior: StreamingBehavior | undefined;
}

/** How a request ends: pi answered it, or the process went away before it did. */
type Settled =
  | { readonly kind: "answer"; readonly incoming: Extract<PiIncoming, { kind: "response" }> }
  | { readonly kind: "gone"; readonly error: string };

/** A dialog of pi, with the line it came in as. */
interface PendingDialog {
  readonly request: DialogRequest;
  readonly raw: PiJson;
}

/**
 * How a run ended, by how its last answer stopped: pi's `stop` is a run that finished, an error, an
 * abort or a cut for length is one that did not, and a run with no answer, or one that stopped in
 * a way this snapshot does not know, proves nothing.
 */
function outcomeOfRun(messages: readonly { readonly role: string; readonly stopReason?: string | undefined }[]): TurnOutcome {
  const answer = messages.findLast((message) => message.role === "assistant");
  switch (answer?.stopReason) {
    case "stop":
      return "completed";
    case "error":
    case "aborted":
    case "length":
      return "failed";
    default:
      return "unknown";
  }
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
  /** Whether the session is lost: the process is gone, or nothing it says can be trusted any more. */
  ended = false;
  /** Whether the process has been seen to close; only then is there nothing left to kill. */
  closed = false;
  /** The stop of the process, once one has begun: every stop of the session is this one. */
  stop: Promise<void> | undefined;
  /** Whether a run ended with the word that pi will retry it: the turn is still open until the retry runs or pi settles. */
  holding = false;
  /**
   * The wait after a run that ended for good: pi may still compact its context and run again for the
   * same request (an overflow it recovers from), which is the same turn. Cleared when the turn ends,
   * a compaction begins, or the next run starts.
   */
  settling: ReturnType<typeof setTimeout> | undefined;
  /** Whether the held turn is waiting for a compaction pi began, and the run that may follow it. */
  compacting = false;
  /** How the last run of the open turn ended, as that run's last answer said; the turn ends with it. */
  runOutcome: TurnOutcome | undefined;
  /** What stderr said, kept for the error that explains a death. */
  stderrTail = "";
  /** The answers of pi that are waited for. */
  readonly pending = new Map<RequestId, (settled: Settled) => void>();
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

/** pi answered a command with a failure: it did not take it. */
class PiRefusal extends Unavailable {}

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
  /** The starts of processes that have not returned one yet: a dispose waits for them. */
  readonly #spawning = new Set<Promise<unknown>>();
  /** The last open of each session id: opens of one id run one after another. */
  readonly #opening = new Map<string, Promise<void>>();
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

  // -- the side -------------------------------------------------------------

  async start(options: StartOptions): Promise<StartedSession> {
    this.#requireOpen("start");
    this.#refuseSeen("start", options.visible, options.servers);
    const toolFlags = piToolsModeFlags(this.#harness, "start", options.tools, options.servers);
    const mode = modeOf(options.mode, this.#options.mode, PI_LAUNCH);
    requireLaunch(this.#harness, PI_LAUNCH, {
      model: options.model ?? this.#options.model,
      effort: options.effort ?? this.#options.effort,
      mode,
    });
    const cwd = resolve(options.cwd ?? this.#options.cwd ?? process.cwd());
    // pi names the session in its answer to `get_state`, before any prompt.
    const session = await this.#spawn(cwd, undefined, "start", options.model, options.effort, toolFlags, options);
    await this.#publish(session, "start");
    const id = makeSessionId(this.#harness, session.nativeId);
    // The caller knows the session before its prompt goes: a start cut off while its first turn is
    // on the way still finds it. A session whose name could not be kept is given no work.
    try {
      await options.named?.(id);
    } catch (error) {
      this.#unpublish(session);
      await this.#stopSession(session);
      throw error;
    }
    // The prompt is the first turn, delivered like a send: the start waits for pi to take it,
    // never for the run to end.
    const text = promptText(options.prompt);
    if (text.trim().length === 0) return { session: id, mode };
    try {
      return { session: id, first: await this.#submit(session, text), mode };
    } catch (error) {
      // pi refused the first message: the session was never given its work, and nobody holds
      // its id to stop it later.
      this.#unpublish(session);
      await this.#stopSession(session);
      throw error;
    }
  }

  async resume(id: SessionId, options?: ResumeOptions): Promise<void> {
    this.#requireOpen("resume");
    this.#refuseSeen("resume", options?.visible, options?.servers);
    const text = options?.prompt === undefined ? "" : promptText(options.prompt);
    // Only the opening of the process is serialized, never the run that follows: two resumes of one
    // id find one process, and a resume with a prompt does not hold up the next for the length of a turn.
    const { session, fresh } = await this.#exclusive(id.native, () => this.#open(id, options));
    if (fresh) await this.#firstTurn(session, text);
    else if (text.trim().length > 0) await this.#deliver(session, text, true);
  }

  /** The process that serves a session: the one that is held, or the one that opens its file. */
  async #open(id: SessionId, options: ResumeOptions | undefined): Promise<{ session: LiveSession; fresh: boolean }> {
    this.#requireOpen("resume");
    // A session whose process ended is remembered for its file only: it is not held, and a
    // resume that took it for held would report a session nothing is running.
    const known = this.#sessions.get(id.native);
    const held = known !== undefined && !known.ended && !known.stopping ? known : undefined;
    if (held !== undefined) {
      if (options?.tools !== undefined || options?.box !== undefined || (options?.servers ?? []).length > 0) {
        throw new Unsupported(this.#harness, "control", "resume", LIVE_PROCESS_REFUSAL);
      }
      // The one who resumes names where the dialogs go from now on.
      if (options?.reverse !== undefined) held.reverse = options.reverse;
      return { session: held, fresh: false };
    }
    const toolFlags = piToolsModeFlags(this.#harness, "resume", options?.tools, options?.servers);
    requireLaunch(this.#harness, PI_LAUNCH, { mode: modeOf(options?.mode, this.#options.mode, PI_LAUNCH) });
    // The directory the session was started in, when the caller says it, is where its file is
    // looked for and where pi is run again.
    const cwd = resolve(options?.cwd ?? this.#options.cwd ?? process.cwd());
    // A session is opened again by its file: pi's `--session`. The file is the one pi named,
    // and it is remembered; when it is not, it is looked for in the way pi names its files.
    // pi writes no file until a turn has run, so a remembered name proves nothing: the file must
    // be there, or the session cannot be opened again and the refusal says so.
    const remembered = this.#files.get(id.native);
    const file =
      remembered !== undefined && (await stat(remembered).then(() => true, () => false))
        ? remembered
        : await this.#findFile(id.native, cwd);
    if (file === undefined) {
      throw new Unavailable(
        this.#harness,
        "control",
        "resume",
        `the session "${id.native}" has no file to be opened again by: pi writes one only after a turn has run`,
      );
    }
    const session = await this.#spawn(cwd, file, "resume", options?.model, undefined, toolFlags, options ?? {});
    // pi opened the file it was given; a session it names otherwise is not the one that was
    // asked for, and holding it under the old id would continue a conversation that is not it.
    if (session.nativeId !== id.native) {
      await this.#stopSession(session);
      throw new Unavailable(
        this.#harness,
        "control",
        "resume",
        `pi opened the session "${session.nativeId}", not the session "${id.native}" that was asked for`,
      );
    }
    await this.#publish(session, "resume");
    return { session, fresh: true };
  }

  /**
   * A message pi refused, or one that never left, was not sent; one written whose answer never came
   * may have started a run, and is not sent again.
   */
  async send(id: SessionId, message: string, options?: SendOptions): Promise<DeliveryReceipt> {
    const session = this.#sessions.get(id.native);
    if (session === undefined || session.ended) {
      throw new InputNotSent(this.#harness, "send", `the session "${id.native}" is not held, or its pi process is gone`);
    }
    try {
      return await this.#submit(session, message, options);
    } catch (error) {
      if (error instanceof PiRefusal) throw new InputNotSent(this.#harness, "send", error.message);
      throw new InputPossiblySent(this.#harness, "send", error instanceof Error ? error.message : String(error));
    }
  }

  /** Delivers a message and says what became of it; nothing waits for the run to end. */
  async #submit(session: LiveSession, message: string, options?: SendOptions): Promise<DeliveryReceipt> {
    const at = Date.now();
    // The runs counted before the message goes out: pi may begin the run in the same read as
    // its answer, and the receipt of a run it starts names that run, not the one after it.
    const before = session.turn;
    const delivery = await this.#put(session, message, options?.into);
    switch (delivery.disposition) {
      // An extension of pi took the message as a command of its own: no run began, and none will
      // for it. It reached the session, and it names no turn.
      case "handled":
        return { status: "handled", at };
      // The caller does not wait for the end of the run; the signs of life report it.
      case "started":
        return { status: "started", turn: before + 1, at };
      case "queued":
        // Only a caller that asks for it gets its message into the running turn; otherwise pi keeps
        // the message for the answer that comes after the running one.
        return delivery.behavior === "steer"
          ? { status: "delivered", turn: session.turn, at }
          : { status: "queued", turn: session.turn + 1, at };
      default:
        return assertNever(delivery.disposition, "pi prompt disposition");
    }
  }

  /**
   * Puts a message into a session, and says what pi did with it.
   *
   * The queueing is pi's own `prompt` with a `streamingBehavior`: pi decides, atomically, whether
   * it is working. A bare `steer` or `follow_up` sent after the run ended in the same read would be
   * kept by an idle pi and never delivered; this one just starts a run. A session seen busy is
   * queued from the start. One not seen busy gets a bare prompt, and when pi refuses it because it
   * is working after all (the side has not seen the run begin yet), the refusal is taken at its
   * word and the message is queued, the way the caller asked for.
   *
   * Only an answer that is a refusal of this very command, with the reason pi gives for being busy,
   * allows the second write. Any other failure may have left the first one in pi's hands.
   */
  async #put(
    session: LiveSession,
    message: string,
    into: SendOptions["into"],
  ): Promise<Delivery> {
    const queued: StreamingBehavior = into === "turn" ? "steer" : "followUp";
    if (session.busy) return { disposition: await this.#prompt(session, message, queued), behavior: queued };
    try {
      return { disposition: await this.#prompt(session, message, undefined), behavior: undefined };
    } catch (error) {
      if (!isBusyRefusal(error)) throw error;
      return { disposition: await this.#prompt(session, message, queued), behavior: queued };
    }
  }

  /**
   * One `prompt`, and what pi says it did: started a run, queued the message, or handled it with no
   * run. A pi that predates the dispositions says nothing, and the side's own reading of what it
   * asked for stands in.
   */
  async #prompt(session: LiveSession, message: string, behavior: StreamingBehavior | undefined): Promise<Disposition> {
    const response = await this.#call(session, "prompt", behavior === undefined ? { message } : { message, streamingBehavior: behavior });
    if (response.command !== "prompt") {
      throw new Unavailable(this.#harness, "control", "prompt", `pi answered "${response.command}" to the command "prompt"`);
    }
    return response.data?.disposition ?? (behavior === undefined ? "started" : "queued");
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
      "pi has no structured output: niwa asks a pi session through a request, which the session answers with niwa's `submit-answer` action",
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

  /** The release the shared contract names: stops this session's process and no other. */
  async close(id: SessionId): Promise<void> {
    await this.stop(id);
  }

  async stop(id: SessionId): Promise<void> {
    const session = this.#sessions.get(id.native);
    if (session === undefined) return;
    this.#unpublish(session);
    await this.#stopSession(session);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#sessions.clear();
    // A process that is still being started stops itself the moment it is returned, and the dispose
    // does not end before that has happened.
    await Promise.allSettled([...this.#spawning]);
    for (const session of [...this.#owned]) {
      await this.#stopSession(session);
    }
  }

  // -- the owner ------------------------------------------------------------

  /** A disposed side starts and opens nothing. */
  #requireOpen(ability: "start" | "resume"): void {
    if (this.#disposed) {
      throw new Unavailable(this.#harness, "control", ability, "the control side is disposed");
    }
  }

  /** Runs `work` once the earlier work for the same key has ended. */
  async #exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#opening.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.#opening.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#opening.get(key) === tail) this.#opening.delete(key);
    }
  }

  /**
   * Makes a process the holder of the id pi named for it. A process that was started is held only
   * once its id is known to be the right one, and never in the place of another that is alive.
   */
  async #publish(session: LiveSession, ability: "start" | "resume"): Promise<void> {
    const holder = this.#sessions.get(session.nativeId);
    const refusal =
      this.#disposed
        ? "the control side is disposed"
        : holder !== undefined && holder !== session && !holder.ended && !holder.stopping
          ? `another process of this side holds the session "${session.nativeId}"`
          : undefined;
    if (refusal !== undefined) {
      await this.#stopSession(session);
      throw new Unavailable(this.#harness, "control", ability, refusal);
    }
    this.#sessions.set(session.nativeId, session);
  }

  /** Lets go of the id a process holds, when it is the holder. */
  #unpublish(session: LiveSession): void {
    if (this.#sessions.get(session.nativeId) === session) this.#sessions.delete(session.nativeId);
  }

  // -- the session ----------------------------------------------------------

  /** The environment pi is run in. */
  #env(): Record<string, string> {
    // Every process of this side is niwa's: it says so, and which installation it belongs to, to the
    // extension inside it, so a session niwa started is not reported as one opened by hand.
    const env: Record<string, string> = { ...this.#options.env, [NIWA_SESSION_ENV]: "1", [PI_INSTANCE_ENV]: this.#harness };
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
   * session and its file. That file is what a later start opens again. The process is owned from the
   * moment it exists, but it is held under no id yet: the caller publishes it once it is the one
   * that was asked for.
   */
  #spawn(
    cwd: string,
    file: string | undefined,
    ability: "start" | "resume",
    model: string | undefined,
    effort: string | undefined,
    toolFlags: readonly string[],
    plan: Pick<StartOptions, "env" | "box" | "reverse" | "servers">,
  ): Promise<LiveSession> {
    const starting = this.#launch(cwd, file, ability, model, effort, toolFlags, plan);
    this.#spawning.add(starting);
    const done = (): void => void this.#spawning.delete(starting);
    starting.then(done, done);
    return starting;
  }

  async #launch(
    cwd: string,
    file: string | undefined,
    ability: "start" | "resume",
    model: string | undefined,
    effort: string | undefined,
    toolFlags: readonly string[],
    plan: Pick<StartOptions, "env" | "box" | "reverse" | "servers">,
  ): Promise<LiveSession> {
    const binary = this.#options.binary ?? "pi";
    const args = ["--mode", "rpc"];
    if (file !== undefined) args.push("--session", file);
    const chosen = model ?? this.#options.model;
    if (chosen !== undefined) args.push("--model", chosen);
    const chosenEffort = effort ?? this.#options.effort;
    if (chosenEffort !== undefined) args.push("--thinking", chosenEffort);
    args.push(...toolFlags);
    // The tools of niwa are brought into pi by an extension of this one session, which registers the servers
    // it is given through the environment.
    const servers = plan.servers ?? [];
    if (servers.length > 0) args.push("--extension", TOOLS_EXTENSION);

    const child = await spawnAgent({
      harness: this.#harness,
      program: binary,
      args,
      cwd,
      env: { ...this.#env(), ...(servers.length > 0 ? { [PI_MCP_SERVERS_ENV]: encodeServers(servers) } : {}), ...plan.env },
      box: plan.box,
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
    child.on("close", (code: number | null) => {
      session.closed = true;
      this.#gone(session, new Error(`pi: the process ended with code ${String(code)}`));
    });

    // A side disposed while the process was being started does not keep it: nobody could stop it later.
    if (this.#disposed) {
      await this.#stopSession(session);
      throw new Unavailable(this.#harness, "control", ability, "the control side is disposed");
    }

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
    // A session whose wire was given up on is read no more: what it still says proves nothing.
    if (session.ended) return;
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
      // A line that never ends is not pi's. The session is lost, and it is said so; what is buffered
      // is let go of, and the process is ended: nothing reads it any more, and nobody could stop it
      // once the session is gone.
      session.buffer = "";
      this.#gone(session, new Error("pi: a line of the wire did not end"));
      void this.#stopSession(session);
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
        // A run that begins with nothing between it and the end of the last is the run of a message
        // that was queued: its own turn, after the one that ended.
        if (session.settling !== undefined) this.#endTurn(session);
        session.busy = true;
        if (session.holding) {
          // The run pi retries, or begins again after a compaction, is the turn that is still open.
          session.holding = false;
          session.compacting = false;
          session.emit({ kind: "activity", at: Date.now(), detail: event.type });
          return;
        }
        session.turn += 1;
        session.emit({ kind: "turn-started", turn: session.turn, at: Date.now() });
        return;
      }
      case "agent_end": {
        session.runOutcome = outcomeOfRun(event.messages);
        if (event.willRetry === true) {
          // pi runs the same request again by itself: the turn goes on, and the session is not idle between the tries.
          session.holding = true;
          session.emit({ kind: "activity", at: Date.now(), detail: "agent_end (pi will retry)" });
          return;
        }
        // The run is over, but pi may compact its context and run the request again as part of the same
        // turn, saying so only after this event: the turn is held open for a moment, and ends when pi
        // settles, when nothing of the kind is announced, or when the compaction it announced ends.
        this.#settle(session);
        return;
      }
      case "agent_settled": {
        // pi says nothing more is coming, or gave up the retry it announced (an abort): the turn held open ends here.
        if (session.holding || session.settling !== undefined) this.#endTurn(session, event.aborted ? "failed" : "unknown");
        else session.emit({ kind: "activity", at: Date.now(), detail: event.type });
        return;
      }
      case "compaction_start": {
        session.emit({ kind: "activity", at: Date.now(), detail: event.type });
        // A compaction right after a run: the turn waits for it, and for the run that may follow.
        if (session.settling !== undefined) this.#awaitCompaction(session);
        return;
      }
      case "compaction_end": {
        session.emit({ kind: "activity", at: Date.now(), detail: event.type });
        if (session.settling !== undefined) this.#awaitCompaction(session);
        if (!session.compacting) return;
        session.compacting = false;
        // pi runs the request again after the compaction (an overflow it recovered from): the turn is
        // still open until that run ends. A compaction that does not, ends the turn it was held for.
        if (event.willRetry && !event.aborted) session.holding = true;
        else this.#endTurn(session, event.aborted ? "failed" : "unknown");
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
      case "queue_update":
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

  /** A run ended for good: the turn is held open for a moment, then ends if pi has not said more. */
  #settle(session: LiveSession): void {
    clearTimeout(session.settling);
    session.holding = false;
    session.settling = setTimeout(() => {
      session.settling = undefined;
      if (!session.ended) this.#endTurn(session);
    }, this.#options.settleMs ?? DEFAULT_SETTLE_MS);
  }

  /** pi began a compaction after a run: the turn is held until the compaction ends, with no time limit but the turn's own. */
  #awaitCompaction(session: LiveSession): void {
    clearTimeout(session.settling);
    session.settling = undefined;
    session.holding = true;
    session.compacting = true;
  }

  /**
   * The turn that is open ends: nothing of it is in flight any more. It ended as its last run said;
   * when no run said, `unaccounted` is what pi's closing word (an abort) proves.
   */
  #endTurn(session: LiveSession, unaccounted: TurnOutcome = "unknown"): void {
    const outcome = session.runOutcome ?? unaccounted;
    session.runOutcome = undefined;
    clearTimeout(session.settling);
    session.settling = undefined;
    session.compacting = false;
    session.holding = false;
    session.busy = false;
    session.emit({ kind: "turn-ended", turn: session.turn, at: Date.now(), outcome });
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
    // An answer to another command is neither this command's success nor its refusal.
    if (response.command !== command) {
      throw new Unavailable(
        this.#harness,
        "control",
        command,
        `pi answered "${response.command}" to the command "${command}"`,
      );
    }
    if (!response.success) {
      throw new PiRefusal(this.#harness, "control", command, response.error);
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
    let delivery: Delivery;
    try {
      delivery = await this.#put(session, message, undefined);
    } catch (error) {
      ended?.cancel();
      throw error;
    }
    if (ended === null) return;
    // No run began for a message an extension handled: there is no end to wait for.
    if (delivery.disposition === "handled") {
      ended.cancel();
      return;
    }
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
    session.holding = false;
    session.compacting = false;
    clearTimeout(session.settling);
    session.settling = undefined;
    session.abortDialogs();
    for (const settle of session.pending.values()) {
      const tail = session.stderrTail.trim();
      settle({ kind: "gone", error: tail === "" ? reason.message : `${reason.message}: ${tail}` });
    }
    session.pending.clear();
    session.finish();
  }

  /**
   * What a request asks of the session's tools that pi cannot do is refused before a process is
   * started: a session promised niwa actions that no server brings would wait for a call that never
   * comes, a tool switched off singly is not a switch this side has, and a server pi would read
   * otherwise than niwa wrote it would give the session other tools than it was promised.
   */
  #refuseSeen(
    ability: "start" | "resume",
    visible: VisibleActions | undefined,
    servers: readonly McpServerSpec[] | undefined,
  ): void {
    if (visible !== undefined && visible.disabledTools.length > 0) {
      throw new Unsupported(this.#harness, "control", ability, "pi's tools are not switched off one by one: this side holds a session to a mode of tools");
    }
    if (visible !== undefined && visible.actions.length > 0 && (servers ?? []).length === 0) {
      throw new Unsupported(this.#harness, "control", ability, "the session is to see niwa actions, but no MCP server was given to bring them into pi");
    }
    refuseServers(this.#harness, ability, servers ?? []);
  }

  /** The turn a resume carries into a session just opened; a session whose turn fails is not left running. */
  async #firstTurn(session: LiveSession, text: string): Promise<void> {
    if (text.trim().length === 0) return;
    try {
      await this.#deliver(session, text, true);
    } catch (error) {
      this.#unpublish(session);
      await this.#stopSession(session);
      throw error;
    }
  }

  /**
   * Stops a session and the process it owns.
   *
   * A session that is lost (its wire could not be trusted) still has a process, and it is ended
   * here: only a process seen to close, or one that exited, has nothing left to kill. Every stop of
   * a session is the same stop.
   */
  #stopSession(session: LiveSession): Promise<void> {
    this.#owned.delete(session);
    session.stop ??= this.#terminate(session);
    return session.stop;
  }

  async #terminate(session: LiveSession): Promise<void> {
    const child = session.child;
    if (!session.closed && child.exitCode === null && child.signalCode === null) {
      session.stopping = true;
      const grace = this.#options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
      const closing = new Promise<boolean>((resolve) => {
        child.once("close", () => resolve(true));
      });
      child.kill("SIGTERM");
      const gone = await Promise.race([closing, delay(grace).then(() => false)]);
      if (!gone) child.kill("SIGKILL");
    }
    this.#gone(session, new Error("pi: the process was stopped"));
  }

  /**
   * The file of a session, looked for the way pi names its files.
   *
   * pi names a session file `<time>_<id>.jsonl` in the directory of the project, and the
   * directory is named after the working directory.
   */
  async #findFile(native: string, cwd: string): Promise<string | undefined> {
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

/**
 * Whether pi refused a prompt because it was working: its answer to that prompt was a failure that
 * says so. A line this side could not read, or an answer it does not know, may say the same words
 * and is no refusal: the prompt may have been taken.
 */
function isBusyRefusal(error: unknown): boolean {
  return error instanceof PiRefusal && error.message.includes("already processing");
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
