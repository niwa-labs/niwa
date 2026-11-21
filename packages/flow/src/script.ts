/**
 * What the helpers take of the script they run in.
 *
 * A helper runs inside a workflow script and calls the script's own globals (`scope`, `agent`,
 * `ask`, ...), read when it is called: this package imports nothing of the script runtime, only its
 * types. Every helper opens a scope named by the key it is given, and the calls it makes are
 * unlabeled: they are keyed by the branch they are made in, so a replay finds each answer where it
 * left it, and a helper called again in the next round of a loop does not collide with the last.
 */

import type { SessionOptions, ScriptApi, Settled } from "@niwa-labs/script";

/** The globals of a script the helpers use. */
export type ScriptGlobals = Pick<ScriptApi, "z" | "session" | "call" | "scope" | "parallel" | "stream" | "wait" | "sleep" | "read" | "ask" | "now" | "random">;

const NEEDED = ["ask", "call", "scope", "parallel", "stream", "wait", "sleep", "now", "random"] as const;

/** The zod of the script: a global of every script process, whether it runs the script or reads its schemas. */
export function zod(): ScriptGlobals["z"] {
  const found = (globalThis as unknown as { z?: unknown }).z;
  if (typeof found !== "object" || found === null) throw new Error('@niwa-labs/flow runs inside a workflow script: "z" is not a global here');
  return found as ScriptGlobals["z"];
}

/** The globals of the script that calls a helper. */
export function script(): ScriptGlobals {
  const globals = globalThis as unknown as Partial<Record<string, unknown>>;
  for (const name of NEEDED) {
    if (typeof globals[name] !== "function") throw new Error(`@niwa-labs/flow runs inside a workflow script: "${name}" is not a global here`);
  }
  for (const name of ["z", "read"] as const) {
    if (typeof globals[name] !== "object" || globals[name] === null) throw new Error(`@niwa-labs/flow runs inside a workflow script: "${name}" is not a global here`);
  }
  return globals as unknown as ScriptGlobals;
}

/**
 * A key of a branch or the name of a scope, as the script runtime takes it: a text that is not
 * empty and holds none of the marks a step key is made of. A key is checked before anything
 * runs, so a bad one fails the call before its first effect.
 */
export function checkKey(key: unknown, what: string): string {
  if (typeof key !== "string" || key === "") throw new TypeError(`${what} is a text that is not empty`);
  if (/[.~/:\s]/.test(key) || key.startsWith("@") || /^call-\d+$/.test(key)) {
    throw new TypeError(`${what} "${key}" may not hold ".", "~", "/", ":" or a space, start with "@" or be call-<n>`);
  }
  return key;
}

/** Check a list of keys: each one a key, and no two the same. */
export function checkKeys(keys: readonly string[], what: string): string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    checkKey(key, what);
    if (seen.has(key)) throw new TypeError(`${what} "${key}" is given twice: a key names one branch`);
    seen.add(key);
  }
  return [...keys];
}

/**
 * A seat: who takes a part in a helper. A name of a harness, or the options of an `ask()` call
 * with the harness in them; `vendor` says whose model it is, for the helpers that want judges
 * independent of an author, and `label` is the seat's name in the results, never a call's label.
 */
export type Seat = string | SeatOptions;

/** A seat written out: the options of its `ask()` calls, with the harness, and who it is. */
export type SeatOptions = Omit<SessionOptions, "label" | "worktree"> & { harness: string; vendor?: string; label?: string };

/** The harness of a seat. */
export const harnessOf = (seat: Seat): string => (typeof seat === "string" ? seat : seat.harness);

/** Whose model a seat is: what it says, else its harness. */
export const vendorOf = (seat: Seat): string => (typeof seat === "string" ? seat : (seat.vendor ?? seat.harness));

/** The options of an `ask()` call of a seat: no label, which would name one call of the whole run, and no worktree. */
export function sessionOptions(seat: Seat): Omit<SessionOptions, "worktree"> {
  if (typeof seat === "string") return { harness: seat };
  const { vendor: _vendor, label: _label, ...options } = seat;
  return options;
}

/**
 * The keys of seats in the order given: the seat's label, else its harness; a seat met again is
 * numbered (`judge`, `judge-2`), so the same harness may sit twice. The names the seats were
 * given are kept as they are: a number is never one of them, so the keys are all different.
 */
export function seatKeys(seats: readonly Seat[], what: string): string[] {
  const names = seats.map((seat) => (typeof seat === "string" ? seat : (seat.label ?? seat.harness)));
  const taken = new Set(names);
  const counts = new Map<string, number>();
  return names.map((name) => {
    let count = (counts.get(name) ?? 0) + 1;
    if (count === 1) {
      counts.set(name, count);
      return checkKey(name, what);
    }
    let numbered = `${name}-${String(count)}`;
    while (taken.has(numbered)) {
      count += 1;
      numbered = `${name}-${String(count)}`;
    }
    counts.set(name, count);
    taken.add(numbered);
    return checkKey(numbered, what);
  });
}

/**
 * The errors no helper turns into a value: a call the grant refused, a budget spent, and a question
 * to the owner that was cancelled or went unanswered. A branch that ends with one throws it out of
 * the helper, and a worker that met one is not run again. Only `humanGate` turns the last two into
 * an outcome. A branch the scope cancelled ends as `Cancelled`, which is no such error.
 */
const FATAL = new Set(["Denied", "BudgetExceeded", "AskCancelled", "AskExpired"]);

/** Whether a failure is one no helper keeps as a value. */
export const isFatal = (error: { name: string }): boolean => FATAL.has(error.name);

/** Rethrow a fatal error a helper caught. */
export function rethrowFatal(error: unknown): void {
  if (error instanceof Error && isFatal(error)) throw error;
}

/** The error a failed outcome stands for. */
export function errorOf(settled: Settled<unknown> & { ok: false }): Error {
  return Object.assign(new Error(settled.error.message), { name: settled.error.name });
}
