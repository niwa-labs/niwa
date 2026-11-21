/**
 * `ask.<kind>` of a script: the question a script puts to the owner, built from
 * what the call says, and the typed value the owner's answer comes back as.
 *
 * The child process builds the question, the host asks it as a request and turns the answer into
 * the value; both sides use this one file, so they cannot disagree about a kind.
 */

import { OptionIdSchema, QuestionSchema, confirmOptions, isYes } from "@niwa-labs/core";
import type { Answer, Question, QuestionOption } from "@niwa-labs/core";

/** An option of `ask.choice` and `ask.multi`: the id alone, or the id with how it is shown. */
export type AskOption = string | { readonly id: string; readonly label?: string; readonly description?: string };

/** The options as a question holds them. Their ids are what the script gets back, so they are told apart. */
function optionsOf(options: readonly AskOption[]): QuestionOption[] {
  if (options.length === 0) throw new Error("a question with no options cannot be answered");
  const seen = new Set<string>();
  return options.map((option) => {
    const { id, label, description } = typeof option === "string" ? { id: option } : option;
    if (seen.has(id)) throw new Error(`the option "${id}" is given twice`);
    seen.add(id);
    return {
      id: OptionIdSchema.parse(id),
      label: label ?? id,
      ...(description === undefined ? {} : { description }),
      flavor: "plain" as const,
    };
  });
}

/** `ask.choice(text, options)`: one of the options. */
export const choiceQuestion = (text: string, options: readonly AskOption[]): Question =>
  QuestionSchema.parse({ kind: "choice", title: text, options: optionsOf(options) });

/** `ask.multi(text, options)`: any number of the options. */
export const multiQuestion = (text: string, options: readonly AskOption[]): Question =>
  QuestionSchema.parse({ kind: "multi", title: text, options: optionsOf(options) });

/** `ask.confirm(text)`: yes or no. */
export const confirmQuestion = (text: string): Question =>
  QuestionSchema.parse({ kind: "confirm", title: text, options: confirmOptions() });

/** `ask.text(text)`: a free text. */
export const textQuestion = (text: string): Question => QuestionSchema.parse({ kind: "text", title: text });

/** `ask.form(text, schema)`: a value that passes a JSON Schema. */
export const formQuestion = (text: string, schema: Readonly<Record<string, unknown>>): Question =>
  QuestionSchema.parse({ kind: "form", title: text, schema });

/** The value a script gets for the answer of the owner to a question of its own: the id, the ids, a boolean, a text, the form. */
export function valueOf(question: Question, answer: Answer): unknown {
  switch (question.kind) {
    case "confirm":
      return isYes(answer);
    case "choice":
      return "ids" in answer ? answer.ids[0] : undefined;
    case "multi":
      return "ids" in answer ? answer.ids : [];
    case "text":
      return "text" in answer ? answer.text : undefined;
    case "form":
      return "form" in answer ? answer.form : undefined;
    case "permission":
      throw new Error("a script does not ask for a permission");
  }
}

/** What a question comes to when nobody answers it, for a run that only plans: the neutral value of its kind. */
export function neutralValue(question: Question): unknown {
  switch (question.kind) {
    case "confirm":
      return false;
    case "choice":
      return question.options[0]?.id;
    case "multi":
      return [];
    case "text":
      return "";
    case "form":
    case "permission":
      return null;
  }
}
