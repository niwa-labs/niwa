/**
 * The scope of the running invocation, and the names the invocation runtime shares with plugins.
 *
 * A plugin asks which invocation it runs in (`currentInvocation`), tells a suspend from a failure
 * (`isSuspend`), and names the pseudo-actions a wait, the clock and a random number record. The
 * runtime that runs invocations (invocation.ts, in the journal entry) writes the scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { actionName } from "./action.ts";
import { attemptRecordId } from "./outcome.ts";
import { PAUSE_CHOICES } from "./types.ts";
import type { ActionName, HandlerId, InvocationId, JournalReader, PauseChoice, RecordId, StepKey } from "./types.ts";

/** The running invocation: state reads and changes are recorded against it. */
export interface InvocationScope {
  /** The invocation this scope belongs to. */
  readonly invocation: InvocationId;
  /** The handler that runs in it. */
  readonly handler: HandlerId;
  /** The record that woke the invocation. */
  readonly cause: RecordId;
  /** The external input the chain started from. */
  readonly root: RecordId;
  /** How many state reads this invocation has made: the ordinal of the next one. */
  reads: number;
  /** How many state changes this invocation has made: the ordinal of the next one. */
  writes: number;
  /** Set when the invocation ends: code that outlives it must not touch state. */
  closed: boolean;
  /** Called before a state record of the invocation is written: a woken run says it runs first. */
  readonly writing: () => void;
}

/** The scope of the running invocation, or nothing when nothing is running. */
export const RUNNING = new AsyncLocalStorage<InvocationScope>();

/** The invocation that is running right now, or nothing when the code runs outside one. */
export function currentInvocation(): InvocationScope | undefined {
  return RUNNING.getStore();
}

/** A step key becomes part of record ids, so it obeys the rules of a record id. */
export function stepKey(value: string): StepKey {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`step key must be a non-empty string, got ${String(value)}`);
  }
  if (/\s/.test(value)) {
    throw new TypeError(`step key must not contain whitespace: ${JSON.stringify(value)}`);
  }
  // "/" and "#" are the separators of record ids and operation ids: a key holding one could
  // collide with the ids of another step's attempts.
  if (/[/#]/.test(value)) {
    throw new TypeError(`step key must not contain "/" or "#": ${JSON.stringify(value)}`);
  }
  return value as StepKey;
}

/** The name of the pseudo-action a wait records as its intent. */
export const WAIT_ACTION: ActionName = actionName("niwa.wait");

/**
 * What a pause offers: the choices it recorded (all three when it recorded none), less what cannot work.
 *
 * A wait is not a call, so it is only cancelled; a pause on no step (the handler threw) has no step to skip, and a
 * skip would only run it again, as a retry does. The one rule the core writes a pause with, `niwa.invocation.resolve`
 * holds an answer to, and a surface shows: older pauses that recorded more are read through it too.
 */
export function offeredChoices(
  journal: JournalReader,
  /** The invocation, as its id is read from a record. */
  invocation: InvocationId | string,
  paused: { readonly choices?: readonly string[] | undefined; readonly key?: string | undefined },
): PauseChoice[] {
  const recorded = paused.choices === undefined ? PAUSE_CHOICES : PAUSE_CHOICES.filter((choice) => paused.choices?.includes(choice));
  const key = paused.key === undefined || paused.key === "" ? undefined : stepKey(paused.key);
  const intent = key === undefined ? undefined : journal.get(attemptRecordId(invocation as InvocationId, key, 0, "intent"));
  const waited = (intent?.data as { action?: unknown } | undefined)?.action === WAIT_ACTION;
  return recorded.filter((choice) => choice === "cancel" || (!waited && (choice === "retry" || key !== undefined)));
}

/** The names of the pseudo-actions the clock and the random numbers record as their intent. */
export const NOW_ACTION: ActionName = actionName("niwa.now");
export const RANDOM_ACTION: ActionName = actionName("niwa.random");

/** The invocation suspends: it waits for a record that has not arrived yet. */
export class SuspendSignal extends Error {
  constructor() {
    super("waiting");
    this.name = "SuspendSignal";
  }
}

/**
 * Whether an error is the signal of a suspend.
 *
 * A call that waits for a record that has not arrived yet suspends the invocation it runs in.
 * The signal is passed through the calls above it, so a module that has a call of its own can
 * tell that the wait is not a failure of its own.
 */
export function isSuspend(error: unknown): boolean {
  return error instanceof SuspendSignal;
}
