/**
 * Calls a client names with an operation id of its own.
 *
 * A client that lost its connection while a call was on its way cannot tell whether the call was
 * made. It asks again under the same id: the same action with the same input answers what the
 * first call answered, from the journal, and is not made a second time; another call under the id
 * is a conflict. The id is the caller's: the action runs under an operation id made from the caller
 * and its id, so two callers never share one, and an action that keys its own work by the operation
 * id (a send into a session) sees the same id on every retry.
 *
 * Only a call that began is written down: one the grant or the schema refused did nothing, and may
 * be asked again with any body. A call that ended is answered as it ended, whole. A failure the
 * action said did nothing (`effectPossible: false`) is made again, and so is any failure or cut-off
 * of an action that may be repeated; an action that may not be repeated answers its failure again,
 * and a call of it that was cut off before its end is refused, since nobody knows what it did.
 */

import { createHash } from "node:crypto";

import type { ActionName, Caller, NewRecord, OperationId, RecordTypeName, Recovery, StoredRecord } from "@niwa-labs/core";
import { CORE_TYPES, newRecordId, stableJson, streamId } from "@niwa-labs/core";

/** A retry under an operation id the journal cannot answer as asked. */
export class OperationRefusal extends Error {
  constructor(
    readonly code: "operation-conflict" | "operation-unknown",
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}

/** How a call under an operation ended, as the journal keeps it. */
type Settled =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: string; code?: string; effectPossible: boolean };

interface Began {
  operation: OperationId;
  action: ActionName;
  digest: string;
}

/** What the operations need of the host: the records of an operation, and a way to commit records. */
export interface OperationsHost {
  /** The records of a type written under an operation id, oldest first. */
  find(type: RecordTypeName, operation: OperationId): StoredRecord[];
  commit(records: NewRecord[]): void;
}

/** The operation id a caller's own id stands for. */
export function operationOf(caller: Caller, operation: string): OperationId {
  const who = caller.kind !== "client" ? caller.kind : caller.principal === undefined ? `client:${caller.id}` : `${caller.principal.kind}:${caller.principal.id}`;
  return `cop_${createHash("sha256").update(`${who}\0${operation}`).digest("hex").slice(0, 40)}` as OperationId;
}

/** An error the first call ended with, given again. */
function answered(settled: Extract<Settled, { status: "failed" }>): Error {
  const error = new Error(settled.error);
  if (settled.code !== undefined) error.name = settled.code;
  return error;
}

export class CallOperations {
  /** The calls under an operation that are running now: a retry waits for the one running. */
  private readonly running = new Map<OperationId, { digest: string; answer: Promise<unknown> }>();

  constructor(private readonly host: OperationsHost) {}

  /**
   * Make a call under the caller's operation id once. `run` makes the call under the id, and says
   * when the action itself begins; a call that is refused before that is not written down.
   */
  async once(
    caller: Caller,
    given: string,
    action: ActionName,
    input: unknown,
    recovery: Recovery | undefined,
    run: (operation: OperationId, began: () => void) => Promise<unknown>,
  ): Promise<unknown> {
    const operation = operationOf(caller, given);
    const digest = createHash("sha256").update(stableJson([action, input ?? null])).digest("hex");
    const conflict = (): OperationRefusal =>
      new OperationRefusal("operation-conflict", `operation "${given}" was another call: an id names one call, with one action and one input`);

    const running = this.running.get(operation);
    if (running !== undefined) {
      if (running.digest !== digest) throw conflict();
      return running.answer;
    }
    const began = this.host.find(CORE_TYPES.callBegan, operation).at(-1)?.data as Began | undefined;
    if (began !== undefined) {
      if (began.digest !== digest) throw conflict();
      const settled = (this.host.find(CORE_TYPES.callSettled, operation).at(-1)?.data as { outcome: Settled } | undefined)?.outcome;
      if (settled?.status === "completed") return settled.value;
      const repeatable = recovery === "repeat" || recovery === "repeat-with-key";
      if (settled !== undefined && settled.effectPossible && !repeatable) throw answered(settled);
      if (settled === undefined && !repeatable) {
        throw new OperationRefusal("operation-unknown", `operation "${given}" was cut off before ${action} ended: it may have been done, and it is not made again`);
      }
    }

    const answer = this.made(caller, operation, action, digest, run);
    this.running.set(operation, { digest, answer });
    try {
      return await answer;
    } finally {
      this.running.delete(operation);
    }
  }

  private async made(
    caller: Caller,
    operation: OperationId,
    action: ActionName,
    digest: string,
    run: (operation: OperationId, began: () => void) => Promise<unknown>,
  ): Promise<unknown> {
    let began = false;
    const settle = (outcome: Settled): void => {
      if (began) this.host.commit([this.record(caller, CORE_TYPES.callSettled, { operation, action, digest, outcome })]);
    };
    try {
      const value = await run(operation, () => {
        began = true;
        this.host.commit([this.record(caller, CORE_TYPES.callBegan, { operation, action, digest } satisfies Began)]);
      });
      settle({ status: "completed", value: value ?? null });
      return value;
    } catch (error) {
      const said = (error as { effectPossible?: unknown } | undefined)?.effectPossible;
      settle({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { code: error.name } : {}),
        effectPossible: said !== false,
      });
      throw error;
    }
  }

  private record(caller: Caller, type: (typeof CORE_TYPES)["callBegan" | "callSettled"], data: unknown): NewRecord {
    const id = newRecordId("cop");
    return { id, stream: streamId("calls"), type, schema: 1, data, actor: caller, cause: null, root: id };
  }
}
