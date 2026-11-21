/**
 * Reverse requests of the Claude Agent SDK.
 *
 * The SDK asks its client through one callback, `canUseTool`: a tool wants leave to run, and
 * `AskUserQuestion` is one of those tools, its questions in the input and its answers going back
 * in the `updatedInput`. This module turns both into niwa's common questions and the answers back
 * into the SDK's results. It never uses the SDK's own persistence (`updatedPermissions`): "allow
 * always" is niwa's.
 */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Answer, Question, QuestionOption } from "@niwa-labs/core";
import { allowsTool, OptionIdSchema, pickedOptions, stableJson } from "@niwa-labs/core";

/** How much of a tool's input a question shows as its detail. */
const DETAIL_CHARS = 500;

/** What the SDK hands `canUseTool` besides the tool and its input. */
type Context = Parameters<CanUseTool>[2];

/** The two options of a permission: the SDK has no others to offer once "always" is niwa's. */
const ALLOW: QuestionOption = { id: OptionIdSchema.parse("allow"), label: "Allow", flavor: "allow_once" };
const REJECT: QuestionOption = { id: OptionIdSchema.parse("reject"), label: "Reject", flavor: "reject_once" };

/** What a tool does, as Claude Code's own tool calls name it, so the same request is the same key in both kinds. */
const TOOL_KINDS: Readonly<Record<string, string>> = {
  Bash: "execute",
  PowerShell: "execute",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

/** The inputs that name a path, in the order they are looked for. */
const PATH_FIELDS = ["file_path", "notebook_path", "path"] as const;

/** The harness's request as it came: the arguments of `canUseTool`, kept whole. */
export function rawRequest(tool: string, input: Record<string, unknown>, context: Context): { method: string; params: unknown } {
  const { signal: _signal, ...rest } = context;
  return { method: "canUseTool", params: { toolName: tool, input, ...rest } };
}

/** The permission question: the tool, what it acts on, and the once-only options. */
export function permissionQuestion(tool: string, input: Record<string, unknown>, context: Context): Question {
  const path = PATH_FIELDS.map((field) => input[field]).find((value): value is string => typeof value === "string" && value !== "");
  const target = path ?? context.blockedPath ?? stableJson(input);
  return {
    kind: "permission",
    title: context.title ?? `Use ${tool}`,
    detail: (context.description ?? stableJson(input)).slice(0, DETAIL_CHARS),
    options: [ALLOW, REJECT],
    // A tool that is not one of Claude Code's own is its own kind, so two tools do not share a key.
    subject: { tool, kind: TOOL_KINDS[tool] ?? tool, target },
  };
}

/** The result for a permission answer: allow runs the tool as it was asked; anything else refuses it, once. */
export function permissionResult(question: Question, answer: Answer, input: Record<string, unknown>): PermissionResult {
  if (allowsTool(question, answer)) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "cancelled" in answer ? "the request was not answered" : "the user refused the tool" };
}

/** The questions of one AskUserQuestion call. */
const QuestionsInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(1),
      }),
    )
    .min(1),
});

/** One question of an AskUserQuestion call, as niwa's question, with the text the SDK keys its answer by. */
export interface AskedQuestion {
  readonly key: string;
  readonly question: Question;
}

/** The niwa questions of an AskUserQuestion input, or `undefined` when the input is not one. */
export function questionsOf(input: Record<string, unknown>): readonly AskedQuestion[] | undefined {
  const parsed = QuestionsInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return parsed.data.questions.map((asked) => ({
    key: asked.question,
    question: {
      kind: asked.multiSelect === true ? "multi" : "choice",
      title: asked.question,
      ...(asked.header === undefined ? {} : { detail: asked.header }),
      options: asked.options.map((option, index) => ({
        id: OptionIdSchema.parse(`option-${index + 1}`),
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        flavor: "plain",
      })),
      allowOther: true,
    },
  }));
}

/**
 * The value the tool takes for an answer: the labels picked (a multi-select's joined by a comma,
 * as the tool takes them), or the words given instead; `undefined` when nothing was answered.
 */
export function answerText(question: Question, answer: Answer): string | undefined {
  if ("text" in answer) return answer.text;
  if ("ids" in answer) {
    const labels = pickedOptions(question, answer).map((option) => option.label);
    return labels.length === 0 ? undefined : labels.join(", ");
  }
  return undefined;
}
