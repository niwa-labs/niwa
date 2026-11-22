// What the answer forms of the requests page turn into.

import { expect, test } from "bun:test";

import type { Question } from "../src/cockpit/actions.ts";
import { addressText, answerOf, EMPTY, otherAnswer, subjectLines } from "../src/cockpit/answers.ts";

const options = [
  { id: "yes", label: "Yes", flavor: "plain" },
  { id: "no", label: "No", flavor: "plain" },
];
const choice: Question = { kind: "choice", title: "Go?", options };
const multi: Question = { kind: "multi", title: "Which?", options };

test("a choice takes exactly one option", () => {
  expect(answerOf(choice, EMPTY)).toEqual({ problem: "Выберите вариант." });
  expect(answerOf(choice, { picked: ["yes", "no"], text: "" })).toEqual({ problem: "Выберите один вариант." });
  expect(answerOf(choice, { picked: ["yes"], text: "" })).toEqual({ answer: { ids: ["yes"] } });
});

test("a multiple choice accepts zero or more options", () => {
  expect(answerOf(multi, EMPTY)).toEqual({ answer: { ids: [] } });
  expect(answerOf(multi, { picked: ["yes", "no"], text: "" })).toEqual({ answer: { ids: ["yes", "no"] } });
});

test("a text question takes a text that is not blank", () => {
  const text: Question = { kind: "text", title: "Why?" };
  expect(answerOf(text, { picked: [], text: "  " })).toEqual({ problem: "Напишите ответ." });
  expect(answerOf(text, { picked: [], text: "because" })).toEqual({ answer: { text: "because" } });
  expect(otherAnswer("elsewhere")).toEqual({ answer: { text: "elsewhere" } });
  expect(otherAnswer("")).toEqual({ problem: "Напишите ответ." });
});

test("a form sends the typed values collected from its fields", () => {
  const form: Question = { kind: "form", title: "Fill", schema: {} };
  expect(answerOf(form, EMPTY)).toEqual({ problem: "Заполните форму." });
  expect(answerOf(form, { ...EMPTY, form: { a: 1, approved: false } })).toEqual({ answer: { form: { a: 1, approved: false } } });
  expect(answerOf(form, { ...EMPTY, form: null })).toEqual({ answer: { form: null } });
});

test("an address is named by its kind and what it names", () => {
  expect(addressText({ kind: "owner" })).toBe("Владелец");
  expect(addressText({ kind: "agent", id: "rin" })).toBe("Агент rin");
  expect(addressText({ kind: "session", harness: "claude", id: "abc" })).toBe("Сессия claude · abc");
});

test("a permission shows what the owner decides on: the input of the call, the rule and the reason", () => {
  const subject = { who: "session:s1", action: "git.push@origin", rule: "call:git.*", input: { branch: "main", force: true }, reason: "to ship" };
  expect(subjectLines(subject)).toEqual([
    { label: "who", value: "session:s1" },
    { label: "action", value: "git.push@origin" },
    { label: "rule", value: "call:git.*" },
    { label: "input", value: { branch: "main", force: true } },
    { label: "reason", value: "to ship" },
  ]);
  // Two calls of one action that differ only in their input do not look the same.
  const other = subjectLines({ ...subject, input: { branch: "main", force: false } });
  expect(other).not.toEqual(subjectLines(subject));
});

test("a permission of a tool shows the tool and what it acts on", () => {
  expect(subjectLines({ tool: "Bash", kind: "execute", target: "rm -rf build" })).toEqual([
    { label: "tool", value: "Bash" },
    { label: "kind", value: "execute" },
    { label: "target", value: "rm -rf build" },
  ]);
});

test("a question that takes other sends the text when nothing is picked, and refuses text with a pick", () => {
  const open: Question = { kind: "multi", title: "Which?", options, allowOther: true };
  expect(answerOf(open, EMPTY)).toEqual({ answer: { ids: [] } });
  expect(answerOf(open, { picked: [], text: "something else" })).toEqual({ answer: { text: "something else" } });
  expect(answerOf(open, { picked: ["yes"], text: "something else" })).toEqual({ problem: "Выберите вариант или напишите свой ответ." });
  expect(answerOf(open, { picked: ["yes"], text: "  " })).toEqual({ answer: { ids: ["yes"] } });
  // The same holds for a choice, which has always taken its other answer.
  expect(answerOf({ ...choice, allowOther: true }, { picked: [], text: "else" })).toEqual({ answer: { text: "else" } });
});
