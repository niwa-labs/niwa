/**
 * The control side: how niwa starts, steers and stops the sessions of a harness
 *. It owns the processes it starts and their termination.
 */

import { z } from "zod";

import type { Timestamp } from "@niwa-labs/core";

import type { SessionMode } from "./capabilities.ts";
import type { BoxRequest } from "@niwa-labs/sandbox";
import type { OptionBlocks } from "./options.ts";
import type { SessionId } from "./reading.ts";
import type { ReverseHandler } from "./reverse.ts";

/** How often a prompt section changes, so plugins can contribute without breaking each other's cache. */
export const PromptTierSchema = z.enum(["constant", "stable", "volatile"]);
export type PromptTier = z.output<typeof PromptTierSchema>;

export const PromptSectionSchema = z.object({
  id: z.string().min(1),
  tier: PromptTierSchema,
  text: z.string(),
});
export type PromptSection = z.output<typeof PromptSectionSchema>;

/** A prompt is sections, in the order they are sent. */
export const PromptSchema = z.object({
  sections: z.array(PromptSectionSchema),
});
export type Prompt = z.output<typeof PromptSchema>;

/** Plain text becomes one volatile section, before any intercept sees it. */
export function promptFromText(text: string): Prompt {
  return { sections: [{ id: "prompt", tier: "volatile", text }] };
}

/**
 * Which niwa actions a session sees and which harness tools are switched off. The tool names are
 * the harness's own. A harness that cannot switch a tool off refuses the request with
 * `Unsupported`: a tool left on silently would be a promise broken.
 */
export interface VisibleActions {
  readonly actions: readonly string[];
  readonly disabledTools: readonly string[];
}

/** An allow-list of the harness's own tools: the names are the harness's own. */
export interface ToolAllowance {
  readonly allow: readonly string[];
}

/**
 * The tools a session may use, for its whole life:
 *
 * - `all`: the harness's own tools, as the harness has them;
 * - `niwa-only`: none of the harness's own tools, only those of the MCP servers niwa gives it;
 * - `{ allow }`: exactly the harness's own tools named, and those of the servers niwa gives it.
 *
 * A kind that cannot hold a session to the mode refuses it with `Unsupported` before the first
 * prompt; a tool left on silently would be a promise broken.
 */
export type ToolsMode = "all" | "niwa-only" | ToolAllowance;

export const ToolsModeSchema = z.union([
  z.literal("all"),
  z.literal("niwa-only"),
  z.object({ allow: z.array(z.string().min(1)).readonly() }).strict(),
]);

/** The mode said the way a refusal says it. */
export function describeToolsMode(mode: ToolsMode): string {
  return typeof mode === "string" ? `tools ${mode}` : `tools allow [${mode.allow.join(", ")}]`;
}

export const NO_VISIBLE_ACTIONS: VisibleActions = { actions: [], disabledTools: [] };

/**
 * One MCP server a session is given, as niwa says it.
 *
 * The spec is niwa's own: each harness kind maps it to the dialect that kind speaks, because the
 * dialects differ (Claude Code's ACP names the servers of a session, mcode the servers of a
 * handshake).
 */
export interface McpServerSpec {
  /** The name the session knows the server by. */
  readonly name: string;
  /** The program that starts the server. */
  readonly command: string;
  /** The arguments of the program, the first of which may carry the home. */
  readonly args: readonly string[];
  /** The environment the server is given. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The names of the tools the server lists, when niwa knows them without connecting (its own
   * server does: they are the tools of the actions the session may see). A harness whose tool
   * allow-list also filters MCP tools adds them to it; a foreign server has none here.
   */
  readonly tools?: readonly string[];
  /** What only ZCode's `mcpServers` entry takes; left out, ZCode's own defaults stand. Other kinds ignore it. */
  readonly zcode?: ZcodeMcpOptions;
}

/** The optional fields of a ZCode `mcpServers` entry, as ZCode's protocol names them. */
export interface ZcodeMcpOptions {
  readonly alwaysLoad?: boolean;
  readonly timeoutMs?: number;
  readonly isolation?: "session" | "workspace";
  readonly scope?: "user" | "workspace";
  readonly cwd?: string;
  readonly protocolVersion?: "legacy" | "auto" | "2026-07-28";
}

/**
 * What happened to a message sent into a session: `delivered` into the running turn, `queued`
 * after the current turn, `started` a new turn, or `handled` by the harness itself with no turn
 * (a command it answers on its own). A busy session queues by default.
 */
export const DeliveryReceiptSchema = z.object({
  status: z.enum(["delivered", "queued", "started", "handled"]),
  turn: z.number().int().positive().optional(),
  at: z.number().int().nonnegative().optional(),
});
export type DeliveryReceipt = z.output<typeof DeliveryReceiptSchema>;

/**
 * What the harness says it decided about a tool call without asking: allow or deny, who decided
 * (a classifier, a rule, the mode, a hook, the user). The words of `decidedBy`, `ruleKind` and `mode`
 * are the harness's own and may grow, so they are kept as it says them. The harness's free-text
 * reason is not part of it: a session record carries no free text, and the schema drops it.
 */
export const PermissionMarkSchema = z.object({
  decision: z.enum(["allow", "deny"]).optional(),
  decidedBy: z.string().optional(),
  /** The kind of the rule that decided, `null` when no rule did; a mark without the key (an older build) reads as `null`. */
  ruleKind: z.string().nullable().default(null),
  mode: z.string().optional(),
});
export type PermissionMark = z.output<typeof PermissionMarkSchema>;

/**
 * The model a session really runs, as the harness names it: the answer the harness gave, never the
 * alias or the request. It is what a resume pins the session to.
 */
export const ModelNameSchema = z.string().min(1).brand<"ModelName">();
export type ModelName = z.output<typeof ModelNameSchema>;

/** The model a harness named; a name that is empty is no name. */
export function modelName(value: string): ModelName {
  return ModelNameSchema.parse(value);
}

/** The name of a wire protocol, in the harness's own words: `codex app-server`. */
export const ProtocolNameSchema = z.string().min(1).brand<"ProtocolName">();
export type ProtocolName = z.output<typeof ProtocolNameSchema>;

/** The value of the discriminator of a message in a wire protocol (a method, a type): what a build of niwa knows or does not. */
export const VariantNameSchema = z.string().brand<"VariantName">();
export type VariantName = z.output<typeof VariantNameSchema>;

/**
 * How a turn ended, as far as the harness knows: `completed` (its result says it finished), `failed`
 * (the harness refused it or reported an error for it), `unknown` (the connection went, or the
 * harness did not answer, so nobody knows what became of it). A harness that says none leaves it out.
 */
export const TurnOutcomeSchema = z.enum(["completed", "failed", "unknown"]);
export type TurnOutcome = z.output<typeof TurnOutcomeSchema>;

/** A sign of life. */
export const LifeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn-started"),
    turn: z.number().int().positive(),
    at: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("turn-ended"),
    turn: z.number().int().positive(),
    at: z.number().int().nonnegative().optional(),
    outcome: TurnOutcomeSchema.optional(),
  }),
  z.object({
    kind: z.literal("activity"),
    at: z.number().int().nonnegative(),
    detail: z.string().optional(),
    /** The name of the tool the activity is a call of, when the harness says it; the sessions record keeps it only as a short identifier. */
    tool: z.string().optional(),
    /** The decision on a tool call the harness made by itself, when it says so. */
    permission: PermissionMarkSchema.optional(),
  }),
  /**
   * Claude Code's advisor (a stronger model it asks for a review) was called, or answered. The
   * answer is named by its kind, never by its text; the model is known only once it answered.
   */
  z.object({
    kind: z.literal("advisor"),
    at: z.number().int().nonnegative(),
    phase: z.enum(["started", "finished"]),
    callId: z.string().min(1),
    model: z.string().optional(),
    result: z.enum(["text", "redacted", "error"]).optional(),
    errorCode: z.string().optional(),
  }),
  /**
   * A message of the harness's protocol that niwa's snapshot of the protocol does not know (the
   * harness got newer): the protocol, the value of its discriminator, and the message as it came.
   */
  z.object({
    kind: z.literal("unknown-variant"),
    at: z.number().int().nonnegative(),
    /** The wire protocol the message came in. */
    protocol: ProtocolNameSchema,
    /** The value of the message's discriminator that this build of niwa does not know. */
    variant: VariantNameSchema,
    /** The message as it arrived. */
    raw: z.json(),
  }),
  z.object({
    /**
     * The harness named the model the session runs. A harness says it as soon as it knows, which
     * is after the start for the ones whose program names it with its first turn.
     */
    kind: z.literal("model"),
    model: ModelNameSchema,
  }),
]);
export type LifeEvent = z.output<typeof LifeEventSchema>;

/**
 * A message as JSON, by its JSON text: what a harness put together from its parts may hold
 * `undefined` (no params), which JSON leaves out, and the message is not lost for it. A value that
 * has no JSON text (a cycle) reads as `null`.
 */
export function rawJson(value: unknown): Extract<LifeEvent, { kind: "unknown-variant" }>["raw"] {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : z.json().parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The signs of life of a message that is not in niwa's snapshot of a protocol (the harness got
 * newer): the typed unknown, which the sessions plugin writes once for each variant, and an activity.
 * A session that keeps sending what niwa does not know is at work, and the unknown alone, written
 * once, would not say so. `detail` is what the activity says; it is the variant when not given.
 */
export function unknownVariantSigns(
  at: number,
  protocol: ProtocolName,
  variant: VariantName,
  raw: unknown,
  detail: string = variant,
): [LifeEvent, LifeEvent] {
  return [
    { kind: "unknown-variant", at, protocol, variant, raw: rawJson(raw) },
    { kind: "activity", at, detail },
  ];
}

/**
 * After a restart a last "turn started" proves nothing about now, so `unknown` is a first-class
 * answer, different from both `idle` and `running`.
 */
export type SessionState = "running" | "idle" | "unknown";

/**
 * What a question is asked with. The options blocks are the ones the session was started with: a
 * control side that asks in a process of its own gives it what the session's own process was given.
 */
export interface AskOptions<T> extends OptionBlocks {
  /** The schema the answer must pass. */
  readonly schema: z.ZodType<T>;
  readonly prompt: Prompt;
  /**
   * The id of the question, when the harness cannot answer natively.
   *
   * Then niwa gives the session the action to submit an answer, bound to this question, and the
   * session calls it with this id. A harness that answers natively does not need it.
   */
  readonly question?: string;
}

export interface AskAnswer<T> {
  readonly session: SessionId;
  /** The value that passed the schema. */
  readonly value: T;
  readonly at: Timestamp;
}

/**
 * Where a message goes into a session. By default a message to a busy session is queued after
 * the current turn; `into: "turn"` asks for delivery into the running turn instead.
 */
export interface SendOptions {
  readonly into?: "turn";
}

/**
 * How long a turn may run before the control side gives up on it, when the instance sets none
 * (`control.turnTimeoutMs`). A turn is the agent's work, not a call: it is bounded by hours, never
 * by the seconds a call to the harness may take.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * What a session is started with. The options blocks (`claude`, `codex`, ...) are the options of the
 * kind the session is of, checked by niwa before the start: a control side reads its own block.
 */
export interface StartOptions extends OptionBlocks {
  /**
   * The first message of the session. When it has text, it becomes the session's first turn,
   * delivered the way a send delivers a message: the start does not wait for that turn to end.
   */
  readonly prompt: Prompt;
  readonly model?: string;
  readonly effort?: string;
  /** The working mode, for the whole life of the session; the instance's own, else `auto`, when absent. */
  readonly mode?: SessionMode;
  readonly visible?: VisibleActions;
  readonly cwd?: string;
  /** The MCP servers the session is given, as niwa names them. */
  readonly servers?: readonly McpServerSpec[];
  /**
   * The environment the session's own process runs in, on top of the one it inherits: niwa puts
   * the session's token in it (`NIWA_ID`), so `niwa` run from the agent's Bash is that session.
   * Every session has a process of its own, so every side applies it.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** The tools the session may use; the harness's own when absent. */
  readonly tools?: ToolsMode;
  /** Run the session's process in a sandbox (L2): the process is started through the `spawnAgent` funnel. */
  readonly box?: BoxRequest;
  /**
   * Where the session's reverse requests go: the permissions and the questions its agent asks of its
   * client. Without it a side answers them by its own policy, as a side used on its own does.
   */
  readonly reverse?: ReverseHandler;
  /**
   * Told the session's id as soon as the harness names it, before the first prompt is sent, by a
   * side whose harness names the session first. The caller writes it down, so a start cut off
   * while its prompt was going finds the session it made instead of making another.
   */
  readonly named?: (session: SessionId) => Promise<void> | void;
}

/**
 * What a session is resumed with. The options blocks are the ones the session was started with: a
 * process that is launched again is launched as the first one was.
 */
export interface ResumeOptions extends OptionBlocks {
  /** The mode the session was started in, for a process that is launched again: a session keeps its mode. */
  readonly mode?: SessionMode;
  /**
   * The model the harness named for the session, for a process that is launched again: a session
   * keeps its model, not the alias it was asked for. Without it the instance's own stands.
   */
  readonly model?: ModelName;
  readonly prompt?: Prompt;
  readonly visible?: VisibleActions;
  /** The directory the session was started in, for a process that is launched again: a harness that loads a session by its directory needs the one it has. */
  readonly cwd?: string;
  /** The MCP servers the session is given, as niwa names them. */
  readonly servers?: readonly McpServerSpec[];
  /** The environment of the session's process, as in `StartOptions`. */
  readonly env?: Readonly<Record<string, string>>;
  /** The tools the session may use, as in `StartOptions`: the ones it was started with. */
  readonly tools?: ToolsMode;
  /** The box of the session's process, as in `StartOptions`. */
  readonly box?: BoxRequest;
  /** Where the session's reverse requests go, as in `StartOptions`: a resume names the handler the session has from now on. */
  readonly reverse?: ReverseHandler;
}

/**
 * A session the harness has named, and what became of its first message.
 *
 * `first` is the receipt of the first turn, as a send would give it (`started` or `queued`);
 * a start without a prompt has none. The end of that turn is not part of the start: it is
 * observed like the end of any turn, through the signs of life and the state.
 */
export interface StartedSession {
  readonly session: SessionId;
  readonly first?: DeliveryReceipt;
  /** The working mode the session was given: the one asked for, or the instance's, or the default. */
  readonly mode?: SessionMode;
}

/** An operation the harness cannot do is refused by name, never emulated (capabilities.ts). */
export interface SessionControl {
  /**
   * Starts a session. Until the harness names it there is no session, only a start in progress
   * whose result is that id.
   *
   * It returns as soon as the harness has named the session — never later than the moment the
   * first turn has begun, and never after waiting for that turn to end. A harness whose protocol
   * names the session only with the first prompt returns once the protocol has named it, which
   * is at the start of that turn. A start that fails before the session is named leaves no
   * session behind; a first turn that fails after the start returned is a turn that failed,
   * reported through the signs of life, and the session stays.
   */
  start(options: StartOptions): Promise<StartedSession>;

  resume(id: SessionId, options?: ResumeOptions): Promise<void>;

  /**
   * Sends into a session and says what happened to the message. A send that fails says how far the
   * message got (delivery.ts): `InputNotSent` when the harness never had it, `InputPossiblySent`
   * when it may have; any other failure is taken for possibly sent, and is never sent again.
   */
  send(id: SessionId, message: string, options?: SendOptions): Promise<DeliveryReceipt>;

  /** Interrupts a running turn. Only on explicit request, and only where the harness can. */
  interrupt(id: SessionId): Promise<void>;

  /**
   * Asks a session and returns a value that passed the schema.
   *
   * A busy session queues the question behind what is running and already queued, like a send:
   * the answer comes after those turns, never instead of them.
   */
  ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>>;

  /**
   * Signs of life, as they happen.
   *
   * The stream is forward-only, with one exception: the turn signs a session gave before anyone
   * watched it (the first turn begins inside the start, before the caller holds the id) are kept,
   * a bounded few, and given to the first stream opened on the session. After that nothing is
   * kept.
   */
  life(id: SessionId): AsyncIterable<LifeEvent>;

  state(id: SessionId): Promise<SessionState>;

  /**
   * Stops the process of one session and lets it go: what is running in it stops, and the session
   * is the harness's to resume later where it can. A side that holds no process per session may
   * leave it out.
   */
  close?(id: SessionId): Promise<void>;

  /**
   * Stops every session this side owns.
   *
   * A side that owns processes — the harness CLI and the MCP servers it was given — stops them
   * here, so nothing it started outlives the host that started it. A side that owns nothing may
   * leave it out.
   */
  dispose?(): Promise<void>;
}
