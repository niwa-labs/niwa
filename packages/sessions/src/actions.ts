/**
 * The actions of the sessions module, as typed references: name, description and the two schemas.
 *
 * A caller imports these to call a session action with input and output checked by the type
 * checker, on the host and on a client. The module's factory builds its real actions from the same
 * references (`action(sessionStart, { recovery, run })`), so the schemas are one value.
 */

import { z } from "zod";

import { JsonSchemaValue, actionRef, getRef, Address } from "@niwa-labs/core";
import {
  AssistantRecordSchema,
  CompactionRecordSchema,
  DeliveryReceiptSchema,
  NestedRecordSchema,
  HarnessIdSchema,
  HarnessKindSchema,
  HarnessSidesSchema,
  MachineIdSchema,
  OptionsBlockNameSchema,
  withBlocks,
  SessionModeSchema,
  ThinkingRecordSchema,
  ToolsModeSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  UnknownRecordSchema,
  UserRecordSchema,
} from "@niwa-labs/harness";
import { SessionWorktree, WorktreeOption } from "@niwa-labs/git/records";
import { BoxAccessSchema } from "@niwa-labs/sandbox";
import { CoverageSchema, ReadAnswerSchema, SearchMatchSchema, SearchQuerySchema, readInput } from "@niwa-labs/history/records";

import { NiwaSessionIdSchema } from "./identity.ts";
import { PromptInputSchema } from "./prompt.ts";
import { BelongingSource, TurnEnding } from "./records.ts";
import { VisibleActionsInputSchema } from "./visible.ts";

/**
 * The session an action is given: the id niwa gave it (`s-3fa9c2`) or any text that names one, such
 * as the start or the end of the id. A session niwa did not start has no such id: it is named by its
 * pair, `<harness> <native>` or `{ harness, native }`.
 */
export const SessionRefInput = z.union([
  z.string().min(1),
  z.object({ harness: z.string().min(1), native: z.string().min(1) }),
]);

/** One session, as the actions report it. */
export const SessionEntrySchema = z.object({
  /** The id niwa gave the session; absent for a session niwa did not start. */
  id: NiwaSessionIdSchema.optional(),
  /** The pointer: which harness, and which session of it, `<harness> <native>`. */
  ref: z.string().min(1),
  /**
   * A readable title: the harness's own name or summary of the session, else its first message
   * from a person, trimmed to about 60 characters. Absent when neither is known.
   */
  title: z.string().optional(),
  run: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  /** What niwa knows about its state right now. */
  state: z.enum(["running", "idle", "ended", "unknown"]),
});

/** Whom a session serves: a record of its own, apart from the session. */
export const BelongingSchema = z.object({
  session: z.string().min(1),
  to: Address,
  source: BelongingSource,
});

/** A harness whose sessions could not be listed: its absence from the list proves nothing. */
export const UnreadableSchema = z.object({ harness: z.string().min(1), reason: z.string() });

/** How many sessions a page of `session.list` holds when no limit is said. */
export const SESSION_LIST_DEFAULT = 100;
/** The most sessions one page may hold: a page must stay far below the wire line limit. */
export const SESSION_LIST_MAX = 500;

export const sessionList = actionRef("session.list", {
  description: "Lists the sessions niwa knows about, most recently active first and a page at a time (`nextCursor` gives the next page), each with a readable title when one is known, and whom each serves.",
  input: z.object({
    /** Only sessions of this harness. */
    harness: z.string().min(1).optional(),
    /** Only sessions in this working directory. */
    cwd: z.string().min(1).optional(),
    managedOnly: z.boolean().describe("List only sessions that niwa started, using its own catalog.").optional(),
    limit: z.number().int().positive().max(SESSION_LIST_MAX).describe(`How many sessions one page holds; ${SESSION_LIST_DEFAULT} when not said.`).optional(),
    cursor: z.string().min(1).describe("The `nextCursor` of the previous page: the page that follows it. Keep the other fields the same.").optional(),
  }),
  output: z.object({
    /** One page of the sessions, the most recently active first. */
    sessions: z.array(SessionEntrySchema),
    /** How many sessions match in all, across every page. */
    total: z.number().int().nonnegative(),
    /** Pass as `cursor` to get the next page; absent on the last page. */
    nextCursor: z.string().min(1).optional(),
    /** Says that the page is not the whole list, and how to get the rest; absent on the last page. */
    hint: z.string().optional(),
    /** The attachments of the listed sessions, each with its source. */
    belongings: z.array(BelongingSchema),
    unreadable: z.array(UnreadableSchema),
  }),
});

export const sessionGet = getRef("session.get", {
  kind: "session",
  noun: "session niwa started",
  detail: "It says the harness and the harness's own id of the session, its state, and whom it serves.",
  entity: SessionEntrySchema.extend({
    id: NiwaSessionIdSchema,
    /** Whom the session serves, each with its source. */
    belongings: z.array(BelongingSchema),
  }),
});

export const sessionBelong = actionRef("session.belong", {
  description: "Says whom a session serves: the address it belongs to, with the source of the choice. The same session and the same address are one belonging, however many times it is said.",
  input: z.object({
    /** The session that serves this address. */
    session: SessionRefInput,
    /** Whom the session serves. */
    to: Address,
    /** Where the attachment came from. */
    source: z.literal("explicit"),
  }),
  output: z.object({
    session: z.string().min(1),
    to: Address,
    source: z.literal("explicit"),
    /** True when the belonging was already written and nothing new was said. */
    known: z.boolean(),
  }),
});

export const sessionRead = actionRef("session.read", {
  description: "Reads the transcript of a session through the harness's reading side. The transcript is never written into niwa's journal.",
  /** The session to read, and what to read of it: see `history.read`, which takes the same. */
  input: readInput(SessionRefInput),
  output: ReadAnswerSchema,
});

export const sessionSearch = actionRef("session.search", {
  description: "Searches the transcript of a session through the harness's reading side: the records that hold every word of the query, case aside, each with its index and a short snippet. The index is the one session records are counted by from the start, as agent.fetch-from-old fetches them.",
  input: SearchQuerySchema.extend({
    /** The session to search. */
    session: SessionRefInput,
  }),
  output: z.object({
    /** The records that matched, in the harness's order. */
    matches: z.array(SearchMatchSchema),
    /** True when there are more matches after these. */
    more: z.boolean(),
    /** How much of the session was actually read: a failed read is not "no matches". */
    coverage: CoverageSchema,
  }),
});

export const sessionRunning = actionRef("session.running", {
  description:
    "What is running now, one line each: the sessions niwa runs, the latest first. A session whose state cannot be known is reported as unknown, never as idle. With all, the sessions found on the machine that niwa does not run are listed too.",
  input: z.object({
    /** Only sessions of this harness. */
    harness: z.string().min(1).optional(),
    /** At most this many lines of each list. Default: 20. */
    limit: z.number().int().positive().optional(),
    /** Add the sessions found on the machine that niwa does not run: their state cannot be known. */
    all: z.boolean().optional(),
  }),
  output: z.object({
    /** `<session>  <last activity>  <model>  <title>`. */
    running: z.array(z.string()),
    /** The sessions whose state cannot be known right now, in the same form. */
    unknown: z.array(z.string()),
    /** How many sessions were left out of the two lists by the limit. */
    omitted: z.number().int().nonnegative(),
    unreadable: z.array(UnreadableSchema),
  }),
});

/**
 * A harness instance as the sessions module binds it: its name (the id its author gave), its kind, the model it is
 * pinned to, what its sides can do, and the options block a start of it takes. An instance is named by its author, so
 * it is listed and got by that name, as a direction is. Several instances may be of one kind.
 */
const HarnessItem = z.object({
  name: HarnessIdSchema,
  kind: HarnessKindSchema,
  /** The model each session of it runs unless the start names another; absent, the harness's own. */
  model: z.string().min(1).optional(),
  /** What each of its sides can do: within what its kind declares, narrowed by what was found on the machine. */
  capabilities: HarnessSidesSchema,
  /** The block a start of this harness may carry; absent, it takes none. */
  block: OptionsBlockNameSchema.optional(),
  /** The schema of the options block used by workflow sessions and `session.start`. */
  options: JsonSchemaValue.optional(),
});

export const harnessList = actionRef("harness.list", {
  description:
    "List the harnesses sessions are started on: the name, the kind, the model it is pinned to, what its sides can do, and the options block of each (`claude` for Claude Code) with its JSON Schema. One kind may have several. Take a name from here to start a session on it, or to get one.",
  input: z.object({}),
  output: z.object({ items: z.array(HarnessItem) }),
});

export const harnessGet = actionRef("harness.get", {
  description:
    "Get one harness by its name: its kind, its machine, the model it is pinned to, what its sides can do, the options block a start of it takes and the JSON Schema of that block. A harness with no block takes no options; the block of another kind is refused by session.start.",
  input: z.object({ name: HarnessIdSchema }),
  output: HarnessItem.extend({
    machine: MachineIdSchema,
  }),
});

const TurnOperation = z.string().min(1);
const TurnNumber = z.number().int().positive();
const TurnTimeout = z.number().int().nonnegative().max(2_147_483_647).optional();

export const SessionTurnHandle = z.object({
  session: z.string().min(1),
  operation: TurnOperation,
  turn: TurnNumber.optional(),
});

/** The fields of `session.start`: every other key of its input is an options block. */
const SessionStartFields = z.object({
  /** The harness to start the session on. */
  harness: z.string().min(1),
  /** The prompt: plain text becomes one volatile section. */
  prompt: PromptInputSchema,
  /** The model the session runs, for its whole life; the instance's own when absent. */
  model: z.string().min(1).optional(),
  /** The effort the session thinks with, for its whole life; the kind says which levels it takes. */
  effort: z.string().min(1).optional(),
  /** The working mode of the session, for its whole life; the instance's own, else `auto`, when absent. */
  mode: SessionModeSchema.optional(),
  cwd: z.string().min(1).optional(),
  /**
   * Run the session in a new git worktree (the git module's `git.worktree.create`): `true`, or the repository,
   * the base and the description. The repository is `cwd` by default, else the host's directory; the session's
   * cwd is the worktree. It stays until it is removed.
   */
  worktree: WorktreeOption.optional(),
  /** Which niwa actions the session sees, and which harness tools are off. */
  visible: VisibleActionsInputSchema.optional(),
  /**
   * What the session's box has besides the host's default (`allow`) or instead of it (`only`):
   * `"project"` (the working directory, writable), `"toolchains"`, a profile by its name, or a path
   * (`{ read }`, `{ write }`) or a host (`{ net }`). The profile of the installation is always in it.
   * Wider than the host's default takes the caller's `box.*` rules.
   */
  box: BoxAccessSchema.optional(),
  /**
   * The tools the session may use, for its whole life: `all` (the harness's own, the default),
   * `niwa-only` (only the tools of niwa's MCP servers), or `{ allow }` (exactly these of the
   * harness's own). A harness that cannot hold a session to it refuses the start.
   */
  tools: ToolsModeSchema.optional(),
  /**
   * The caller's own id of this start: the prompt is recorded as an input under it with what became of it, and a
   * retry with it answers the session it made instead of making another. Default: the operation of the call.
   */
  operation: z.string().min(1).max(200).optional(),
  /**
   * Ask for JSON matching this schema, and validate the first turn's answer when it is read. A
   * prompt with no text starts no turn and so has no answer to validate: a start given both is
   * refused.
   */
  schema: JsonSchemaValue.optional(),
  /** How long, in milliseconds, a turn of the session may go with no progress before it counts as stuck; kept in its record. */
  stuckAfter: z.number().int().positive().optional(),
});

/** The names of the fields of `session.start`, so the rest of an input is known as its blocks. */
export const SESSION_START_FIELDS: readonly string[] = Object.keys(SessionStartFields.shape);

export const sessionStart = actionRef("session.start", {
  description:
    "Starts a session. With `worktree` it runs in a new git worktree of the repository (`cwd` by default), which stays until it is removed. It returns as soon as the harness has named the session; until then there is a start in progress, not a session. The prompt becomes the first turn, delivered like a send: the receipt says whether it started or was queued, and the end of that turn is not waited for — the handle it answers is the one session.turn-wait takes, so two calls cover a whole question and its answer. Give `operation` to make a retry safe: the same id with the same prompt answers the session it made. The block named after the harness's kind (`claude` for Claude Code) holds the options of that kind for the whole life of the session; the block of another kind is refused.",
  // Every key that is not a field is the options block of the harness's kind, an object named after it: what
  // is in it is the kind's schema to check, so it is checked once the harness is known.
  input: withBlocks(SessionStartFields),
  target: (input) => input.harness,
  output: z.object({
    /** The id niwa gave the session: what every session action takes. */
    session: NiwaSessionIdSchema,
    /** The worktree the session runs in, when it was started in one. */
    worktree: SessionWorktree.optional(),
    /** The harness and the id it gave the session, `<harness> <native>`. */
    ref: z.string().min(1),
    /** What became of the prompt: the first turn started or queued. Absent when there was none. */
    receipt: DeliveryReceiptSchema.optional(),
    /** The handle of the first turn, for session.turn-wait: the prompt is its tracked turn. Absent when the prompt started no turn. */
    handle: SessionTurnHandle.optional(),
    /** The operation the prompt is recorded under: the one given, or the call's own. */
    operation: z.string().min(1),
  }),
});

export const sessionResume = actionRef("session.resume", {
  description: "Resumes a session.",
  input: z.object({
    session: SessionRefInput,
    prompt: PromptInputSchema.optional(),
    /** Which niwa actions the session sees, and which harness tools are off. */
    visible: VisibleActionsInputSchema.optional(),
  }),
  output: z.object({ resumed: z.boolean() }),
});

const TurnSendInput = z.object({
  session: SessionRefInput,
  message: z.string(),
  into: z.literal("turn").optional(),
  /** The caller's own id of this send: a retry with it never sends the message twice. */
  operation: TurnOperation.max(200).optional(),
  /** Ask for JSON matching this schema, and validate the answer when it is read. */
  schema: JsonSchemaValue.optional(),
});

export const sessionSend = actionRef("session.send", {
  description:
    "Sends a message into a session and says what happened to it: delivered into the running turn, queued after the current turn, or started a new turn. A send that fails says whether the message was not sent (sending it again is safe) or may have been (it is never sent again by itself). Give `operation` to make a retry safe: the same id with the same message answers what became of it, and sends it only if it was not sent. Use track (or a schema) to get a handle for session.turn-wait.",
  input: TurnSendInput.extend({
    /** Keep this turn's final answer so it can be waited for later. */
    track: z.boolean().optional(),
  }),
  output: z.object({ receipt: DeliveryReceiptSchema, handle: SessionTurnHandle.optional() }),
});

export const sessionTurnSend = actionRef("session.turn-send", {
  description: "Send a message and return a durable handle for session.turn-wait.",
  input: TurnSendInput,
  output: z.object({ receipt: DeliveryReceiptSchema, handle: SessionTurnHandle }),
});

/**
 * How a tracked turn settled, with the exact semantics of `session.turn-wait`: its answer (parsed against the schema the
 * tracked send was given, when it had one), or the reason there is none. A group wait reports this per handle; a
 * handle it names as pending has not settled.
 */
export const TurnSettledResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: z.json() }),
  z.object({ status: z.literal("handled") }),
  z.object({ status: z.literal("ended"), how: TurnEnding.exclude(["completed"]), diagnostic: z.string().optional() }),
  z.object({ status: z.literal("no-answer") }),
  z.object({ status: z.literal("invalid-answer") }),
]);

const TurnWaitResult = z.discriminatedUnion("status", [
  ...TurnSettledResult.options,
  z.object({ status: z.literal("timed-out") }),
]);

export const sessionTurnWait = actionRef("session.turn-wait", {
  description: "Wait for the exact turn named by a tracked session.send handle. A timeout leaves the turn running. Outside a workflow the default timeout is 30 seconds.",
  input: SessionTurnHandle.extend({ session: SessionRefInput, timeoutMs: TurnTimeout }),
  output: TurnWaitResult,
});

/** The most handles one group wait may hold: a wait is one answer, not a catalogue of the host. */
export const TURN_WAIT_MANY_MAX = 64;

export const sessionTurnWaitMany = actionRef("session.turn-wait-many", {
  description:
    "Wait for a group of tracked turns at once: until the first of them settles on any outcome (a failure settles it too), or until every one has. The answer names the entries that settled and the handles still pending, each by its index among the handles given and in their order, and whether the deadline ran out; one handle listed twice is answered twice, once per place. Nothing is sent, consumed or cancelled: a handle named pending, and one named done, can be waited for again. Every handle and the caller's right to it is checked before anything is reported, so one unknown handle refuses the whole call. A timeout is not an error: the turns keep running. Outside a workflow the default timeout is 30 seconds.",
  input: z.object({
    handles: z.array(SessionTurnHandle).min(1).max(TURN_WAIT_MANY_MAX),
    /** `first`: wake when any handle settles. `all`: wake when every handle has. */
    until: z.enum(["first", "all"]),
    timeoutMs: TurnTimeout,
  }),
  output: z.object({
    /** The handles that settled, in the order their handles were given, each with how its turn ended. */
    done: z.array(z.object({
      /** The index of the handle among the handles given. */
      index: z.number().int().nonnegative(),
      handle: SessionTurnHandle,
      result: TurnSettledResult,
    })),
    /** The handles still pending, in the order they were given. */
    pending: z.array(z.object({
      index: z.number().int().nonnegative(),
      handle: SessionTurnHandle,
    })),
    /** True when the deadline ran out before the wait was satisfied. */
    timedOut: z.boolean(),
  }),
});

export const sessionAskAndWait = actionRef("session.ask-and-wait", {
  description: "Send a tracked message and wait for its exact turn. Keep the returned handle to wait again after a timeout.",
  input: TurnSendInput.extend({ timeoutMs: TurnTimeout }),
  output: z.object({ handle: SessionTurnHandle, result: TurnWaitResult }),
});

export const sessionInterrupt = actionRef("session.interrupt", {
  description: "Interrupts the running turn of a session. It happens only on an explicit request, and only where the harness declares it can.",
  input: z.object({ session: SessionRefInput }),
  output: z.object({ interrupted: z.boolean() }),
});

export const sessionEnd = actionRef("session.end", {
  description:
    "Ends a session: a turn it runs is interrupted where the harness can, its process is let go where the harness holds one, and its end is written with the reason. A session that already ended is left as it is.",
  input: z.object({ session: SessionRefInput, reason: z.string().min(1) }),
  output: z.object({ ended: z.boolean() }),
});

export const sessionAsk = actionRef("session.ask", {
  description: "Asks a session and returns a value that passed a schema. A harness with structured output answers natively; for the others the session is given the question's id and calls `submit-answer`.",
  input: z.object({
    session: SessionRefInput,
    prompt: PromptInputSchema,
    /** The schema the answer must pass, as a JSON schema. */
    schema: JsonSchemaValue,
  }),
  output: z.object({ value: z.unknown() }),
});

/** One open question of a session: the request that waits, and the schema its answer must pass. */
export const OpenQuestionSchema = z.object({
  /** The id of the request: what `submit-answer` takes as `question`. */
  request: z.string().min(1),
  /** The schema of the answer, as JSON Schema. `{}` when nothing says what it must pass. */
  schema: JsonSchemaValue,
});

export const sessionOpenQuestions = actionRef("session.open-questions", {
  description: "Lists the open questions of the session that a niwa MCP server with this mark serves, each with the schema its answer must pass. An unknown mark has none.",
  input: z.object({
    /** The mark the niwa MCP server was given in NIWA_SESSION_MARK. */
    mark: z.string().min(1),
  }),
  output: z.object({ questions: z.array(OpenQuestionSchema) }),
});
