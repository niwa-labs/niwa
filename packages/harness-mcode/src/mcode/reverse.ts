/**
 * What MiniMax Code asks of its client in the middle of a turn, as niwa's common questions
 * ("reverse requests"). Pure mapping: the wiring (who is asked, when
 * the wait is over, what is written back) is the control side's.
 *
 * MiniMax Code asks in two ways, both read from its own ACP layer:
 *
 * - `session/request_permission`, for a tool. The fork may offer lasting options too (`allow_always`,
 *   `reject_always`); only the once-only ones are ever offered or picked.
 * - a questionnaire for a person. A client that declares `elicitation.form` gets `elicitation/create`
 *   with a form (one property per step); one that does not gets the first step, when it is a
 *   single choice with no other, as a `session/request_permission` whose option ids start with
 *   `questionnaire:<id>:`. That request is a question, not a permission.
 */

import { z } from "zod";

import type { Answer, Question, QuestionOption } from "@niwa-labs/core";
import { OptionIdSchema, pickedOptions, stableJson } from "@niwa-labs/core";

/** What an answer to `session/request_permission` is, in the agent's words. */
export type PermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/** A permission request, as a question, and how an answer to it goes back. */
export interface PermissionAsk {
  readonly question: Question;
  readonly outcomeOf: (answer: Answer) => PermissionOutcome;
}

/** How much of a tool's input a question shows as its detail. */
const DETAIL_CHARS = 500;

/** The prefix of the option ids of a questionnaire that arrives as a permission request. */
const QUESTIONNAIRE_PREFIX = "questionnaire:";

/**
 * What a permission question holds when the agent offered nothing it could be answered with: the
 * only answer there is. It is never picked; the request ends as cancelled.
 */
const REJECT_ONLY: QuestionOption = { id: OptionIdSchema.parse("cancel"), label: "Cancel", flavor: "reject_once" };

const CANCELLED: PermissionOutcome = { outcome: "cancelled" };

const OfferedSchema = z.object({ optionId: z.string().min(1), name: z.string().optional(), kind: z.string().optional() });

const ToolCallSchema = z.object({
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  name: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  rawInput: z.unknown().optional(),
  locations: z.array(z.object({ path: z.string() })).optional(),
});

const PermissionParamsSchema = z.object({
  toolCall: ToolCallSchema.catch({}).default({}),
  options: z.array(z.unknown()).default([]),
});

/** The pieces of a `session/request_permission` request, and the prefix of its options when it is a questionnaire. */
function permissionParts(params: unknown) {
  const parsed = PermissionParamsSchema.safeParse(params);
  const { toolCall, options } = parsed.success ? parsed.data : { toolCall: {}, options: [] };
  const offered = options.flatMap((entry) => {
    const option = OfferedSchema.safeParse(entry);
    return option.success ? [option.data] : [];
  });
  const prefix = toolCall.toolCallId === undefined ? undefined : `${QUESTIONNAIRE_PREFIX}${toolCall.toolCallId}:`;
  const questionnaire = prefix !== undefined && offered.length > 0 && offered.every((option) => option.optionId.startsWith(prefix));
  return { toolCall, offered, prefix, questionnaire };
}

/**
 * Whether a `session/request_permission` request is a question for a person, not a permission: the
 * answers of a questionnaire are offered as once-only options, and no policy may pick one of them.
 */
export function isQuestionnaire(params: unknown): boolean {
  return permissionParts(params).questionnaire;
}

/** The question of a `session/request_permission` request, and how its answer goes back. */
export function permissionAsk(params: unknown): PermissionAsk {
  const { toolCall, offered, prefix, questionnaire } = permissionParts(params);
  if (questionnaire && prefix !== undefined) return questionnaireAsk(toolCall.title, offered, prefix);

  const title = toolCall.title ?? toolCall.name ?? "a tool";
  const once: QuestionOption[] = offered.flatMap((option) =>
    option.kind === "allow_once" || option.kind === "reject_once"
      ? [{ id: OptionIdSchema.parse(option.optionId), label: option.name ?? option.kind, flavor: option.kind }]
      : [],
  );
  const paths = toolCall.locations?.map((location) => location.path) ?? [];
  const question: Question = {
    kind: "permission",
    title,
    ...(toolCall.rawInput === undefined ? {} : { detail: stableJson(toolCall.rawInput).slice(0, DETAIL_CHARS) }),
    options: once.length === 0 ? [REJECT_ONLY] : once,
    subject: {
      ...(toolCall.name === undefined ? {} : { tool: toolCall.name }),
      kind: toolCall.kind ?? "other",
      target: paths.length > 0 ? paths.join("\n") : toolCall.rawInput === undefined ? title : stableJson(toolCall.rawInput),
    },
  };
  return { question, outcomeOf: (answer) => selectedOf(question, answer, once) };
}

/** The single-choice questionnaire that arrives as a permission request: the options are the answers, the cancel is the refusal. */
function questionnaireAsk(
  title: string | undefined,
  offered: ReadonlyArray<z.output<typeof OfferedSchema>>,
  prefix: string,
): PermissionAsk {
  const choices: QuestionOption[] = offered.flatMap((option) =>
    option.optionId === `${prefix}cancel`
      ? []
      : [{ id: OptionIdSchema.parse(option.optionId), label: option.name ?? option.optionId.slice(prefix.length), flavor: "plain" }],
  );
  if (choices.length === 0) {
    const question: Question = { kind: "choice", title: title ?? "MiniMax Code needs your input", options: [REJECT_ONLY], allowOther: false };
    return { question, outcomeOf: () => CANCELLED };
  }
  const question: Question = { kind: "choice", title: title ?? "MiniMax Code needs your input", options: choices, allowOther: false };
  return { question, outcomeOf: (answer) => selectedOf(question, answer, choices) };
}

/** The option an answer picked, when it is one of `allowed`: anything else, a cancel included, cancels. */
function selectedOf(question: Question, answer: Answer, allowed: readonly QuestionOption[]): PermissionOutcome {
  const picked = pickedOptions(question, answer)[0];
  if (picked === undefined || !allowed.some((option) => option.id === picked.id)) return CANCELLED;
  return { outcome: "selected", optionId: picked.id };
}

// -- a form -------------------------------------------------------------------------------------

const ChoiceSchema = z.object({ const: z.string().min(1), title: z.string().optional(), description: z.string().optional() });

const PropertySchema = z.union([
  z.object({ type: z.literal("array"), title: z.string().optional(), description: z.string().optional(), items: z.object({ anyOf: z.array(ChoiceSchema).min(1) }) }),
  z.object({ type: z.literal("string"), title: z.string().optional(), description: z.string().optional(), oneOf: z.array(ChoiceSchema).min(1) }),
  z.object({ type: z.literal("string"), title: z.string().optional(), description: z.string().optional() }),
]);

const FormSchema = z.object({
  message: z.string().optional(),
  requestedSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
});

/** One step of a form: its question and the field it is answered in. */
export interface FormStep {
  readonly key: string;
  /** The field the words go in when the person answers with their own, when the form has one. */
  readonly otherKey: string | undefined;
  readonly question: Question;
}

/** The steps of an `elicitation/create` form, in order; `undefined` when the form is not one niwa can ask. */
export function formSteps(params: unknown): FormStep[] | undefined {
  const parsed = FormSchema.safeParse(params);
  if (!parsed.success) return undefined;
  const properties = Object.entries(parsed.data.requestedSchema.properties);
  const keys = new Set(properties.map(([key]) => key));
  const otherOf = (key: string): string | undefined => (keys.has(`${key}__other`) ? `${key}__other` : undefined);
  const owned = new Set(properties.flatMap(([key]) => otherOf(key) ?? []));

  const steps: FormStep[] = [];
  for (const [key, value] of properties) {
    if (owned.has(key)) continue;
    const property = PropertySchema.safeParse(value);
    if (!property.success) return undefined;
    const shape = property.data;
    const title = shape.title ?? key;
    const detail = [parsed.data.message, shape.description].filter((part): part is string => part !== undefined && part !== "").join("\n");
    const wording = { title, ...(detail === "" ? {} : { detail }) };
    const otherKey = otherOf(key);
    if ("items" in shape || "oneOf" in shape) {
      const choices = "items" in shape ? shape.items.anyOf : shape.oneOf;
      const options: QuestionOption[] = choices.map((choice) => ({
        id: OptionIdSchema.parse(choice.const),
        label: choice.title ?? choice.const,
        ...(choice.description === undefined ? {} : { description: choice.description }),
        flavor: "plain",
      }));
      steps.push({ key, otherKey, question: { kind: "items" in shape ? "multi" : "choice", ...wording, options, allowOther: otherKey !== undefined } });
    } else {
      steps.push({ key, otherKey: undefined, question: { kind: "text", ...wording } });
    }
  }
  return steps.length === 0 ? undefined : steps;
}

/** The fields of the form an answer to one step fills; `undefined` when the step was left without an answer. */
export function formFields(step: FormStep, answer: Answer): Record<string, string | string[]> | undefined {
  if ("text" in answer) return { [step.otherKey ?? step.key]: answer.text };
  if (!("ids" in answer)) return undefined;
  const ids = pickedOptions(step.question, answer).map((option) => String(option.id));
  if (step.question.kind === "multi") return { [step.key]: ids };
  const [first] = ids;
  return first === undefined ? {} : { [step.key]: first };
}
