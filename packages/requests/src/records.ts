/**
 * The records of the requests module: a request was created, and
 * then it was answered, cancelled or expired. An open request is one with none of the three, so
 * nothing is written for "still open".
 */

import { z } from "zod";

import { AnswerSchema, QuestionSchema, idSchema, record, recordId, Address } from "@niwa-labs/core";
import type { Id, RecordId, Timestamp } from "@niwa-labs/core";

/** The id of a request, `req-3fa9c2`: niwa issues it, and the answer is bound to it. */
export const RequestId = idSchema("request");
export type RequestId = Id<"request">;

/** The name of a question: a key in the journal, not a sentence. */
export const QuestionName = z
  .string()
  .regex(/^\S+$/, "a question name is not empty and has no whitespace")
  .brand<"QuestionName">();
export type QuestionName = z.infer<typeof QuestionName>;

/** The moment a request stops waiting, in milliseconds since the epoch. */
export const Deadline = z.custom<Timestamp>(
  (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
  { message: "a deadline is a moment in milliseconds since the epoch" },
);

/**
 * A request was created. The question is written whole, so a request is drawn and answered without
 * the code that asked it; its name is the key resolvers and decisions know it by.
 */
export const RequestCreated = record(
  "request.created",
  z.object({
    id: RequestId,
    /** The one who may answer it. */
    to: Address,
    question: QuestionName,
    /** What was asked: the question, whole. */
    input: QuestionSchema,
    /** Who asked, when the caller is bound to an address. */
    from: Address.optional(),
    /** When the request stops waiting. A request without one waits for ever. */
    deadline: Deadline.optional(),
  }),
);

/** A request was answered, by the address the caller is bound to. */
export const RequestAnswered = record(
  "request.answered",
  z.object({
    id: RequestId,
    answer: AnswerSchema,
    by: Address.optional(),
    /**
     * How a resolver found the answer, when a resolver gave it.
     *
     * It is kept apart from the answer: the answer is what the asker parses against the schema
     * of its question, and the way it was found is about the resolver, not about the answer.
     */
    how: z.string().min(1).optional(),
    /** The area the answer was found for. */
    area: z.string().min(1).optional(),
    /** What the answer came from: the id of a decision, or of a record. */
    source: z.string().min(1).optional(),
  }),
);

/** A request was cancelled: nobody chose to be answered any more. */
export const RequestCancelledRecord = record(
  "request.cancelled",
  z.object({
    id: RequestId,
    reason: z.string().optional(),
    by: Address.optional(),
  }),
);

/** A request expired: the time ran out, nobody chose anything. */
export const RequestExpiredRecord = record(
  "request.expired",
  z.object({
    id: RequestId,
    reason: z.string().optional(),
  }),
);

/**
 * The id of the expiry of one request: `expired:${request}`.
 *
 * It is a function of the request alone, so the expiry written twice — a timer that ticked
 * twice, a host that started again after the deadline — is the same record and not a second
 * fact.
 */
export function expiryId(request: RequestId): RecordId {
  return recordId(`expired:${request}`);
}

/** The record types this module declares. */
export const REQUEST_TYPES = [
  RequestCreated,
  RequestAnswered,
  RequestCancelledRecord,
  RequestExpiredRecord,
] as const;
