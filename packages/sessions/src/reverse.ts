/**
 * Reverse requests, routed.
 *
 * A harness adapter hands over a `Question` and the raw request of its harness, and gets an
 * answer back. This module decides where the answer comes from:
 *
 * 1. a permission the session's grant covers (a `tool:` rule that does not ask), or a tool of niwa's own MCP server
 *    (the server of a session that sees niwa actions: the grant is what shows its tools), is allowed;
 * 2. a permission the starter already answered "allow always" for, in this session, is allowed;
 * 3. everything else is a request to the one who started the session, through `request.ask`.
 *
 * Every question writes `session.reverse.asked` (the question, the raw request, which of the
 * three routes it took) and `session.reverse.answered` (the answer, and who gave it). niwa has no
 * deadline of its own: the request waits for the harness, which cancels it when it stops waiting.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AnswerSchema, isSuspend, isToolSubject, match, OptionIdSchema, optionOfFlavor, permissionKey, pickedOptions, QuestionSchema, record, seq, Address } from "@niwa-labs/core";
import type { Answer, Grant, Question, QuestionOption, Step } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import type { RequestId } from "@niwa-labs/requests/records";
import type { ReverseHandler } from "@niwa-labs/harness";
import { QuestionName, RequestCreated, answeredBy, requestAsk, requestCancel, requestFind } from "@niwa-labs/requests/records";

import { SessionRefSchema, sessionRef } from "./identity.ts";
import type { SessionRef } from "./identity.ts";
import { SessionEnded } from "./records.ts";

/** The id of one reverse request. */
export const ReverseIdSchema = z.string().min(1).brand<"ReverseId">();
export type ReverseId = z.output<typeof ReverseIdSchema>;

/** The name of the question the starter is asked. */
export const REVERSE_QUESTION = "session.reverse";
const QUESTION_NAME = QuestionName.parse(REVERSE_QUESTION);

/** The id of the option niwa adds to a permission, so that the starter may allow it for the rest of the session. */
const ALWAYS_OPTION_ID = OptionIdSchema.parse("niwa.allow_always");

/** Where an answer comes from. */
const ReverseRouteSchema = z.enum(["starter", "grant", "remembered"]);

/** What the harness asked, as it came. */
const RawRequestSchema = z.object({ method: z.string(), params: z.unknown() });

/** A harness asked its client for something: the question, and the harness's own request whole. */
export const SessionReverseAsked = record(
  "session.reverse.asked",
  z.object({
    id: ReverseIdSchema,
    session: SessionRefSchema,
    /** Who answers it: the starter, the session's own grant, or niwa's memory of an "allow always". */
    route: ReverseRouteSchema,
    /** The one who started the session, when it is the one asked. */
    starter: Address,
    /** The question as the starter sees it: a permission carries the option to allow it always. */
    question: QuestionSchema,
    raw: RawRequestSchema,
  }),
);

/** The question was answered, and by whom: the starter, a grant, or the memory of an "allow always"; or it ended with no answer. */
export const SessionReverseAnswered = record(
  "session.reverse.answered",
  z.object({
    id: ReverseIdSchema,
    session: SessionRefSchema,
    by: z.enum(["starter", "grant", "remembered", "cancelled"]),
    /** The answer the adapter was given. */
    answer: AnswerSchema,
    /** For the rest of the session, a permission of this key is allowed: set when the starter said "allow always". */
    always: z.string().optional(),
  }),
);

/** The harness stopped waiting for the answer. */
export const SessionReverseCancelled = record(
  "session.reverse.cancelled",
  z.object({
    id: ReverseIdSchema,
    session: SessionRefSchema,
    starter: Address,
  }),
);

/** The record types of reverse requests. */
export const REVERSE_TYPES = [SessionReverseAsked, SessionReverseAnswered, SessionReverseCancelled] as const;

/** A permission question with the option to allow it for the rest of the session, when it can be allowed at all. */
function withAlways(question: Question): Question {
  if (question.kind !== "permission" || optionOfFlavor(question, "allow_once") === undefined) return question;
  const always: QuestionOption = { id: ALWAYS_OPTION_ID, label: "Allow always (this session)", flavor: "allow_always" };
  const [first, ...rest] = question.options;
  return first === undefined ? question : { ...question, options: [first, ...rest, always] };
}

/**
 * The answer the adapter is given, and what niwa remembers, from what the starter answered.
 *
 * niwa never hands "allow always" to a harness: it answers the option that allows once, and
 * remembers the key.
 */
function settled(asked: Question, answer: Answer): { answer: Answer; always?: string } {
  if (asked.kind !== "permission" || !isToolSubject(asked.subject)) return { answer };
  const picked = pickedOptions(asked, answer)[0];
  const once = optionOfFlavor(asked, "allow_once");
  if (picked?.flavor !== "allow_always" || once === undefined) return { answer };
  return { answer: { ids: [once.id] }, always: permissionKey(asked.subject) };
}

/** Why a request ended with no answer, by the name of the error the requests module throws. */
function endedWithoutAnswer(error: unknown): boolean {
  return error instanceof Error && (error.name === "RequestCancelled" || error.name === "RequestExpired");
}

/** What the plugin gives a session's launch for its reverse requests. */
export interface ReverseRouting {
  /**
   * The handler a control side calls for the reverse requests of a session whose grant is `rules`, started by `starter`.
   * `ownToolPrefix` is what the harness's names of the tools of niwa's own MCP server start with, when the session was
   * given that server: those tools are allowed without asking.
   */
  handlerFor(rules: Grant, starter: Address, ownToolPrefix: string | undefined): ReverseHandler;
}

/** Install the handlers of reverse requests into the plugin. */
export function installReverse(api: PluginApi): ReverseRouting {
  /** The handlers of this process that wait for an answer, by request: a process that was restarted has none. */
  const waiting = new Map<ReverseId, (answer: Answer) => void>();

  /**
   * The request the starter was asked for a reverse question, when there is one: what the handler of
   * the question wrote while it ran on the record of the question. The requests module finds it.
   */
  const requestOf = async (step: Step, reverse: ReverseId, key: string): Promise<RequestId | undefined> => {
    const asked = api.journal?.()?.find({ type: SessionReverseAsked.name, field: "id", equals: reverse }).at(0);
    if (asked === undefined) return undefined;
    return (await step(requestFind, { cause: asked.id, question: REVERSE_QUESTION }, { key })).id;
  };

  /** Is a permission of this key allowed for the rest of the session? Only the answers since the last end of the session count. */
  const remembered = (session: SessionRef, key: string): boolean => {
    const journal = api.journal?.();
    if (journal === undefined) return false;
    const ended = journal.find({ type: SessionEnded.name, field: "session", equals: session }).at(-1)?.seq ?? seq(0);
    return journal
      .find({ type: SessionReverseAnswered.name, field: "session", equals: session })
      .some((stored) => stored.seq > ended && SessionReverseAnswered.schema.safeParse(stored.data).data?.always === key);
  };

  /** The route that decides a permission without asking anybody, when one does. */
  const decidedWithout = (session: SessionRef, rules: Grant, ownToolPrefix: string | undefined, question: Question): "grant" | "remembered" | undefined => {
    if (question.kind !== "permission" || optionOfFlavor(question, "allow_once") === undefined) return undefined;
    const subject = question.subject;
    if (!isToolSubject(subject)) return undefined;
    if (subject.tool !== undefined) {
      if (ownToolPrefix !== undefined && subject.tool.startsWith(ownToolPrefix)) return "grant";
      const covering = match(rules, "tool", subject.tool);
      if (covering !== undefined && !covering.ask) return "grant";
    }
    return remembered(session, permissionKey(subject)) ? "remembered" : undefined;
  };

  /** Close what the starter was asked: answer with nothing, in the record. */
  const closeUnanswered = async (step: Step, data: z.output<typeof SessionReverseAsked.schema>): Promise<void> => {
    await step.emit(SessionReverseAnswered, { id: data.id, session: data.session, by: "cancelled", answer: { cancelled: true } });
  };

  // Each question waits for its own answer: one that waits holds no other.
  api.on(SessionReverseAsked, { id: "session-reverse-ask", concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
    if (data.route !== "starter") return;
    // Nobody waits for it in this process: the harness has gone, or this process is not the one that was asked.
    // The request, if there is one, is closed so the starter is not left holding it.
    if (!waiting.has(data.id)) {
      const request = await requestOf(step, data.id, "find");
      if (request !== undefined) await step.outcome(requestCancel, { id: request, by: data.starter, reason: "nobody waits for the answer" }, { key: "close" });
      await closeUnanswered(step, data);
      return;
    }
    try {
      const { answer: answered } = answeredBy(
        await step(requestAsk, { to: data.starter, question: QUESTION_NAME, input: data.question }, { key: "ask" }),
      );
      const given = settled(data.question, answered);
      await step.emit(SessionReverseAnswered, {
        id: data.id,
        session: data.session,
        by: "starter",
        answer: given.answer,
        ...(given.always === undefined ? {} : { always: given.always }),
      });
      waiting.get(data.id)?.(given.answer);
    } catch (error) {
      // The wait for the starter suspends the handler; it is run again when the answer comes.
      if (isSuspend(error)) throw error;
      // Whatever ended the ask, the harness is answered: a turn never hangs on a question.
      waiting.get(data.id)?.({ cancelled: true });
      if (!endedWithoutAnswer(error)) throw error;
      await closeUnanswered(step, data);
    }
  });

  api.on(SessionReverseCancelled, { id: "session-reverse-cancel" }, async (data, step) => {
    // The harness no longer waits: the request is closed, and the ask that waits on it ends.
    const request = await requestOf(step, data.id, "find");
    if (request !== undefined) await step.outcome(requestCancel, { id: request, by: data.starter, reason: "the harness stopped waiting" }, { key: "cancel" });
  });

  // The harness may stop waiting before the handler of the question has written its request: the
  // handler above then finds nothing to close, so the request is closed when it is written.
  api.on(RequestCreated, { id: "session-reverse-late-cancel" }, async (data, step, created) => {
    if (data.question !== REVERSE_QUESTION || created.cause === null) return;
    const journal = api.journal?.();
    const asked = SessionReverseAsked.schema.safeParse(journal?.get(created.cause)?.data);
    if (journal === undefined || !asked.success) return;
    if (journal.find({ type: SessionReverseCancelled.name, field: "id", equals: asked.data.id }).length === 0) return;
    await step.outcome(requestCancel, { id: data.id, by: asked.data.starter, reason: "the harness stopped waiting" }, { key: "cancel" });
  });

  return {
    handlerFor: (rules, starter, ownToolPrefix) => async (id, request) => {
      const session = sessionRef(id);
      const reverse = ReverseIdSchema.parse(`rev_${randomUUID()}`);
      const original = request.question;
      const route = decidedWithout(session, rules, ownToolPrefix, original);
      if (route !== undefined) {
        const once = optionOfFlavor(original, "allow_once");
        if (once === undefined) return { cancelled: true };
        await api.emit(SessionReverseAsked, { id: reverse, session, route, starter, question: original, raw: request.raw });
        const answer: Answer = { ids: [once.id] };
        await api.emit(SessionReverseAnswered, { id: reverse, session, by: route, answer });
        return answer;
      }

      const answered = new Promise<Answer>((resolve) => waiting.set(reverse, resolve));
      const stopped = (): void => {
        waiting.get(reverse)?.({ cancelled: true });
        waiting.delete(reverse);
        void api.emit(SessionReverseCancelled, { id: reverse, session, starter }).catch(() => {});
      };
      try {
        await api.emit(SessionReverseAsked, { id: reverse, session, route: "starter", starter, question: withAlways(original), raw: request.raw });
      } catch (error) {
        waiting.delete(reverse);
        throw error;
      }
      if (request.signal.aborted) stopped();
      else request.signal.addEventListener("abort", stopped, { once: true });
      try {
        return await answered;
      } finally {
        request.signal.removeEventListener("abort", stopped);
        waiting.delete(reverse);
      }
    },
  };
}
