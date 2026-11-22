/**
 * The actions of the requests module, as typed references: name, description and the two schemas.
 *
 * A caller imports these to call a request action with input and output checked by the type
 * checker, on the host and on a client. The module's factory builds its real actions from the same
 * references (`action(requestOpen, { recovery, run })`).
 */

import { z } from "zod";

import { AnswerSchema, EntityDescription, IdText, QuestionSchema, actionName, actionRef, getRef, listRef, Address } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";

import { Deadline, QuestionName, RequestId } from "./records.ts";

/** The input of the action that asks. */
export const AskInput = z.object({
  /** Who may answer. */
  to: Address,
  /** An operator decision bypasses all automatic resolvers. */
  answerPolicy: z.literal("owner-only").optional(),
  /** The name of the question. */
  question: QuestionName,
  /** What is asked: the question, whole. */
  input: QuestionSchema,
  /** When the request stops waiting. Without one it waits for ever. */
  deadline: Deadline.optional(),
  /**
   * Who asks, for a handler that stands for an address of its own: it may then cancel its request
   * as that address. A client is held to the address it is bound to: the payload does not change that.
   */
  from: Address.optional(),
  /**
   * For a caller in this process: the zod schema of the value of a form. While the ask waits it
   * checks the value whole, refinements included; it is never written.
   */
  check: z.custom<z.ZodType<unknown>>((value) => value instanceof z.core.$ZodType).optional(),
});

/**
 * Which request a command names: its id, a unique prefix or suffix of it (`label:ship`), or the run
 * whose one open ask it is.
 */
const Named = {
  id: IdText.optional(),
  run: z.string().min(1).brand<"RunRef">().optional(),
};
const oneNamed = (input: { id?: string | undefined; run?: string | undefined }): boolean => (input.id === undefined) !== (input.run === undefined);
const NAMED = "give the request (id, or a unique start or end of it), or the run whose one open ask it is";

export const AnswerInput = z.object({ ...Named, answer: AnswerSchema }).refine(oneNamed, NAMED);
export const CancelInput = z.object({
  ...Named,
  reason: z.string().optional(),
  /**
   * Who cancels, for a handler that stands for an address of its own. A client is held to the
   * address it is bound to, as it is for a message: the payload does not change that.
   */
  by: Address.optional(),
}).refine(oneNamed, NAMED);
export const OpenInput = z.object({ to: Address.optional() });

/**
 * What answering a request answers.
 *
 * An answer is accepted when it stands: it was written, or the same answer already stands.
 * An answer to a request that was cancelled or expired is not accepted, and says why.
 */
export const AnswerOutput = z.object({
  id: RequestId,
  /** Whether the answer stands. */
  accepted: z.boolean(),
  /** Why the answer does not stand: the request was over before it came. */
  reason: z.enum(["cancelled", "expired"]).optional(),
});

export const OpenRequest = z.object({
  answerPolicy: z.literal("owner-only").optional(),
  id: RequestId,
  to: Address,
  question: z.string().min(1),
  input: QuestionSchema,
  from: Address.optional(),
  deadline: z.number().optional(),
});

/** A paused invocation is a request with typed choices, listed with the questions. */
export const OpenPaused = z.object({
  kind: z.literal("paused"),
  invocation: z.string().min(1),
  choices: z.array(z.string()),
  key: z.string().optional(),
  reason: z.string().optional(),
});

export const OpenOutput = z.object({ requests: z.array(z.union([OpenRequest, OpenPaused])) });

/** What asking returns once the request is answered: the answer, with the id of the request, so a caller can find it again. */
export const AskAnswered = z.object({ id: RequestId, answer: AnswerSchema });

/** What asking returns outside a step: the request is made and still open; the caller reads or waits for the answer by its id. */
export const AskOpen = z.object({ id: RequestId, status: z.literal("open") });

/** What asking returns: the answer inside a step, the open request outside one. */
export const AskOutput = z.union([AskAnswered, AskOpen]);

/** The answer of an ask a step made: a step waits, so what it gets is always the answer. */
export function answeredBy(output: z.infer<typeof AskOutput>): z.infer<typeof AskAnswered> {
  if (!("answer" in output)) throw new Error(`the request "${output.id}" is still open`);
  return output;
}

export const requestAsk = actionRef("request.ask", {
  description:
    "Ask a question. As a step of a workflow or of a handler it waits for the answer (the wait survives a restart) and returns the answer with the id of the request. Called directly, from the CLI or MCP, it cannot wait: it creates the request and returns at once {id, status: \"open\"}; poll request.get with that id until its status is no longer open, and read the answer there.",
  input: AskInput,
  output: AskOutput,
});

export const requestAnswer = actionRef("request.answer", {
  description: "Answer a request. Only the addressee may; the first answer stands.",
  input: AnswerInput,
  output: AnswerOutput,
});

export const requestCancel = actionRef("request.cancel", {
  description: "Cancel an open request. Only its asker or addressee may.",
  input: CancelInput,
  output: z.object({ id: RequestId }),
});

export const requestOpen = actionRef("request.open", {
  description: "List what waits: the open requests and the invocations paused for a decision.",
  input: OpenInput,
  output: OpenOutput,
});

/** How a request stands: waiting, or how it ended. */
export const RequestStatus = z.enum(["open", "answered", "cancelled", "expired"]);

/** The fields of a request that a list and a read both show. */
const GLANCE = {
  answerPolicy: z.literal("owner-only").optional(),
  status: RequestStatus,
  question: QuestionName,
  to: Address,
  from: Address.optional(),
  deadline: Deadline.optional(),
};

export const requestList = listRef("request.list", {
  kind: "request",
  noun: "request",
  detail: "Open and ended ones, oldest first; the filters narrow by how it stands, who may answer it, who asked and the name of the question.",
  filter: { status: RequestStatus.optional(), to: Address.optional(), from: Address.optional(), question: QuestionName.optional() },
  item: GLANCE,
});

/** One request, whole. */
export const RequestEntity = z.object({
  id: RequestId,
  description: EntityDescription,
  ...GLANCE,
  /** What was asked: the question, whole. */
  input: QuestionSchema,
  /** The answer, once there is one. */
  answer: AnswerSchema.optional(),
  /** Who answered or cancelled it, when the caller was bound to an address. */
  by: Address.optional(),
});

export const requestGet = getRef("request.get", {
  kind: "request",
  noun: "request",
  detail: "It carries the question, whole, and the answer once there is one.",
  entity: RequestEntity,
});

export const requestFind = actionRef("request.find", {
  description:
    "Find the request that a record caused: the one a handler woken by that record asked, by the name of its question. How a handler finds its own request again: a caller does not choose the id of one.",
  input: z.object({
    /** The id of the record that caused the request. */
    cause: z.string().min(1),
    /** The name of the question the request asked. */
    question: QuestionName,
  }),
  output: z.object({ id: RequestId.optional() }),
});

/** How an answer given to a resolve was found. */
export const ResolveInfo = z.object({
  how: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
});

export const requestResolve = actionRef("request.resolve", {
  description: "Let the resolvers answer a request before it reaches its addressee. An answer given here is the answer: the resolvers are not asked.",
  input: z.object({
    id: RequestId,
    answer: AnswerSchema.optional(),
    /** How the answer given here was found, kept apart from the answer. */
    info: ResolveInfo.optional(),
  }),
  output: z.object({ answered: z.boolean() }),
});

export const REQUEST_ASK: ActionName = actionName("request.ask");
export const REQUEST_ANSWER: ActionName = actionName("request.answer");
export const REQUEST_CANCEL: ActionName = actionName("request.cancel");
export const REQUEST_OPEN: ActionName = actionName("request.open");
export const REQUEST_LIST: ActionName = actionName("request.list");
export const REQUEST_GET: ActionName = actionName("request.get");
export const REQUEST_RESOLVE: ActionName = actionName("request.resolve");
export const REQUEST_FIND: ActionName = actionName("request.find");
