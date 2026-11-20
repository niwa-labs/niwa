/**
 * Observation as actions: the ways to read what happened, declared by the core itself.
 *
 * Reading the journal is something the system does, so it is declared as an action like any
 * other. The surfaces generate their tools and their commands from the list of actions, so an
 * observation action is a tool and a command with no change to either surface — and a surface
 * that kept a list of reading tools of its own would be a second source for the same thing.
 *
 * The actions read and write nothing: they answer with what is committed now.
 */

import { z } from "zod";

import { actionName, JsonSchemaValue, RecordFilterInput } from "@niwa-labs/core";
import { descriptionSchema, storedRecordSchema, tracedRecordSchema } from "./wire.ts";
import type { ActionName } from "@niwa-labs/core";

/** The action that reads the records of the journal. */
export const RECORDS_READ_ACTION: ActionName = actionName("niwa.records.read");

/** The action that walks down from a record: what grew from it. */
export const TRACE_ACTION: ActionName = actionName("niwa.trace");

/** The action that walks up from a record: what it depends on. */
export const CAUSES_ACTION: ActionName = actionName("niwa.causes");

/** The action that says what niwa is: its actions and its record types. */
export const DESCRIBE_ACTION: ActionName = actionName("niwa.describe");

/** The action that says whether the host is up and what it holds. */
export const STATUS_ACTION: ActionName = actionName("niwa.host.status");

/** The action that stops the host. */
export const STOP_ACTION: ActionName = actionName("niwa.host.stop");

/** What the host answers about itself: its process, its home, its journal and what each plugin holds. */
export const StatusOutput = z.object({
  pid: z.number().int(),
  home: z.string(),
  /** The position of the last record of the journal. */
  seq: z.number().int().nonnegative(),
  plugins: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      /** What the plugin counts: runs by state, open requests, live sessions. */
      summary: z.record(z.string(), z.number()).optional(),
    }),
  ),
});

/** What a read of the history asks for. */
export const RecordsReadInput = z.object({
  /** The position to read after; 0 is the start of the journal. */
  from: z.number().int().nonnegative().optional(),
  /** The record types to read; every type when absent. */
  types: z.array(z.string().min(1)).optional(),
  /** The stream to read; every stream when absent. */
  stream: z.string().min(1).optional(),
  /** At most this many records: the first ones. */
  limit: z.number().int().positive().optional(),
  /** The last this many records that match, not the first. */
  tail: z.number().int().positive().optional(),
  /** Narrow the read: type patterns, an actor, a subject, a text, a span of time or of positions. */
  filter: RecordFilterInput.optional(),
  /** When no record matches, wait up to this long, in milliseconds, for one to be committed. */
  waitMs: z.number().int().positive().optional(),
});

/** What a walk from a record asks for. */
export const RecordWalkInput = z.object({
  /** The id of the record to walk from. */
  id: z.string().min(1),
});

/**
 * A record as the actions carry it: the data may be absent.
 *
 * The wire's own schema cannot be rendered as JSON Schema — `default(undefined)` has no JSON
 * Schema form — and the schema of an action is rendered for the surfaces, so the data field is
 * optional here.
 */
const RecordOutput = storedRecordSchema.extend({ data: z.unknown().optional() });

/** A list of records, as a walk up from a record answers. */
export const RecordList = z.array(RecordOutput);

/** One record as an action answers with it: what a surface that only shows records reads. */
export type RecordAnswer = z.output<typeof RecordOutput>;

/** The records a read answers with, and the position to read after next time. */
export const RecordsOutput = z.object({
  records: RecordList,
  /** The position the read reached: the `from` of the next read, so none is missed and none read twice. */
  next: z.number().int().nonnegative(),
});

/** The records a trace answers with, each with the depth it was found at. */
export const TracedRecordsOutput = z.array(
  tracedRecordSchema.extend({ data: z.unknown().optional() }),
);

/** One record of a trace as an action answers with it. */
export type TracedRecordAnswer = z.output<typeof TracedRecordsOutput>[number];

/**
 * What the description answers with.
 *
 * The wire's own description schema cannot be rendered as JSON Schema — the schemas inside it
 * are plain values, and a plain value has no JSON Schema form — so the action carries its own
 * shape, and the description the action answers with is the same one the wire carries.
 */
export const DescriptionOutput = z.object({
  actions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      recovery: z.enum(["repeat", "repeat-with-key", "do-not-repeat"]),
      input: JsonSchemaValue,
      output: JsonSchemaValue,
    }),
  ),
  types: z.array(
    z.object({
      name: z.string(),
      version: z.number().int().positive(),
      schema: JsonSchemaValue,
    }),
  ),
});

/** The description as an action answers with it: what a surface that only shows it reads. */
export type DescriptionAnswer = z.output<typeof DescriptionOutput>;
