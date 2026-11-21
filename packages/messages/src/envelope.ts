/**
 * The envelope: a message, and what a message can carry.
 *
 * A message is an envelope sent to an address. It always says who sent it: `from` is not optional,
 * because a message whose sender is unknown cannot be reasoned about.
 *
 * The body is a discriminated union of six kinds: assignment, update, question, answer, result
 * and failure. The kind is the tag, so a reader knows what it holds without guessing.
 */

import { z } from "zod";

import { Address, JsonSchemaValue, JsonValueSchema, idSchema } from "@niwa-labs/core";
import type { Id } from "@niwa-labs/core";

/** The id of a message: `msg-3fa9c2`. Niwa issues it when the message is written; the sender never chooses it. */
export const MessageId = idSchema("message");
export type MessageId = Id<"message">;

/** The id of the task a message belongs to: the tasks module's own id, so a message needs no import of it. */
const TaskRef = idSchema("task");

/**
 * The shape the result of an assignment must have: a JSON Schema of an object.
 *
 * It is declared by whoever asked for the work and checked when the task is finished (tasks module);
 * a message only carries it, so the one who is to do the work sees it.
 */
export const ResultSchema = JsonSchemaValue;
export type ResultSchema = z.infer<typeof ResultSchema>;

/** The text a body carries. */
const Text = z.string().min(1);

/**
 * An assignment: work given to an address.
 *
 * What to do is free text on purpose: the kinds of work are an open label in the core, not a
 * closed list.
 */
export const Assignment = z.strictObject({
  type: z.literal("assignment"),
  /** What to do. */
  text: Text,
  /** An open label for the sort of work this is. */
  kind: z.string().optional(),
  /** The shape the result must have, when the sender declared one. */
  result: ResultSchema.optional(),
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** An update: what has happened so far. */
export const Update = z.strictObject({
  type: z.literal("update"),
  text: Text,
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** A question: something the receiver is asked. */
export const Question = z.strictObject({
  type: z.literal("question"),
  text: Text,
  /** The name of the question, when it has one. */
  question: z.string().optional(),
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** An answer: the answer to a question. */
export const Answer = z.strictObject({
  type: z.literal("answer"),
  text: Text,
  /** The question this answers, when it answers one. */
  question: z.string().optional(),
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** A result: the outcome of some work. */
export const Result = z.strictObject({
  type: z.literal("result"),
  text: Text,
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** A failure: the work did not succeed. */
export const Failure = z.strictObject({
  type: z.literal("failure"),
  text: Text,
  /** What went wrong, when it is worth saying separately from the text. */
  reason: z.string().optional(),
  /** Anything the sender wants to carry along. */
  data: JsonValueSchema.optional(),
});

/** The six kinds of body a message can carry. */
export const MessageBody = z.discriminatedUnion("type", [
  Assignment,
  Update,
  Question,
  Answer,
  Result,
  Failure,
]);

/** One body. */
export type MessageBody = z.infer<typeof MessageBody>;

/** The kind of a body: what a message carries. */
export type MessageBodyType = MessageBody["type"];

/**
 * A message: an envelope sent to an address.
 *
 * `from` is always present. `task` is the task the message belongs to, when there is one.
 */
export const Message = z.strictObject({
  id: MessageId,
  /** Who sent it. Always present. */
  from: Address,
  /** Who it is sent to. */
  to: Address,
  /** The task this message belongs to, when it belongs to one. */
  task: TaskRef.optional(),
  /** What the message carries. */
  body: MessageBody,
});

/** One message. */
export type Message = z.infer<typeof Message>;

/**
 * The input of the action that sends a message: the envelope without its id.
 *
 * The id is issued by niwa when the message is written, never by its caller: the message is one
 * fact, and the action that writes it is the one that names it.
 */
export const MessageInput = z.strictObject({
  /** Who sent it. Optional here: the caller binding may say who the sender is. */
  from: Address.optional(),
  /** Who it is sent to. */
  to: Address,
  /** The task this message belongs to, when it belongs to one. */
  task: TaskRef.optional(),
  /** What the message carries. */
  body: MessageBody,
});

/** The input of the action that sends a message. */
export type MessageInput = z.infer<typeof MessageInput>;
