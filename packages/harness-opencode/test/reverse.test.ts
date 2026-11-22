import { expect, test } from "bun:test";

import { QuestionSchema, answerMismatch } from "@niwa-labs/core";
import type { FormCreated } from "@opencode/client";

import { readForm } from "../src/reverse.ts";

const FORM = {
  id: "frm_native",
  sessionID: "ses_native",
  title: "Deployment settings",
  fields: [
    { key: "region", type: "string", required: true, title: "Region", options: [
      { value: "eu-central-1", label: "Europe", description: "Frankfurt" },
    ] },
    { key: "alerts", type: "multiselect", required: true, maxItems: 2, custom: true, options: [
      { value: "mail", label: "Email" },
    ] },
    { key: "mode", type: "string", custom: true, options: [{ value: "dry-run", label: "Dry run" }] },
    { key: "replicas", type: "integer", required: true, minimum: 1, maximum: 5, default: 2 },
    { key: "fraction", type: "number", minimum: 0, maximum: 1 },
    { key: "confirm", type: "boolean", required: true },
    { key: "note", type: "string", minLength: 2, maxLength: 8 },
    { key: "callback", type: "string", format: "uri" },
  ],
} satisfies FormCreated["data"]["form"];

const ANSWER = { region: "eu-central-1", alerts: ["mail", "pager"], replicas: 3, confirm: false };

test("native forms use the common form schema and reply with native values", () => {
  const ask = readForm(FORM)!;
  const question = QuestionSchema.parse(ask.question);
  expect(question).toMatchObject({
    kind: "form",
    title: FORM.title,
    schema: {
      type: "object",
      required: ["region", "alerts", "replicas", "confirm"],
      additionalProperties: false,
      properties: {
        region: { title: "Region", type: "string", anyOf: [
          { const: "eu-central-1", title: "Europe", description: "Frankfurt" },
        ] },
        alerts: { type: "array", minItems: 1, maxItems: 2 },
        replicas: { type: "integer", minimum: 1, maximum: 5, default: 2 },
        confirm: { type: "boolean" },
      },
    },
  });
  const answer = { form: { ...ANSWER, fraction: 0.5, note: "Ready", mode: "custom run", callback: "https://example.com" } };
  expect(answerMismatch(question, answer)).toBeUndefined();
  expect(ask.answer(answer)).toEqual(answer.form);
  expect(ask.answer({ form: ANSWER })).toEqual(ANSWER);
});

test("native forms cancel instead of replying with an invalid answer", () => {
  const ask = readForm(FORM)!;
  const { replicas: _replicas, ...missingRequired } = ANSWER;
  for (const form of [
    null,
    ["irrelevant"],
    missingRequired,
    { ...ANSWER, region: "Europe" },
    { ...ANSWER, alerts: [] },
    { ...ANSWER, alerts: ["mail", "pager", "chat"] },
    { ...ANSWER, replicas: 1.5 },
    { ...ANSWER, replicas: 6 },
    { ...ANSWER, fraction: -0.1 },
    { ...ANSWER, confirm: "false" },
    { ...ANSWER, note: " " },
    { ...ANSWER, callback: "invalid-uri" },
    { ...ANSWER, extra: true },
    { ...ANSWER, ["__proto__"]: true },
  ]) {
    expect(ask.answer({ form })).toBeUndefined();
  }
  expect(ask.answer({ cancelled: true })).toBeUndefined();
  expect(ask.answer({ text: "yes" })).toBeUndefined();
});

test("custom answers are accepted only on fields that offer them", () => {
  const ask = readForm({
    title: "Notify",
    fields: [{ key: "alerts", type: "multiselect", options: [{ value: "mail", label: "Email" }] }],
  })!;
  expect(ask.answer({ form: { alerts: ["mail"] } })).toEqual({ alerts: ["mail"] });
  expect(ask.answer({ form: { alerts: ["pager"] } })).toBeUndefined();
  expect(ask.answer({ form: {} })).toEqual({});
});

test("unsupported or malformed native forms are declined as a whole", () => {
  for (const fields of [
    [],
    [FORM.fields[0], FORM.fields[0]],
    [{ key: "__proto__", type: "string" }],
    [{ key: "hidden", type: "string", hidden: true, default: "private" }],
    [{ key: "url", type: "external", url: "https://example.com" }],
    [{ key: "extra", type: "boolean", when: [{ key: "confirm", op: "eq", value: true }] }],
    [{ key: "regex", type: "string", pattern: "[" }],
    [{ key: "unknown", type: "object" }],
    [{ key: "invalid", type: "number", minimum: 2, maximum: 1 }],
    [{ key: "invalid", type: "string", required: true, maxLength: 0 }],
  ]) {
    expect(readForm({ ...FORM, fields })).toBeUndefined();
  }
});
