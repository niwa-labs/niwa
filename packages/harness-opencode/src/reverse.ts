/**
 * What opencode asks of its client in the middle of a turn, mapped to niwa's common question and
 * back.
 *
 * - `permission.asked`: a tool asks leave for an action (`shell`, `edit`, `read`, ...) on
 *   resources. The client answers per request id with `once`, `always` or `reject`.
 * - `form.created`: OpenCode's question tool or another native form asks for field values.
 *   The client replies with those values or cancels the form.
 *
 * niwa never says `always` to opencode: it remembers an "allow always" itself (a grant), so the
 * question offers the once-only choices only, and an answer picks one of them. A request nobody
 * answered is a denial of it, which is also what a turn's end leaves behind.
 *
 * The requests arrive read (the typed event) and the answers are the decision opencode takes.
 * Nothing here talks to a server: the control side owns the wire, this module owns the meaning.
 */

import { OptionIdSchema, pickedOptions, stableJson } from "@niwa-labs/core";
import type { Answer, FormSchema, Question, QuestionOption } from "@niwa-labs/core";
import type { PermissionReply, SessionFormReplyInput } from "@opencode/client";
import { z } from "zod";

import type { PermissionAskedData } from "./protocol.ts";

/** What an input a request carries is cut to, in the detail of the question. */
const DETAIL_CHARS = 500;

/** The answer to a permission request, as opencode takes it. */
export type PermissionDecision = PermissionReply;

/** A permission request as a question, and how an answer to it goes back. */
export interface PermissionAsk {
  readonly question: Question;
  /** The decision the answer comes to; a request nobody answered is a denial of it. */
  answer(answer: Answer): PermissionDecision;
}

/** The options a permission question offers: allow once, deny. */
const OPTIONS: readonly QuestionOption[] = [
  { id: OptionIdSchema.parse("allow_once"), label: "Allow once", flavor: "allow_once" },
  { id: OptionIdSchema.parse("deny"), label: "Deny", flavor: "reject_once" },
];

/** A permission request as a question. */
export function readPermission(request: PermissionAskedData): PermissionAsk {
  const detail = [
    request.message,
    request.metadata === undefined ? undefined : stableJson(request.metadata),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n");
  const question: Question = {
    kind: "permission",
    title: request.action,
    ...(detail === "" ? {} : { detail: detail.slice(0, DETAIL_CHARS) }),
    options: [...OPTIONS],
    // opencode names no tool of its own beyond the action: the action is the kind, and the
    // resources are what it acts on.
    subject: { tool: request.action, kind: request.action, target: request.resources.join(" ") },
  };
  return {
    question,
    answer: (answer) => {
      const picked = pickedOptions(question, answer)[0];
      if (picked === undefined) return "reject";
      return picked.flavor === "allow_once" ? "once" : "reject";
    },
  };
}

/** What a session with no one to ask is answered, by the policy its control side was given. */
export function policyDecision(policy: "allow" | "deny"): PermissionDecision {
  return policy === "allow" ? "once" : "reject";
}

/** The subset of OpenCode's field schema the common form can safely represent. */
const FormField = {
  key: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  hidden: z.literal(false).optional(),
  when: z.tuple([]).optional(),
};

const FormOption = z.strictObject({ value: z.string(), label: z.string(), description: z.string().optional() });
const NumberField = { minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional() };
const Fields = z.discriminatedUnion("type", [
  z.strictObject({
    ...FormField,
    type: z.literal("string"),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    minLength: z.int().nonnegative().optional(),
    maxLength: z.int().nonnegative().optional(),
    placeholder: z.string().optional(),
    default: z.string().optional(),
    options: z.array(FormOption).optional(),
    custom: z.boolean().optional(),
  }),
  z.strictObject({ ...FormField, ...NumberField, type: z.literal("number") }),
  z.strictObject({ ...FormField, ...NumberField, type: z.literal("integer") }),
  z.strictObject({ ...FormField, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.strictObject({
    ...FormField,
    type: z.literal("multiselect"),
    options: z.array(FormOption),
    minItems: z.int().nonnegative().optional(),
    maxItems: z.int().nonnegative().optional(),
    custom: z.boolean().optional(),
    default: z.array(z.string()).optional(),
  }),
]);
const NativeForm = z.object({ title: z.string(), fields: z.array(Fields).min(1) });
const NativeFormAnswer = z.strictObject({
  form: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
});

export interface FormAsk {
  readonly question: Extract<Question, { kind: "form" }>;
  /** No reply means the control side cancels the native form. */
  answer(answer: Answer): SessionFormReplyInput["answer"] | undefined;
}

function fieldSchema(field: z.output<typeof Fields>): FormSchema | undefined {
  const wording: FormSchema = {
    ...(field.title ? { title: field.title } : {}),
    ...(field.description === undefined ? {} : { description: field.description }),
  };
  const initial: FormSchema = field.default === undefined ? {} : { default: field.default };
  switch (field.type) {
    case "string": {
      // OpenCode requires a non-empty value when a string is required.
      const minLength = Math.max(field.minLength ?? 0, field.required ? 1 : 0);
      if (field.maxLength !== undefined && field.maxLength < minLength) return undefined;
      if (field.options?.length === 0 && !field.custom) return undefined;
      return {
        ...wording,
        ...initial,
        ...stringOptions(field.options, field.custom),
        ...(field.format === undefined ? {} : { format: field.format }),
        ...(minLength === 0 ? {} : { minLength }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      };
    }
    case "number":
    case "integer":
      if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) return undefined;
      return {
        type: field.type,
        ...wording,
        ...initial,
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      };
    case "boolean":
      return { type: "boolean", ...wording, ...initial };
    case "multiselect": {
      const minItems = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
      if (field.maxItems !== undefined && field.maxItems < minItems) return undefined;
      if (field.options.length === 0 && !field.custom) return undefined;
      return {
        type: "array",
        items: stringOptions(field.options, field.custom),
        ...wording,
        ...initial,
        ...(minItems === 0 ? {} : { minItems }),
        ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
      };
    }
  }
}

/** Labels are for display. OpenCode receives the original option values. */
function stringOptions(options: z.output<typeof FormOption>[] | undefined, custom: boolean | undefined): FormSchema {
  if (!options?.length) return { type: "string" };
  const variants: FormSchema[] = options.map(({ value, label, description }) => ({
    const: value,
    title: label || value,
    ...(description === undefined ? {} : { description }),
  }));
  // A custom value may match a preset, so the variants are inclusive.
  if (custom) variants.push({ type: "string", title: "Custom answer" });
  return { type: "string", anyOf: variants };
}

/** Translate an unconditional native form. External actions, hidden fields and arbitrary regular
 * expressions have no safe representation in the common form. The caller cancels those requests. */
export function readForm(request: unknown): FormAsk | undefined {
  const parsed = NativeForm.safeParse(request);
  if (!parsed.success) return undefined;
  const { title, fields } = parsed.data;
  const properties = new Map<string, FormSchema>();
  const required: string[] = [];
  for (const field of fields) {
    if (properties.has(field.key) || Object.hasOwn(Object.prototype, field.key)) return undefined;
    const schema = fieldSchema(field);
    if (schema === undefined) return undefined;
    properties.set(field.key, schema);
    if (field.required) required.push(field.key);
  }
  const schema = { type: "object", properties: Object.fromEntries(properties), required, additionalProperties: false };
  // Unlike the core's general form validator, this boundary must fail closed if conversion fails.
  let validate: z.ZodType;
  try {
    validate = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined;
  }
  return {
    question: { kind: "form", title: title.trim() === "" ? "OpenCode form" : title, schema },
    answer(answer) {
      // Zod may omit own prototype keys when reading a record. Reject unexpected keys as given.
      if (!("form" in answer) || Object.keys(answer.form ?? {}).some((key) => !properties.has(key))) return undefined;
      const reply = NativeFormAnswer.safeParse(answer);
      if (!reply.success) return undefined;
      const { form } = reply.data;
      // A default is a hint for the person filling the form, never a substitute for their answer.
      if (required.some((key) => !Object.hasOwn(form, key))) return undefined;
      return validate.safeParse(form).success ? form : undefined;
    },
  };
}
