/**
 * Routes a permission answer to the insert side that asked the question.
 *
 * A question is identified by its harness, its session and the harness's own request id, so two
 * harnesses that reuse an id never receive each other's answers. An answer is delivered once.
 *
 * The router holds the live routing only: which side to call. It keeps no answer of its own and
 * no record of what was decided — the journal holds that.
 */

import { z } from "zod";

import type { HarnessId, HarnessInsert, PermissionAnswer, PermissionAskedEvent, SessionId } from "@niwa-labs/harness";

/**
 * The id of a permission question.
 *
 * It is a function of the harness, the session and the harness's own request id, so the same
 * question is the same id wherever it is named — the request that asks the owner, the step that
 * waits for the answer and the routing that carries it.
 */
export const PermissionIdSchema = z.string().min(1).brand<"PermissionId">();
export type PermissionId = z.output<typeof PermissionIdSchema>;

export class PermissionRouter {
  /** The side of each harness: it carries the answers to the questions that harness asked. */
  private readonly sides = new Map<HarnessId, HarnessInsert>();
  /** The side that waits for each question. */
  private readonly asked = new Map<PermissionId, HarnessInsert>();

  /** The side of a harness. It is asked the questions of that harness and answers them. */
  register(harness: HarnessId, side: HarnessInsert): void {
    this.sides.set(harness, side);
  }

  /** The side that serves a session, when there is one. */
  sideOf(session: SessionId): HarnessInsert | undefined {
    return this.sides.get(session.harness);
  }

  /** Remember which side asked. */
  ask(side: HarnessInsert, event: PermissionAskedEvent): void {
    this.asked.set(permissionId(event.session, event.requestId), side);
  }

  /** Deliver the answer to the side that asked; refuse a question nobody is waiting on. */
  async answer(session: SessionId, answer: PermissionAnswer): Promise<void> {
    const key = permissionId(session, answer.requestId);
    const side = this.asked.get(key);
    if (side === undefined) {
      throw new Error(`no pending permission question "${answer.requestId}" in ${session.harness}`);
    }
    if (side.answerPermission === undefined) {
      throw new Error(`the side that asked "${answer.requestId}" cannot carry answers`);
    }
    this.asked.delete(key);
    await side.answerPermission(answer);
  }
}

/**
 * The id of a permission question: the harness, the session and the harness's own request id.
 *
 * It is the same id wherever the question is named — the request that asks the owner, the step
 * that waits for the answer and the routing that carries it — so the journal says which question
 * a record is about.
 */
export function permissionId(session: SessionId, requestId: string): PermissionId {
  return PermissionIdSchema.parse(
    [session.harness, session.native, requestId].map(part).join(":"),
  );
}

/**
 * One part of an id.
 *
 * A part may hold anything the harness calls a session or a request, so what would break the id
 * is written as it is: the separator of the id, and what a step key and a record id refuse.
 */
function part(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}
