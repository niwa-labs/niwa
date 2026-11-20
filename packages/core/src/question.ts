/**
 * The question and the answer, in the one format the whole system speaks: what a request records,
 * what a script asks the owner, what an agent asks of its client in the middle of a turn, what a
 * rule that asks puts to the owner.
 *
 * A question is self-describing: the journal holds all of it, so a surface draws it without the
 * process that asked. An answer is one of four things, and which one is right follows from the
 * kind of the question (`checkAnswer`).
 */

import { z } from "zod";

/** Any JSON value. */
export const JsonValueSchema = z.json();
export type JsonValue = z.output<typeof JsonValueSchema>;

/**
 * A value as a journal or a wire carries it, checked to be JSON: what JSON leaves out (an
 * undefined member, a function) is left out, a missing value is `null`.
 */
export function jsonOf(value: unknown): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value ?? null) ?? "null"));
}

/** `jsonOf` of a value that may be absent: an absent value stays absent. */
export function optionalJsonOf(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : jsonOf(value);
}

/**
 * A JSON Schema as data: an object of JSON, whoever made it (a zod schema of a script, a harness,
 * a task). A caller may hand it what `z.toJSONSchema` returns, whose members are typed `unknown`;
 * what the host reads has passed as JSON, and a member that is not JSON is refused.
 */
export const JsonSchemaValue = z.record(z.string(), z.unknown()).pipe(z.record(z.string(), JsonValueSchema));
export type JsonSchemaValue = z.output<typeof JsonSchemaValue>;

/** The id of one option of a question, as the one who asked named it. Never the harness's own words. */
export const OptionIdSchema = z.string().min(1).brand<"OptionId">();
export type OptionId = z.output<typeof OptionIdSchema>;

/**
 * What choosing an option means. `allow_always` and `reject_always` are what a permission option
 * is worth to the person who answers; niwa never sends them to a harness (it remembers an
 * "always" itself), so an adapter maps a flavor to the harness's once-only choice.
 */
export const OptionFlavorSchema = z.enum(["allow_once", "allow_always", "reject_once", "reject_always", "plain"]);
export type OptionFlavor = z.output<typeof OptionFlavorSchema>;

/** One option the person may pick. */
export const QuestionOptionSchema = z.object({
  id: OptionIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  flavor: OptionFlavorSchema,
});
export type QuestionOption = z.output<typeof QuestionOptionSchema>;

/** What a permission request of a harness is about, so that "the same request" can be told when it comes again. */
export const ToolSubjectSchema = z.strictObject({
  /** The harness's own name of the tool, when it names one: what the `tool:` rules of a grant are matched with. */
  tool: z.string().min(1).optional(),
  /** The kind of the tool as the harness says it (`execute`, `edit`, `read`, ...). */
  kind: z.string().min(1),
  /** What the tool acts on: a path, a command, the input. A text the same request has the same of. */
  target: z.string(),
});
export type ToolSubject = z.output<typeof ToolSubjectSchema>;

/** What a rule that asks is about: who calls what, with what input, and the rule that asks. */
export const CallSubjectSchema = z.strictObject({
  /** The subject that calls, as `kind:id`. */
  who: z.string().min(1),
  /** The action, with its `@target` when it has one. */
  action: z.string().min(1),
  /** The rule of its grant that asks. */
  rule: z.string().min(1),
  /** The input of the call, as it is: the catalogue knows its schema by `action`. */
  input: JsonValueSchema,
  /** Why the caller says it needs it. */
  reason: z.string().min(1).optional(),
});
export type CallSubject = z.output<typeof CallSubjectSchema>;

/** The subject of a permission question: a tool of a harness, or a call of an action of niwa. */
export const QuestionSubjectSchema = z.union([ToolSubjectSchema, CallSubjectSchema]);
export type QuestionSubject = z.output<typeof QuestionSubjectSchema>;

/** Whether the subject is a tool of a harness. */
export function isToolSubject(subject: QuestionSubject): subject is ToolSubject {
  return "kind" in subject;
}

/** The JSON Schema a form is filled by: an object schema. */
export const FormSchemaSchema = JsonSchemaValue;
export type FormSchema = z.output<typeof FormSchemaSchema>;

const Wording = {
  /** What is asked, in a line. */
  title: z.string().min(1),
  /** More about it, when there is more. */
  detail: z.string().optional(),
  /** The area the question is about, when it names one: the scope of a decision the owner makes of it. */
  area: z.string().min(1).optional(),
};

const Pick = {
  ...Wording,
  options: z.array(QuestionOptionSchema).min(1),
  /** Whether a free text may be given instead of an option ("other"). */
  allowOther: z.boolean().default(false),
};

/**
 * The question, in the one format every surface can show.
 *
 * `choice` picks one option, `multi` any number of them, `confirm` is a choice of yes and no,
 * `text` is a free text, `form` is a value that passes a JSON Schema, `permission` is a tool or a
 * call asking leave.
 */
export const QuestionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), ...Pick }),
  z.object({ kind: z.literal("multi"), ...Pick }),
  z.object({ kind: z.literal("confirm"), ...Pick }),
  z.object({ kind: z.literal("text"), ...Wording }),
  z.object({ kind: z.literal("form"), ...Wording, schema: FormSchemaSchema }),
  z.object({
    kind: z.literal("permission"),
    ...Wording,
    options: z.array(QuestionOptionSchema).min(1),
    subject: QuestionSubjectSchema,
  }),
]);
export type Question = z.output<typeof QuestionSchema>;
/** A question as it is written, before the defaults are given. */
export type QuestionInput = z.input<typeof QuestionSchema>;
export type QuestionKind = Question["kind"];

/**
 * The answer: the options picked, a free text, the value of a form, or nothing (the question
 * ended with no answer: the harness cancelled it, or the one asked refused to answer).
 */
export const AnswerSchema = z.union([
  z.strictObject({ ids: z.array(OptionIdSchema) }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ form: JsonValueSchema }),
  z.strictObject({ cancelled: z.literal(true) }),
]);
export type Answer = z.output<typeof AnswerSchema>;

/** The option of a question that has the flavor, the first when several do. */
export function optionOfFlavor(question: Question, flavor: OptionFlavor): QuestionOption | undefined {
  if (!("options" in question)) return undefined;
  return question.options.find((option) => option.flavor === flavor);
}

/** What the answer picked, as options of the question; an id the question does not have is left out. */
export function pickedOptions(question: Question, answer: Answer): readonly QuestionOption[] {
  if (!("ids" in answer) || !("options" in question)) return [];
  return answer.ids.flatMap((id) => question.options.filter((option) => option.id === id));
}

/**
 * Whether a permission answer lets the tool run: the first option picked allows.
 * An answer that picks nothing, or cancels, does not.
 */
export function allowsTool(question: Question, answer: Answer): boolean {
  const picked = pickedOptions(question, answer)[0];
  return picked?.flavor === "allow_once" || picked?.flavor === "allow_always";
}

/**
 * The key a permission request is remembered by: the same tool kind on the same target.
 * The tool's own name is not part of it: only what the harness describes.
 */
export function permissionKey(subject: ToolSubject): string {
  return `${subject.kind}\u0000${subject.target}`;
}

/** The value of a form, read from the JSON Schema it is filled by; anything when the schema cannot be read. */
function formValueSchema(schema: FormSchema): z.ZodType<unknown> {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return JsonValueSchema;
  }
}

/**
 * The schema an answer to this question must pass: the kind says which answers fit, and the
 * options and the schema of the question say which of them.
 *
 * `cancelled` is never an answer to a question: cancelling is what `request.cancel` is for.
 */
export function answerSchemaOf(question: Question): z.ZodType<unknown> {
  switch (question.kind) {
    case "text":
      return z.strictObject({ text: z.string() });
    case "form":
      return z.strictObject({ form: formValueSchema(question.schema) });
    case "permission":
    case "choice":
    case "confirm":
    case "multi": {
      const [first, ...rest] = question.options.map((option) => option.id as string);
      const one = z.enum([first ?? "", ...rest]);
      const ids = question.kind === "multi" ? z.array(one) : z.array(one).length(1);
      const picked = z.strictObject({ ids });
      return question.kind !== "permission" && question.allowOther
        ? z.union([picked, z.strictObject({ text: z.string().min(1) })])
        : picked;
    }
  }
}

/** Why the answer does not fit the question, or `undefined` when it does. */
export function answerMismatch(question: Question, answer: unknown): string | undefined {
  const checked = answerSchemaOf(question).safeParse(answer);
  return checked.success ? undefined : `a ${question.kind} question is not answered so: ${checked.error.message}`;
}

/**
 * The answer a plain value is, for a question of this kind: an id, the ids, a text, the value of a form.
 * It is how a session that answers through a tool gives an answer without knowing the format.
 */
export function answerOfValue(question: Question, value: unknown): unknown {
  switch (question.kind) {
    case "text":
      return typeof value === "string" ? { text: value } : value;
    case "form":
      return { form: value };
    case "multi":
      return Array.isArray(value) ? { ids: value } : value;
    case "choice":
    case "confirm":
    case "permission":
      return typeof value === "string" ? { ids: [value] } : value;
  }
}

/** The JSON Schema of the plain value `answerOfValue` takes for a question of this kind. */
export function valueSchemaOf(question: Question): FormSchema {
  switch (question.kind) {
    case "text":
      return { type: "string" };
    case "form":
      return question.schema;
    case "multi":
      return { type: "array", items: { type: "string", enum: question.options.map((option) => option.id) } };
    case "choice":
    case "confirm":
    case "permission":
      return { type: "string", enum: question.options.map((option) => option.id) };
  }
}

/** The options a question offers, when it offers any: what a surface draws as buttons. */
export function optionsOf(question: Question): readonly QuestionOption[] {
  return "options" in question ? question.options : [];
}

/**
 * A question as lines of plain text, for a surface that draws no more than text: the wording, and
 * what a permission is about. The options and the form are drawn by the surface itself.
 */
export function questionLines(question: Question): string[] {
  const lines = [question.title];
  if (question.detail !== undefined) lines.push(question.detail);
  if (question.kind !== "permission") return lines;
  const subject = question.subject;
  if (isToolSubject(subject)) {
    lines.push(`${subject.tool ?? subject.kind}: ${subject.target}`);
    return lines;
  }
  lines.push(`who: ${subject.who}`, `action: ${subject.action}`, `rule: ${subject.rule}`, `input: ${JSON.stringify(subject.input)}`);
  if (subject.reason !== undefined) lines.push(`reason: ${subject.reason}`);
  return lines;
}

/** The ids of the two options of a `confirm` question. */
export const CONFIRM_YES = OptionIdSchema.parse("yes");
export const CONFIRM_NO = OptionIdSchema.parse("no");

/** The options of a `confirm` question: yes and no. */
export function confirmOptions(): QuestionOption[] {
  return [
    { id: CONFIRM_YES, label: "Yes", flavor: "plain" },
    { id: CONFIRM_NO, label: "No", flavor: "plain" },
  ];
}

/** Whether the answer to a `confirm` question is yes. */
export function isYes(answer: Answer): boolean {
  return "ids" in answer && answer.ids.length === 1 && answer.ids[0] === CONFIRM_YES;
}
