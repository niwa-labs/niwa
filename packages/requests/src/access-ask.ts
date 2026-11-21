/**
 * The question of an `ask` rule: a call that meets a rule that asks
 * becomes a request to the owner, and the call waits for its end.
 *
 * The core holds the call and the answers in force; this module only puts the question as a
 * request and says how it ended. Nobody answering, a cancel and an expiry are one thing: no answer.
 */

import type { z } from "zod";

import { ASK_SCOPES, OptionIdSchema, jsonOf, owner } from "@niwa-labs/core";
import type { Answer, AskOutcome, AskQuestion, Question, QuestionOption, Timestamp, Address } from "@niwa-labs/core";

import { Deadline, QuestionName } from "./records.ts";
import type { RequestCreated, RequestId } from "./records.ts";

/** The name of the question the owner is asked when a call meets a rule that asks. */
export const ACCESS_ASK = QuestionName.parse("access.ask");

/** What the owner may answer, as options: the three scopes that let the call through, and a refusal. */
const OPTIONS: readonly QuestionOption[] = [
  { id: OptionIdSchema.parse("once"), label: "Allow this call", flavor: "allow_once" },
  { id: OptionIdSchema.parse("run"), label: "Allow this action for the subject's lifetime", flavor: "allow_always" },
  { id: OptionIdSchema.parse("always"), label: "Allow always (written into its grant)", flavor: "allow_always" },
  { id: OptionIdSchema.parse("no"), label: "Refuse", flavor: "reject_once" },
];

/** What the owner is shown of a call: who calls what, with what, and under which rule. */
export function questionOf(asked: AskQuestion): Question {
  const action = `${asked.name}${asked.target === undefined ? "" : `@${asked.target}`}`;
  const who = `${asked.principal.kind}:${asked.principal.id}`;
  return {
    kind: "permission",
    title: `${who} calls ${action}`,
    options: [...OPTIONS],
    subject: {
      who,
      action,
      rule: asked.rule,
      input: jsonOf(asked.input),
      ...(asked.reason === undefined ? {} : { reason: asked.reason }),
    },
  };
}

/** How an answer to the question ends the wait of the call: only an answer of the owner lets it through. */
export function outcomeOf(answer: Answer): AskOutcome {
  const chosen = "ids" in answer && answer.ids.length === 1 ? answer.ids[0] : undefined;
  if (chosen === "no") return "refused";
  return ASK_SCOPES.find((scope) => scope === chosen) ?? "unanswered";
}

/** The calls that wait for the owner in this process, by the request that asks about them. */
export class PendingAsks {
  private readonly waiting = new Map<RequestId, (outcome: AskOutcome) => void>();

  /** Wait for the end of a request; the wait is the call's. */
  expect(id: RequestId): Promise<AskOutcome> {
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  /** A request that is not waited for any more. */
  forget(id: RequestId): void {
    this.waiting.delete(id);
  }

  /**
   * The request ended: the call that waited for it goes on or is denied. A request nobody waits for is left alone.
   *
   * An access ask ends only by an answer of the owner. An answer by anyone else, or by nobody the
   * binding knows, is no answer: the call is denied, whatever the answer says.
   */
  end(id: RequestId, outcome: AskOutcome, by?: Address): void {
    const resolve = this.waiting.get(id);
    if (resolve === undefined) return;
    this.waiting.delete(id);
    resolve(by?.kind === "owner" ? outcome : "unanswered");
  }
}

/** The request a question becomes, addressed to the owner and with a deadline of its own. */
export function requestOf(
  id: RequestId,
  asked: AskQuestion,
  now: Timestamp,
  timeoutMs: number,
): z.infer<typeof RequestCreated.schema> {
  return {
    id,
    to: owner,
    question: ACCESS_ASK,
    input: questionOf(asked),
    deadline: Deadline.parse(now + timeoutMs),
  };
}
