/**
 * What ZCode asks of its client in the middle of a turn, mapped to niwa's common question and back. The wire is ZCode's `zcode-protocol`:
 *
 * - `interaction/requestPermission`: a tool asks leave. The server lists its options, each with the
 *   `response` it takes for it; the client answers with one response, not with an option id.
 * - `interaction/requestUserInput`, in two forms: `questions` (AskUserQuestion, plan approval, an MCP
 *   server's elicitation), each with options of a `value` and a `label`, answered by
 *   `{ action: "accept", content: { answers: { <question text>: <value> } } }`; and a bare `prompt`
 *   with no questions, answered by `{ action: "accept", content: { answer: <text> } }`.
 *
 * The params arrive read (`protocol/`) and the answers are the types ZCode's protocol gives them. Nothing
 * here talks to a process: the control side owns the wire, this module owns the meaning.
 */

import { OptionIdSchema, pickedOptions, stableJson } from "@niwa-labs/core";
import type { Answer, OptionId, Question, QuestionOption } from "@niwa-labs/core";

import type { RequestPermissionParams, RequestUserInputParams } from "./protocol/generated/zcode-protocol.ts";
import type { RequestAnswer } from "./protocol/index.ts";

/** What an input a request carries is cut to, in the detail of the question. */
const DETAIL_CHARS = 500;

/** The value ZCode gives an option that means "type your answer" (an MCP elicitation of a free text). */
const FREE_TEXT_VALUE = "__zcode_free_text__";

/** The answer to a permission request, as ZCode takes it. */
export type PermissionAnswer = RequestAnswer<"interaction/requestPermission">;

/** The answer to a user input request, as ZCode takes it. */
export type InputAnswer = RequestAnswer<"interaction/requestUserInput">;

/** What the client says when a request cannot be asked: no one could be told, or it was cancelled. */
const CANCELLED_REASON = "niwa: the request was cancelled before it was answered";

/** One request of ZCode, read: its id (the same for every announcement of it) and the call it belongs to. */
export interface ReadRequest<T> {
  readonly requestId: string;
  readonly toolCallId: string | undefined;
  readonly ask: T;
}

/** A permission as a question, and how an answer to it goes back. */
export interface PermissionAsk {
  readonly question: Question;
  answer(answer: Answer): PermissionAnswer;
}

/** One question of a user input request, and the text an answer to it comes to. */
export interface InputQuestion {
  /** The key the answer goes under: the text of the question. */
  readonly key: string;
  readonly question: Question;
  /** The words an answer says: the value of the option picked, or the text given. Nothing when it says none. */
  textOf(answer: Answer): string | undefined;
}

/** A user input request as the questions to ask, and how the answers go back. */
export interface InputAsk {
  readonly questions: readonly InputQuestion[];
  /** The answer to the request: the texts of its questions, in order. */
  answer(texts: readonly string[]): InputAnswer;
}

/** The id of the option a question's `index`-th choice has: ZCode gives its choices none. */
const choiceId = (index: number): OptionId => OptionIdSchema.parse(`option-${index + 1}`);

/** A permission request as a question. */
export function readPermission(request: RequestPermissionParams): ReadRequest<PermissionAsk> {
  // Only the once-only options are carried: niwa remembers an "always" itself and never picks ZCode's own
  // (`allow_project`, `allow_session`). A once-only option ZCode did not offer is made with the answer it takes.
  const allow = request.options.find((option) => option.kind === "allow_once");
  const deny = request.options.find((option) => option.kind === "deny");
  // Only the decision and its reason go back: the rule updates and the changed input of an option are never carried.
  const answerOf = (option: RequestPermissionParams["options"][number]): PermissionAnswer => ({
    decision: option.response.decision,
    ...(option.response.reason === undefined ? {} : { reason: option.response.reason }),
  });
  const offered = [
    { id: allow?.optionId ?? "allow_once", label: allow?.name ?? "Allow once", flavor: "allow_once" as const, description: allow?.description, response: allow === undefined ? { decision: "allow", reason: "Approved once" } satisfies PermissionAnswer : answerOf(allow) },
    { id: deny?.optionId ?? "deny", label: deny?.name ?? "Deny", flavor: "reject_once" as const, description: deny?.description, response: deny === undefined ? { decision: "deny", reason: "niwa: denied" } satisfies PermissionAnswer : answerOf(deny) },
  ];
  const options: QuestionOption[] = offered.map((option) => ({
    id: OptionIdSchema.parse(option.id),
    label: option.label,
    ...(option.description === undefined || option.description === "" ? {} : { description: option.description }),
    flavor: option.flavor,
  }));

  const input = request.input === undefined ? undefined : stableJson(request.input);
  const detail = [request.reason, input].filter((part): part is string => part !== undefined && part !== "").join("\n");
  const question: Question = {
    kind: "permission",
    title: request.toolName,
    ...(detail === "" ? {} : { detail: detail.slice(0, DETAIL_CHARS) }),
    options,
    // ZCode names no kind of tool: the tool is the kind, and its input is what it acts on.
    subject: { tool: request.toolName, kind: request.toolName, target: input ?? request.toolName },
  };

  return {
    requestId: request.requestId,
    toolCallId: request.toolCallId,
    ask: {
      question,
      answer: (answer) => {
        const picked = pickedOptions(question, answer)[0];
        const response = offered.find((option) => option.id === picked?.id)?.response;
        // ZCode has no cancel for a permission: a request nobody answered is a denial of it.
        return response ?? { decision: "deny", reason: CANCELLED_REASON };
      },
    },
  };
}

/** A user input request as the questions to ask. */
export function readUserInput(request: RequestUserInputParams): ReadRequest<InputAsk> {
  const common = { requestId: request.requestId, toolCallId: request.toolCallId };

  const asked = request.questions;
  if (asked === undefined) {
    // The bare form: a prompt and a free text back.
    const text: InputQuestion = {
      key: "answer",
      question: { kind: "text", title: request.prompt ?? request.toolName ?? "The agent asks for input" },
      textOf: textAnswer,
    };
    return { ...common, ask: { questions: [text], answer: ([answer]) => ({ action: "accept", content: { answer: answer ?? "" } }) } };
  }

  const questions: InputQuestion[] = asked.map((entry) => {
    const wording = { title: entry.question, detail: entry.header };
    // A question whose one choice is "type your answer" is a free text.
    if (entry.options.length === 1 && entry.options[0]?.value === FREE_TEXT_VALUE) {
      return { key: entry.question, question: { kind: "text", ...wording }, textOf: textAnswer };
    }
    const options: QuestionOption[] = entry.options.map((option, index) => ({
      id: choiceId(index),
      label: option.label,
      ...(option.description === undefined || option.description === "" ? {} : { description: option.description }),
      flavor: "plain",
    }));
    const question: Question = { kind: entry.multiSelect === true ? "multi" : "choice", ...wording, options, allowOther: true };
    return {
      key: entry.question,
      question,
      // ZCode takes the value of a choice, which is its label for AskUserQuestion and something else for a plan or an MCP enum.
      textOf: (answer) => {
        if ("text" in answer) return answer.text;
        const picked = pickedOptions(question, answer);
        if (picked.length === 0) return undefined;
        return picked.map((option) => entry.options[options.indexOf(option)]?.value ?? option.label).join(", ");
      },
    };
  });
  return {
    ...common,
    ask: {
      questions,
      answer: (texts) => ({ action: "accept", content: { answers: Object.fromEntries(questions.map((entry, index) => [entry.key, texts[index] ?? ""])) } }),
    },
  };
}

function textAnswer(answer: Answer): string | undefined {
  return "text" in answer ? answer.text : undefined;
}

/** A user input request nobody answered: ZCode takes a cancel. */
export const INPUT_CANCELLED: InputAnswer = { action: "cancel" };
