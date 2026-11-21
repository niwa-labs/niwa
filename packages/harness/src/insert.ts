/**
 * The insert: a plugin inside the harness. It reports what cannot be seen from outside
 *. It speaks the events below, never niwa's journal.
 */

import { z } from "zod";

import { SessionIdSchema } from "./reading.ts";
import type { SessionId } from "./reading.ts";

/** The environment variable niwa sets in a session it starts, so the session is not taken for one opened by hand. */
export const NIWA_SESSION_ENV = "NIWA_SESSION";

/**
 * The environment variable that names the program that runs niwa's CLI, which an insert reports
 * through. Without it the insert runs `niwa` from the PATH.
 */
export const NIWA_CLI_ENV = "NIWA_CLI";

/**
 * The name of the action an insert reports through.
 *
 * An insert runs inside a harness and writes nothing of its own: it hands its event to
 * `niwa insert report`, which calls this action on the host.
 */
export const INSERT_REPORT_ACTION = "insert.report";

/** A nested session was spawned inside a session. */
export const NestedSpawnedEventSchema = z.object({
  kind: z.literal("nested-spawned"),
  /** The session the child was spawned in. */
  parent: SessionIdSchema,
  /** The child session. */
  child: SessionIdSchema,
  /** The harness's own name for what was spawned (a subagent, a task), when it says. */
  role: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
});

export type NestedSpawnedEvent = z.output<typeof NestedSpawnedEventSchema>;

/** The context was compacted. */
export const CompactedEventSchema = z.object({
  kind: z.literal("compacted"),
  /** The session that was compacted. */
  session: SessionIdSchema,
  /** The harness's own summary, when it is available at the moment of compaction. */
  summary: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
});

export type CompactedEvent = z.output<typeof CompactedEventSchema>;

/** The owner opened a session by hand. */
export const OpenedByHandEventSchema = z.object({
  kind: z.literal("opened-by-hand"),
  /** The session that was opened. */
  session: SessionIdSchema,
  /** The working directory it was opened in, when the harness says. */
  cwd: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
});

export type OpenedByHandEvent = z.output<typeof OpenedByHandEventSchema>;

/** A tool asks for permission. */
export const PermissionAskedEventSchema = z.object({
  kind: z.literal("permission-asked"),
  /** The session the tool runs in. */
  session: SessionIdSchema,
  /** The harness's own id of the pending question, so its answer can be matched to it. */
  requestId: z.string().min(1),
  /** The tool that asks. */
  tool: z.string().min(1),
  /** What the tool wants to do, in the harness's own words. */
  detail: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
});

export type PermissionAskedEvent = z.output<typeof PermissionAskedEventSchema>;

/** The harness ended a session: the owner left it, cleared it or moved to another. */
export const SessionEndedEventSchema = z.object({
  kind: z.literal("session-ended"),
  /** The session that ended. */
  session: SessionIdSchema,
  /** Why it ended, in the harness's own words, when it says. */
  reason: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
});

export type SessionEndedEvent = z.output<typeof SessionEndedEventSchema>;

/** What cannot be seen from outside. */
export const InsertEventSchema = z.discriminatedUnion("kind", [
  NestedSpawnedEventSchema,
  CompactedEventSchema,
  OpenedByHandEventSchema,
  PermissionAskedEventSchema,
  SessionEndedEventSchema,
]);

export type InsertEvent = z.output<typeof InsertEventSchema>;

/** The kind of an insert event, by name. */
export type InsertEventKind = InsertEvent["kind"];

/** The answer to a permission question. */
export const PermissionAnswerSchema = z.object({
  /** The question this answers. */
  requestId: z.string().min(1),
  /** Whether the tool may go on. */
  allow: z.boolean(),
  /** Why, when there is a reason to give. */
  reason: z.string().optional(),
});

export type PermissionAnswer = z.output<typeof PermissionAnswerSchema>;

/** What an insert is given when it is put into the harness it belongs to. */
export interface InsertInstallOptions {
  /** The home of the niwa host the plugin reports to. */
  readonly home: string;
  /**
   * The program that runs niwa's CLI, which the plugin reports through (`niwa insert report`).
   *
   * Default: the `NIWA_CLI` of the environment, else `niwa` from the PATH.
   */
  readonly cli?: string;
}

/**
 * The insert side of a harness.
 *
 * The insert is connected by the harness: it is a plugin inside the harness's own process, and
 * this interface is what niwa sees of it. It is no client of the host: it hands its events to
 * `niwa insert report` (`insert-report.ts`), the one command that calls the action.
 *
 * The kinds differ in how the insert works: one pulls its events out of the harness, the other is
 * put into the harness and reports what it saw. An insert declares the ways it works and the
 * abilities that go with them.
 */
export interface HarnessInsert {
  /**
   * The events, as they happen.
   *
   * A side that is put into the harness has none: it reports them itself, through the command
   * `niwa insert report`, which calls the action "insert.report".
   */
  events?(): AsyncIterable<InsertEvent>;

  /**
   * Puts the plugin into the harness, so it runs inside it.
   *
   * The side that is put in is installed; the side that pulls its events is already there.
   */
  install?(opts: InsertInstallOptions): Promise<void>;

  /**
   * Answers a permission question.
   *
   * The answer goes back to the harness that asked. An insert that cannot carry answers does not
   * declare the ability.
   */
  answerPermission?(answer: PermissionAnswer): Promise<void>;
}

/** The session an event is about; for a nested spawn, the child. */
export function eventSession(event: InsertEvent): SessionId {
  return event.kind === "nested-spawned" ? event.child : event.session;
}
