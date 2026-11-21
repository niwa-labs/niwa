/**
 * The types the helpers share: how a piece of work was judged, and what a loop that judges its work
 * gives back. `Attempt` is also a function: the zod schema of an attempt, for a script's `output`.
 */

import type { Settled } from "@niwa-labs/script";
import type { z } from "zod";

import { zod } from "./script.ts";

export type { Settled };

/** How a piece of work was judged. `INCONCLUSIVE` is not a pass. */
export type Verdict = "PASS" | "PASS+NOTES" | "FAIL" | "INCONCLUSIVE";

export const VERDICTS = ["PASS", "PASS+NOTES", "FAIL", "INCONCLUSIVE"] as const;

/** One thing a judge found: what, why it holds, and whether it blocks the work. */
export type Finding = { title: string; evidence: string; severity: "blocks" | "note" };

/** A judgement: the verdict, what was found, and how it was reached. */
export type Judged = { verdict: Verdict; findings: Finding[]; method: string };

/** What a branch that failed is: its error by name and message. */
export type FlowError = { name: string; message: string };

/** A piece of work a loop wrote and judged: the last value, its judgement, the rounds and why the loop stopped. */
export type Attempt<T> = { value: T; judged: Judged; rounds: number; history: Judged[]; stopped: "accepted" | "max-rounds" };

/** Whether a verdict lets the work through. */
export const passes = (judged: { verdict: Verdict }): boolean => judged.verdict === "PASS" || judged.verdict === "PASS+NOTES";

/** The schema of a finding, made with the script's zod. */
export function FindingSchema() {
  const z = zod();
  return z.object({ title: z.string(), evidence: z.string(), severity: z.enum(["blocks", "note"]) });
}

/** The schema of what a judge answers: a verdict and the findings. */
export function VerdictSchema() {
  const z = zod();
  return z.object({ verdict: z.enum(VERDICTS), findings: z.array(FindingSchema()) });
}

/** The schema of a judgement, with the votes `verify` keeps beside it. */
export function JudgedSchema() {
  const z = zod();
  const judged = VerdictSchema().extend({ method: z.string() });
  return judged.extend({ votes: z.array(judged).optional() });
}

/** The schema of an attempt whose value `value` describes: what a script that returns an attempt names as its `output`. */
export function Attempt<S extends z.ZodType>(value: S) {
  const z = zod();
  return z.object({
    value,
    judged: JudgedSchema(),
    rounds: z.number().int().nonnegative(),
    history: z.array(JudgedSchema()),
    stopped: z.enum(["accepted", "max-rounds"]),
  });
}
