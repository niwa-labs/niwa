/**
 * Resolvers: a plugin may answer a request before it reaches its addressee. A request for the
 * owner reaches the resolvers first; if one already knows the answer the owner never sees the
 * question.
 *
 * A resolver runs after the request is in the journal, so one that dies leaves the request
 * open and the addressee still gets it. Its answer is written as a record by the module.
 * A resolver may run again when its work is replayed after a crash, so it should not have
 * effects of its own.
 */

import type { Answer, Question, Address } from "@niwa-labs/core";

import type { DeclaredQuestion } from "./question.ts";
import type { QuestionName } from "./records.ts";

/** A request as a resolver sees it. The id stays with the module. */
export interface ResolverRequest {
  readonly question: QuestionName;
  readonly input: Question;
  readonly to: Address;
  readonly from?: Address;
}

/**
 * How a resolver's answer came, and what it rests on.
 *
 * It is told apart from the answer itself: the answer is what the asker reads against its
 * question, and the way it was found is about the resolver, not about the answer.
 */
export interface ResolverInfo {
  /** How the answer was found: "recalled", and the like. */
  readonly how?: string;
  /** The area the answer was found for. */
  readonly area?: string;
  /** What the answer came from: the id of a decision, or of a record. */
  readonly source?: string;
}

/** An answer, or "no": the request goes on to its addressee. */
export type ResolverResult =
  | { readonly answered: true; readonly answer: Answer; readonly info?: ResolverInfo }
  | { readonly answered: false };

/** The code that may answer a question. */
export type Resolver = (request: ResolverRequest) => Promise<ResolverResult> | ResolverResult;

/**
 * The resolvers of one host, by question name or "*" for every question. The resolver of the
 * question has the first word; "*" is asked last.
 */
export class ResolverRegistry {
  private readonly exact = new Map<string, Resolver>();
  private fallback: Resolver | undefined;

  /** One resolver per question: two would make the answer depend on the order of registering. */
  register(question: DeclaredQuestion | "*", resolver: Resolver): void {
    if (question === "*") {
      if (this.fallback !== undefined) throw new Error("a resolver for every question is already registered");
      this.fallback = resolver;
      return;
    }
    if (this.exact.has(question.question)) {
      throw new Error(`a resolver for the question "${question.question}" is already registered`);
    }
    this.exact.set(question.question, resolver);
  }

  /** The resolvers to try, in order. */
  resolversFor(question: QuestionName): Resolver[] {
    const exact = this.exact.get(question);
    return [...(exact === undefined ? [] : [exact]), ...(this.fallback === undefined ? [] : [this.fallback])];
  }
}
