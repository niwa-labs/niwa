/** What a form of a question turns into: the answer the host takes, or the reason it cannot be sent yet. */

import type { Answer, Question } from "./actions.ts";

/** What the person has filled in so far. */
export type Filled = { picked: readonly string[]; text: string };

export const EMPTY: Filled = { picked: [], text: "" };

export type Built = { answer: Answer } | { problem: string };

/** The names an address is shown by: `owner`, `agent rin`, `session claude/abc`. */
export function addressText(address: { kind: string; id?: string | undefined; harness?: string | undefined }): string {
  if (address.harness !== undefined && address.id !== undefined) return `${address.kind} ${address.harness}/${address.id}`;
  return address.id === undefined ? address.kind : `${address.kind} ${address.id}`;
}

/** The answer a question takes from what was filled in; a problem says what is missing or wrong. */
export function answerOf(question: Question, filled: Filled): Built {
  switch (question.kind) {
    case "choice":
    case "confirm":
    case "permission": {
      const [only, ...more] = filled.picked;
      if (only === undefined) return { problem: "Pick one." };
      if (more.length > 0) return { problem: "Pick only one." };
      return { answer: { ids: [only] } };
    }
    case "multi":
      return filled.picked.length === 0 ? { problem: "Pick at least one." } : { answer: { ids: [...filled.picked] } };
    case "text":
      return filled.text.trim() === "" ? { problem: "Write an answer." } : { answer: { text: filled.text } };
    case "form": {
      if (filled.text.trim() === "") return { problem: "Fill in the value as JSON." };
      try {
        return { answer: { form: JSON.parse(filled.text) as unknown } };
      } catch (error) {
        return { problem: `That is not JSON: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }
}

/** The free text of a question that takes "other": an answer of its own, apart from the options. */
export function otherAnswer(text: string): Built {
  return text.trim() === "" ? { problem: "Write an answer." } : { answer: { text } };
}
