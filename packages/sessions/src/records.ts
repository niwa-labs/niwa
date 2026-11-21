/**
 * The records niwa writes about sessions.
 *
 * These are niwa's own records: what niwa knows about a session, said in niwa's own words. The
 * harness's own records are NOT copied here — the reading side reads those on demand.
 *
 * What is written is what only niwa can know: that a session was started, that a turn began and
 * ended, that there was activity, that the session ended, and whom it serves.
 */

import { z } from "zod";

import { actionName, record, stableJson, Address } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";
import {
  DeliveryReceiptSchema,
  InputOutcomeSchema,
  ModelNameSchema,
  OptionBlocksSchema,
  PermissionMarkSchema,
  ProtocolNameSchema,
  SessionModeSchema,
  ToolsModeSchema,
  VariantNameSchema,
} from "@niwa-labs/harness";
import { BoxAccessSchema, BoxManifestSchema } from "@niwa-labs/sandbox";

import { NiwaSessionIdSchema, SessionRefSchema } from "./identity.ts";
import type { DeliveryReceipt } from "@niwa-labs/harness";

// What became of a message sent into a session: the harness defines it, and the modules that
// speak to sessions read it from here.
export { DeliveryReceiptSchema };
export type { DeliveryReceipt };

/** The name of the action that sends a message into a session. */
export const SESSION_SEND: ActionName = actionName("session.send");

/** What a module asks of the sessions module to send a message into a session. */
export interface SessionSendInput {
  /** The session, as the sessions module names it. */
  session: string;
  /** The text of the message. */
  message: string;
}

/** What the sessions module answers. */
export interface SessionSendOutput {
  /** What became of the message. */
  receipt: DeliveryReceipt;
}

/**
 * A session was started.
 *
 * The session is named here: niwa writes the record only once the harness has given the session
 * its id. A start that has not produced an id yet has no record.
 */
export const SessionStarted = record(
  "session.started",
  z.object({
    /** The session that was started: the harness and the id it gave. */
    session: SessionRefSchema,
    /** The id niwa gave it, issued from the starting call. */
    id: NiwaSessionIdSchema,
    /** The working directory it was started in, when it was given one. */
    cwd: z.string().optional(),
    /** The effort it was asked to start with, when one was chosen. */
    effort: z.string().optional(),
    /** The working mode the session was given: the one asked for, or the instance's, or the default. */
    mode: SessionModeSchema.optional(),
    /** The options block of its kind the session was started with, so a resume starts it again with them; absent when it had none. */
    options: OptionBlocksSchema.optional(),
    /** The tools the session was started with, so a resume launches it with the same; absent for the harness's own. */
    tools: ToolsModeSchema.optional(),
    /** What the start asked of its box, so a resume launches it in the same; absent when it asked nothing. */
    box: BoxAccessSchema.optional(),
    /** How long, in milliseconds, a turn may go with no progress before the session counts as stuck; absent when none was set. */
    stuckAfter: z.number().int().positive().optional(),
  }),
);

/**
 * The harness named the model the session runs.
 *
 * A session has one model: the one the harness says, not the alias it was asked for. The start
 * cannot know it, as most harnesses name it only after the start, so it is a record of its own,
 * written when the harness names it. Until then the model of the session is unknown. A resume
 * starts the session with the latest one.
 */
export const SessionModel = record(
  "session.model",
  z.object({
    /** The session that runs the model. */
    session: SessionRefSchema,
    /** The model, as the harness named it. */
    model: ModelNameSchema,
  }),
);

/** A turn began: the session is working. */
export const SessionTurnStarted = record(
  "session.turn-started",
  z.object({
    /** The session the turn belongs to. */
    session: SessionRefSchema,
    /** The number of the turn. */
    turn: z.number().int().positive(),
  }),
);

/**
 * How a turn ended: `interrupted` when niwa interrupted it on request; otherwise what the harness
 * said of it, `completed`, `failed` or `unknown` (nobody knows what became of it).
 */
export const TurnEnding = z.enum(["completed", "interrupted", "failed", "unknown"]);
export type TurnEnding = z.infer<typeof TurnEnding>;

/** A turn ended: the session is not working on that turn any more. */
export const SessionTurnEnded = record(
  "session.turn-ended",
  z.object({
    /** The session the turn belongs to. */
    session: SessionRefSchema,
    /** The number of the turn. */
    turn: z.number().int().positive(),
    /**
     * How it ended: `interrupted` when niwa interrupted it on request, otherwise what the harness
     * said of the turn, and `completed` when it said nothing. A record written before niwa said
     * how has none: it reads as completed.
     */
    how: TurnEnding.optional(),
  }),
);

/** The name of a tool: a short identifier, which cannot carry free text. */
export const ActivityToolSchema = z.string().regex(/^[A-Za-z0-9_.:\-]{1,64}$/);

/**
 * Something happened in the session: a sign of life. Only that it happened, never what, except for
 * the name of the tool it is a call of (a bounded identifier, never free text) and a decision the
 * harness made on a tool call by itself (without its free-text reason): the latest of each in a
 * throttle window is kept as it was said.
 */
export const SessionActivity = record(
  "session.activity",
  z.object({
    /** The session the activity belongs to. */
    session: SessionRefSchema,
    /** The decision the harness made on a tool call without asking, when the activity is one. */
    permission: PermissionMarkSchema.optional(),
    /** The tool the latest call of the window was of. */
    tool: ActivityToolSchema.optional(),
  }),
);

/**
 * Claude Code's advisor (a stronger model it asks for a review) was called, or answered: the kind
 * of the answer, never its text.
 */
export const SessionAdvisor = record(
  "session.advisor",
  z.object({
    session: SessionRefSchema,
    phase: z.enum(["started", "finished"]),
    /** The harness's id of the advisor's call, so the answer is paired with it. */
    callId: z.string().min(1),
    model: z.string().optional(),
    result: z.enum(["text", "redacted", "error"]).optional(),
    errorCode: z.string().optional(),
  }),
);

/**
 * The harness said something niwa does not know: a variant of its wire protocol that this build
 * of niwa was not made for, because the harness got newer. The session goes on; the message is
 * kept as it arrived, so that it can be read and the build taught.
 */
export const SessionUnknownVariant = record(
  "session.unknown-variant",
  z.object({
    /** The session the message came in. */
    session: SessionRefSchema,
    /** The wire protocol. */
    protocol: ProtocolNameSchema,
    /** The value of the message's discriminator that is not known. */
    variant: VariantNameSchema,
    /** The message as it arrived, or its beginning when it is long. */
    raw: z.json(),
  }),
);

/**
 * The harness compacted the session by itself.
 *
 * The summary is the harness's own and niwa does not rewrite it. It is kept because it is the
 * seed of the next session, and the best seed there is: the harness wrote it, knowing what it
 * was dropping.
 */
export const SessionCompacted = record(
  "session.compacted",
  z.object({
    /** The session that was compacted. */
    session: SessionRefSchema,
    /** The harness's own summary. */
    summary: z.string(),
  }),
);

/** The session ended: it will not work again. */
export const SessionEnded = record(
  "session.ended",
  z.object({
    /** The session that ended. */
    session: SessionRefSchema,
    /** Why it ended, when there is a reason to give. */
    reason: z.string().optional(),
  }),
);

/**
 * Where an attachment came from.
 *
 * - `explicit` — a person or a plugin chose it;
 * - `insert` — the insert inside the harness reported it;
 * - `directory` — it was read from the working directory the session runs in;
 * - `judgement` — it was inferred.
 */
export const BelongingSource = z.enum(["explicit", "insert", "directory", "judgement"]);
export type BelongingSource = z.infer<typeof BelongingSource>;

/**
 * Whom a session serves.
 *
 * A session has no relation fields of its own: where it came from is its cause. Whom it serves —
 * an agent, a task — is a separate record of belonging, written with its source.
 */
export const SessionBelongs = record(
  "session.belongs",
  z.object({
    /** The session that serves this address. */
    session: SessionRefSchema,
    /**
     * Whom the session serves.
     *
     * An address is a tagged value, never a bare string: the kind says what it is, so a reader
     * does not have to guess.
     */
    to: Address,
    /** Where the attachment came from. */
    source: BelongingSource,
  }),
);

/**
 * Do two addresses name the same thing?
 *
 * The comparison is on the value: two addresses that say the same are the same address, however
 * their keys were written.
 */
export function sameAddress(one: Address, other: Address): boolean {
  return stableJson(one) === stableJson(other);
}

/**
 * The niwa MCP server a session was given carries this mark, and the mark names the session.
 *
 * The server is started by the harness, not by niwa, so it cannot know which session it serves;
 * it is given a random mark in its environment (`NIWA_SESSION_MARK`) and asks niwa by the mark.
 * The pairing is written once the harness has named the session: start and resume each write
 * their own mark.
 */
export const SessionMarked = record(
  "session.marked",
  z.object({
    /** The session the server serves. */
    session: SessionRefSchema,
    /** The mark the server was given. */
    mark: z.string().min(1),
  }),
);

/**
 * The box a session's process is about to be started in, kept before the process exists: the
 * request with where each item came from, the paths it resolved to and where each came from, what
 * was closed and left out, the rules of the caller's grant it took, and the policy the sandbox
 * reports it applies. The mark is the one the session was started with, and `session.marked`
 * pairs it with the session once the harness has named it. The environment of the process is kept
 * by its names only: its values hold the session's token and the keys a harness is given for its
 * provider, and the journal keeps neither.
 */
export const SessionBoxManifest = record(
  "session.box.manifest",
  BoxManifestSchema.extend({
    /** The mark of the session whose process this is. */
    mark: z.string().min(1),
    /** The harness instance that starts the process. */
    harness: z.string().min(1),
  }),
);

/**
 * An input given an operation id by its caller is about to be sent into a session: written before
 * the send, so a host that stops in the middle of it knows the input may have gone.
 */
export const SessionInputSending = record(
  "session.input.sending",
  z.object({
    session: SessionRefSchema,
    /** The id the caller gave the operation: a retry with it is answered from these records. */
    operation: z.string().min(1),
    /** The SHA-256 of the input, so a retry with another body under the same id is told apart. */
    digest: z.string().min(1),
  }),
);

/** What became of an input that was given an operation id: accepted, never sent, or possibly sent. */
export const SessionInputSettled = record(
  "session.input.settled",
  z.object({
    session: SessionRefSchema,
    operation: z.string().min(1),
    outcome: InputOutcomeSchema,
  }),
);

/**
 * A start given an operation id is about to ask its harness for a session: written before anything is
 * sent, so a retry while it runs, or after a host stopped in the middle of it, never starts a second one.
 */
export const SessionStartReserved = record(
  "session.start.reserved",
  z.object({
    operation: z.string().min(1),
    /** The SHA-256 of the start's harness and prompt, so a retry with another body is told apart. */
    digest: z.string().min(1),
    /** The directory the session is started in, when it was given one. */
    cwd: z.string().optional(),
  }),
);

/** The harness named the session of a start under an operation, before its first prompt went. */
export const SessionStartNamed = record(
  "session.start.named",
  z.object({
    operation: z.string().min(1),
    session: SessionRefSchema,
  }),
);

/** A start under an operation failed before anything reached its harness: a retry starts again. */
export const SessionStartUnsent = record(
  "session.start.unsent",
  z.object({
    operation: z.string().min(1),
    reason: z.string(),
  }),
);

/** The record types this module declares, in the order they are declared. */
export const SESSION_TYPES = [
  SessionStarted,
  SessionModel,
  SessionTurnStarted,
  SessionTurnEnded,
  SessionActivity,
  SessionAdvisor,
  SessionUnknownVariant,
  SessionCompacted,
  SessionEnded,
  SessionBelongs,
  SessionMarked,
  SessionBoxManifest,
  SessionInputSending,
  SessionInputSettled,
  SessionStartReserved,
  SessionStartNamed,
  SessionStartUnsent,
] as const;
