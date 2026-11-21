/**
 * Asking a session means: give it a prompt, get back a value that passed a schema.
 *
 * The harness declares which of two ways it has:
 *
 * - it does structured output natively: it is asked and answers with a value;
 * - it does not: niwa asks it through a request. The question niwa asks of a session is
 *   a request, the request waits for the answer, and the answer comes back through
 *   `submit-answer`. The wait is a request, so it survives a restart.
 *
 * An answer that does not pass the schema is never returned as a value. The request
 * refuses it, and the question stays open for a corrected answer.
 */

import { z } from "zod";

import { AnswerSchema, FormSchemaSchema, action, answerOfValue, toJsonSchema } from "@niwa-labs/core";
import type { Action, ActionContext, Answer, JournalReader, Question, Address } from "@niwa-labs/core";

import { PromptSchema } from "@niwa-labs/harness";
import { QuestionName, RequestCreated, RequestId, answeredBy, requestAsk, requestResolve } from "@niwa-labs/requests/records";


/** The name of the action a session calls when the harness cannot answer natively. */
export const SUBMIT_ANSWER_ACTION = "submit-answer";

/** The name of the question a session's answer is asked with. */
export const SESSION_QUESTION = QuestionName.parse("session.answer");

/** How a session gives the value of an answer, by the kind of the question. */
function valueText(question: Question): string {
  switch (question.kind) {
    case "form":
      return "an object for an object, a number as a number, as JSON that passes the schema";
    case "text":
      return "the text";
    case "multi":
      return "the list of the ids of the options you pick";
    case "choice":
    case "confirm":
    case "permission":
      return "the id of the option you pick";
  }
}

/** What the question puts besides its wording: the options, or the schema of the value. */
function questionBody(question: Question): string[] {
  switch (question.kind) {
    case "form":
      return ["The value must pass this schema:", JSON.stringify(question.schema, null, 2)];
    case "text":
      return [];
    case "choice":
    case "multi":
    case "confirm":
    case "permission":
      return [
        "The options:",
        ...question.options.map((option) => `- ${option.id}: ${option.label}${option.description === undefined ? "" : ` (${option.description})`}`),
      ];
  }
}

/**
 * The text of a question, as the session that may answer it reads it.
 *
 * The text says what is asked, what the answer must look like — the question carries its own
 * options or schema, so it needs no process that knows it — and how the answer is given back.
 * The id of the request is in it twice: the session needs it to answer, and the answer is bound
 * to it.
 */
export function questionText(args: {
  /** The id of the request that waits for the answer. */
  readonly request: string;
  /** The name of the question. */
  readonly question: string;
  /** What was asked. */
  readonly input: Question;
}): string {
  const lines = [
    "niwa asks you a question.",
    `Question: ${args.question}`,
    `Request id: ${args.request}`,
    "",
    "What is asked:",
    args.input.title,
  ];
  if (args.input.detail !== undefined) lines.push(args.input.detail);
  const body = questionBody(args.input);
  if (body.length > 0) lines.push("", ...body);
  lines.push(
    "",
    `Answer with the niwa tool ${SUBMIT_ANSWER_ACTION}, request id ${args.request}`,
    `Call it with question set to the request id above (not to the name of the question) and value set to the answer itself: ${valueText(args.input)}. If your tool can pass the value only as text, pass the JSON of the answer as that text.`,
  );
  return lines.join("\n");
}

/** What was asked of a session, as the session reads it: a prompt is its sections' text. */
function promptText(prompt: unknown): string {
  const parsed = PromptSchema.safeParse(prompt);
  if (parsed.success) return parsed.data.sections.map((section) => section.text).join("\n");
  return typeof prompt === "string" ? prompt : (JSON.stringify(prompt, null, 2) ?? "");
}

/**
 * Ask a session that cannot answer natively.
 *
 * The question niwa asks of a session is a request, addressed to that session: the request
 * waits for the answer, and the wait survives a restart. The answer comes back through
 * `submit-answer`.
 *
 * The question is a form: its value must pass `schema`. The zod schema is held while the ask
 * waits, so an answer that fails a refinement is refused and the question stays open.
 */
export async function askNonNative(
  ctx: ActionContext,
  args: {
    /** The session that may answer. */
    readonly to: Address;
    /** What is asked: the prompt of the session. */
    readonly prompt: unknown;
    /** What the value of the answer must pass. */
    readonly schema: z.ZodType<unknown>;
  },
): Promise<unknown> {
  const { answer } = answeredBy(await ctx.step(requestAsk, {
    to: args.to,
    question: SESSION_QUESTION,
    input: {
      kind: "form",
      title: "Answer the prompt",
      detail: promptText(args.prompt),
      schema: FormSchemaSchema.parse(toJsonSchema(args.schema, "input")),
    },
    check: args.schema,
  }));
  if (!("form" in answer)) throw new Error("the session answered a form with something else");
  return answer.form;
}

/**
 * The request with this exact id, with its question, as the journal holds it.
 *
 * Only the exact id the session was given names a request: a short text would have to be matched
 * against the requests of everyone, and a refusal that lists the candidates would show a session
 * the requests of others.
 */
function requestNamed(journal: JournalReader | undefined, id: string): { id: RequestId; input: Question } | undefined {
  for (const stored of journal?.find({ type: RequestCreated.name, field: "id", equals: id }) ?? []) {
    const parsed = RequestCreated.schema.safeParse(stored.data);
    if (parsed.success) return { id: parsed.data.id, input: parsed.data.input };
  }
  return undefined;
}

/**
 * The action a session calls to answer a question.
 *
 * The question niwa asked of a session is a request: the id the session was given is the id
 * of that request, and the answer is given to the request by name.
 */
export function submitAnswerAction(journal: () => JournalReader | undefined): Action<{ question: string; value: unknown }, { accepted: boolean }> {
  return action(SUBMIT_ANSWER_ACTION, {
    description:
      "Answers the question niwa asked of a session. `value` is the answer as a plain value of the question: the object that passes its schema for a form, the id of the option picked for a choice, the list of ids for a multi, the text for a text; a tool layer that can only pass text may pass that JSON as text, and it is read as JSON when the value as given does not pass.",
    input: z.object({
      /** The id of the request the question is, as it was given with the question: not its name. */
      question: z.string().min(1),
      /** The answer. It must fit the question, as given or read as JSON text. */
      value: z.unknown(),
    }),
    output: z.object({ accepted: z.boolean() }),
    // The answer is written under the id of the operation, and the first answer stands: a
    // call that was cut off may be made again, and the same answer stands.
    recovery: "repeat",
    async run(input, ctx) {
      // The value is the answer given as a plain value; the question says which answer it is.
      const named = requestNamed(journal(), input.question);
      if (named === undefined) throw new Error(`the request "${input.question}" does not exist`);
      const id = named.id;
      /** Give a plain value as the answer. A refusal may be tried again as the JSON the value holds, unless it is final. */
      const give = async (value: unknown): Promise<{ accepted: boolean } | { refused: string; final: boolean }> => {
        const answer = AnswerSchema.safeParse(answerOfValue(named.input, value));
        if (!answer.success) {
          return { refused: `the value is not an answer to the question: ${answer.error.message}`, final: false };
        }
        // An answer to a request that was cancelled or expired, or that another answer closed,
        // is not accepted, as the answer of the addressee is not.
        const outcome = await ctx.step.outcome(requestResolve, { id, answer: answer.data });
        switch (outcome.status) {
          case "completed":
            return { accepted: outcome.value.answered };
          case "failed":
            return { refused: outcome.error, final: false };
          case "denied":
            return { refused: outcome.reason, final: true };
          case "unknown":
            return { refused: "the answer could not be given: its outcome is unknown", final: true };
          case "cancelled":
            return { refused: `the answer was not given: ${outcome.reason}`, final: true };
        }
      };
      const given = await give(input.value);
      if ("accepted" in given) return given;
      // Some tool layers pass an argument with no declared type as text: an answer that does not
      // pass as given, and is JSON text, is read as that JSON. The question still decides.
      const decoded = given.final ? undefined : jsonText(input.value);
      if (decoded === undefined) throw new Error(given.refused);
      const read = await give(decoded.value);
      if ("accepted" in read) return read;
      // The answer is refused as given and as read: what the model is told is both, as it cannot
      // know which way it was taken.
      throw new Error(`${given.refused} (read as the JSON it holds: ${read.refused})`);
    },
  });
}

/** The JSON a text holds, when the value is a text that is JSON and not a bare string. */
function jsonText(value: unknown): { value: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? undefined : { value: parsed };
  } catch {
    return undefined;
  }
}
