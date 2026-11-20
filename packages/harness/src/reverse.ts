/**
 * Reverse requests: what an agent asks of its client in the middle of a turn — permission to run
 * a tool, a question for a person.
 *
 * This is the whole of what a harness adapter sees. The adapter turns the harness's own request
 * into a `Question` (the question format of the core contracts), hands it over with the raw request, and gets an `Answer` back,
 * which it turns into the harness's own reply. Where the answer comes from (a grant, niwa's own
 * memory of an "allow always", the one who started the session) is the sessions module's business
 * and never the adapter's.
 */

import type { Answer, Question } from "@niwa-labs/core";

import type { SessionId } from "./reading.ts";

/** What an adapter hands over: the question in niwa's format, and the harness's own request as it came. */
export interface ReverseRequest {
  readonly question: Question;
  /** The harness's request whole: the method it came with and its parameters. Kept in the journal. */
  readonly raw: { readonly method: string; readonly params: unknown };
  /**
   * Aborted when the harness no longer waits for the answer: it cancelled the request, ended the
   * turn, or went away. The question is then closed and the answer is not wanted.
   */
  readonly signal: AbortSignal;
}

/**
 * What a control side calls for each reverse request of a session. It always resolves: an
 * answer, or `{ cancelled: true }` when none will come, so a turn never hangs on it.
 */
export type ReverseHandler = (session: SessionId, request: ReverseRequest) => Promise<Answer>;
