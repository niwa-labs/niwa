/**
 * A question, declared: a name and the question itself. It is not
 * a fact that happened: the same question is asked many times, each time with its own request.
 * The format of the question is the one of the whole system (`QuestionSchema` in `@niwa-labs/core`).
 */

import type { z } from "zod";

import { QuestionSchema } from "@niwa-labs/core";
import type { Question, QuestionInput } from "@niwa-labs/core";

import { QuestionName } from "./records.ts";
import type { RequestId } from "./records.ts";

/** A question with its name: what `request.ask` takes as `{ question, input }`. */
export interface DeclaredQuestion {
  /** The name the journal, the resolvers and the decisions of the owner know the question by. */
  readonly question: QuestionName;
  /** The question, whole. */
  readonly input: Question;
}

/** `question("release.branch", { kind: "choice", title, options })`: a question with a name. */
export function question(name: string, spec: QuestionInput): DeclaredQuestion {
  return { question: QuestionName.parse(name), input: QuestionSchema.parse(spec) };
}

/**
 * The checks of the asks this process waits on, by request.
 *
 * The question says what a form's value must look like in JSON Schema, which cannot say a
 * refinement. While an ask waits here, the zod schema of its value is held and checks the value
 * whole, so an answer that fails a refinement is refused when it is given and not written.
 */
const held = new Map<RequestId, z.ZodType<unknown>>();

/** Hold the zod schema of the value of a form while its ask waits. */
export function holdAnswerCheck(request: RequestId, schema: z.ZodType<unknown>): void {
  held.set(request, schema);
}

/** The ask stopped waiting: its check is not held any more. */
export function releaseAnswerCheck(request: RequestId): void {
  held.delete(request);
}

/** The schema of the value of the form of a request whose ask waits in this process. */
export function heldAnswerCheckOf(request: RequestId): z.ZodType<unknown> | undefined {
  return held.get(request);
}
