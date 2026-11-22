/** What a form of a question turns into: the answer the host takes, or the reason it cannot be sent yet. */

import type { Answer, Question } from "./actions.ts";

/** What the person has filled in so far. */
export type Filled = { picked: readonly string[]; text: string; form?: unknown };

export const EMPTY: Filled = { picked: [], text: "" };

export type Built = { answer: Answer } | { problem: string };

const ADDRESS_LABELS: Record<string, string> = {
  owner: "Владелец", agent: "Агент", session: "Сессия", task: "Задача", client: "Клиент", strategy: "Стратегия",
};

export function addressText(address: { kind: string; id?: string | undefined; harness?: string | undefined }): string {
  const label = ADDRESS_LABELS[address.kind] ?? address.kind;
  const target = [address.harness, address.id].filter(Boolean).join(" · ");
  return target ? `${label} ${target}` : label;
}

/** The answer a question takes from what was filled in; a problem says what is missing or wrong. */
export function answerOf(question: Question, filled: Filled): Built {
  // A question that takes "other" has two ways to answer: pick from its options, or write one of your own.
  // Both at once is not an answer, and the text is never dropped in silence.
  if ("allowOther" in question && question.allowOther === true && filled.text.trim() !== "") {
    return filled.picked.length > 0 ? { problem: "Выберите вариант или напишите свой ответ." } : otherAnswer(filled.text);
  }
  switch (question.kind) {
    case "choice":
    case "confirm":
    case "permission": {
      const [only, ...more] = filled.picked;
      if (only === undefined) return { problem: "Выберите вариант." };
      if (more.length > 0) return { problem: "Выберите один вариант." };
      return { answer: { ids: [only] } };
    }
    case "multi":
      return { answer: { ids: [...filled.picked] } };
    case "text":
      return filled.text.trim() === "" ? { problem: "Напишите ответ." } : { answer: { text: filled.text } };
    case "form":
      return filled.form === undefined ? { problem: "Заполните форму." } : { answer: { form: filled.form } };
  }
}

/** The free text of a question that takes "other": an answer of its own, apart from the options. */
export function otherAnswer(text: string): Built {
  return text.trim() === "" ? { problem: "Напишите ответ." } : { answer: { text } };
}

/** One thing a permission is about, as the page shows it. */
export type SubjectLine = { label: string; value: unknown };

/** What the owner decides on is shown in this order; anything else a subject says follows it. */
const SUBJECT_ORDER = ["who", "action", "tool", "kind", "target", "rule", "input", "reason"];

/**
 * What a permission question is about, line by line: who calls what with which input and under which
 * rule, or which tool acts on what. Structured values retain their shape for the display.
 */
export function subjectLines(subject: Record<string, unknown>): SubjectLine[] {
  const rank = (key: string): number => {
    const at = SUBJECT_ORDER.indexOf(key);
    return at === -1 ? SUBJECT_ORDER.length : at;
  };
  return Object.keys(subject)
    .filter((key) => subject[key] !== undefined)
    .sort((one, other) => rank(one) - rank(other))
    .map((key) => ({ label: key, value: subject[key] }));
}
