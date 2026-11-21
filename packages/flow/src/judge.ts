/**
 * Judging: a gate of one judge, verification by several seats and lenses, and a panel that scores
 * candidates. A judge that fails to answer is an `INCONCLUSIVE` vote, never a pass, and a panel with
 * no judge independent of the author decides nothing.
 */

import { askSeat, map } from "./group.ts";
import { checkKey, harnessOf, isFatal, script, seatKeys, vendorOf } from "./script.ts";
import type { Seat } from "./script.ts";
import { VerdictSchema, passes } from "./types.ts";
import type { Finding, Judged, Verdict } from "./types.ts";

/** How many votes a verification needs to pass: every one, more than half, or at least a number. */
export type Require = "all" | "majority" | { atLeast: number };

/** A judgement that did not pass a gate. */
export class GateFailed extends Error {
  override name = "GateFailed";
  readonly judged: Judged;
  constructor(subject: string, judged: Judged) {
    super(`the gate on ${subject} did not pass: ${judged.verdict}${judged.findings.length === 0 ? "" : ` (${judged.findings.map((finding) => finding.title).join("; ")})`}`);
    this.judged = judged;
  }
}

/** The question put to a judge. */
function judgePrompt(subject: string, stance: "check" | "refute", lens: string | undefined): string {
  return [
    stance === "refute"
      ? "Try to refute the claim below. Look for what makes it wrong; it passes only if you cannot."
      : "Check the work below and judge whether it holds.",
    ...(lens === undefined ? [] : [`Judge it through this lens only: ${lens}.`]),
    "",
    subject,
    "",
    "Answer with a verdict: PASS when it holds, PASS+NOTES when it holds and you have remarks, FAIL when it does not, " +
      "INCONCLUSIVE when you cannot tell. List what you found, each with its evidence; a finding that must be fixed before the work is accepted blocks, any other is a note.",
  ].join("\n");
}

/** Ask one seat to judge: what it answers, or an `INCONCLUSIVE` vote when it could not answer. */
async function judgeBy(seat: Seat, subject: string, stance: "check" | "refute", lens: string | undefined): Promise<Judged> {
  const method = `${stance} by ${harnessOf(seat)}${lens === undefined ? "" : ` (${lens})`}`;
  const answer = await askSeat(seat, judgePrompt(subject, stance, lens), VerdictSchema());
  return { verdict: answer.verdict, findings: answer.findings, method };
}

/** How many votes are needed out of `n`. */
function needed(require: Require, n: number): number {
  if (require === "all") return n;
  if (require === "majority") return Math.floor(n / 2) + 1;
  if (!Number.isInteger(require.atLeast) || require.atLeast < 1) throw new TypeError(`require.atLeast is a whole number, at least one, not ${String(require.atLeast)}`);
  return require.atLeast;
}

/**
 * The verdict of votes: a pass when enough votes pass (with notes when any passing vote has some), a
 * fail when too many failed for that to happen, and `INCONCLUSIVE` otherwise or with no vote.
 */
export function tally(votes: readonly Judged[], require: Require, method: string): Judged {
  const findings: Finding[] = votes.flatMap((vote) => vote.findings);
  if (votes.length === 0) return { verdict: "INCONCLUSIVE", findings, method };
  const need = needed(require, votes.length);
  const passing = votes.filter(passes);
  const failing = votes.filter((vote) => vote.verdict === "FAIL").length;
  let verdict: Verdict;
  if (need > votes.length) verdict = "INCONCLUSIVE";
  else if (passing.length >= need) verdict = passing.some((vote) => vote.verdict === "PASS+NOTES" || vote.findings.length > 0) ? "PASS+NOTES" : "PASS";
  else if (votes.length - failing < need) verdict = "FAIL";
  else verdict = "INCONCLUSIVE";
  return { verdict, findings, method };
}

/**
 * Have one seat judge a subject. A judgement that does not pass throws `GateFailed`, unless
 * `onFail: "return"`.
 */
export async function gate(key: string, opts: { subject: string; by: Seat; onFail?: "throw" | "return" }): Promise<Judged> {
  checkKey(key, "the key of a gate");
  const judged = await script().scope(key, undefined, async () => {
    try {
      return await judgeBy(opts.by, opts.subject, "check", undefined);
    } catch (error) {
      if (error instanceof Error && isFatal(error)) throw error;
      return { verdict: "INCONCLUSIVE" as const, findings: [], method: `check by ${harnessOf(opts.by)}: no answer (${error instanceof Error ? error.message : String(error)})` };
    }
  });
  if (!passes(judged) && (opts.onFail ?? "throw") === "throw") throw new GateFailed(opts.subject, judged);
  return judged;
}

/**
 * Have seats judge a subject, each through each lens, and count the votes as `require` says (every
 * vote by default). `stance: "refute"` asks each judge to break the claim. A seat that shares the
 * harness of `notAuthor` does not judge: with none left, the verdict is `INCONCLUSIVE`.
 */
export async function verify(
  key: string,
  opts: { subject: string; by: readonly Seat[]; lenses?: readonly string[]; stance?: "check" | "refute"; require?: Require; notAuthor?: Seat },
): Promise<Judged & { votes: Judged[] }> {
  checkKey(key, "the key of a verification");
  const stance = opts.stance ?? "check";
  const require = opts.require ?? "all";
  const seats = opts.notAuthor === undefined ? [...opts.by] : opts.by.filter((seat) => harnessOf(seat) !== harnessOf(opts.notAuthor as Seat));
  const keys = seatKeys(seats, "the key of a seat");
  const lenses = opts.lenses === undefined || opts.lenses.length === 0 ? [undefined] : [...opts.lenses];
  const legs = seats.flatMap((seat, at) => lenses.map((lens, index) => ({ seat, lens, key: lens === undefined ? (keys[at] as string) : `${keys[at] as string}-l${String(index + 1)}` })));
  const outcomes = await map(key, legs, { key: (leg) => leg.key }, (leg) => judgeBy(leg.seat, opts.subject, stance, leg.lens));
  const votes = outcomes.map((outcome, index): Judged =>
    outcome.ok ? outcome.value : { verdict: "INCONCLUSIVE", findings: [], method: `${stance} by ${harnessOf((legs[index] as { seat: Seat }).seat)}: no answer (${outcome.error.message})` },
  );
  const rule = typeof require === "string" ? require : `at least ${String(require.atLeast)}`;
  return { ...tally(votes, require, `verify (${stance}, ${rule}) by ${String(votes.length)} vote${votes.length === 1 ? "" : "s"}`), votes };
}

/** Where a panel's winner stands: its mean score against the thresholds, or `INCONCLUSIVE` with no winner. */
export type Band = "PASS" | "WARNING" | "REVISE" | "INCONCLUSIVE";

/** Who judged in a panel: the seat's key, its harness, model and vendor. */
export type PanelJudge = { seat: string; harness: string; model?: string; vendor: string };

/** The labels a blind panel shows: A, B, ..., Z, AA, AB, ... */
export function blindLabel(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}

/**
 * The decision of a panel from the scores each judge gave: a judge votes for its highest score (a
 * tie is no vote). `majority` needs more than half of the judges that voted, `unanimous` all of the
 * judges that answered.
 */
export function decidePanel(
  candidates: readonly string[],
  sheets: readonly Record<string, number>[],
  rule: "majority" | "unanimous",
  thresholds: { pass: number; warn: number },
): { winner: string | null; scores: Record<string, number[]>; split: boolean; band: Band } {
  const scores: Record<string, number[]> = Object.fromEntries(candidates.map((candidate) => [candidate, [] as number[]]));
  const votes = new Map<string, number>();
  for (const sheet of sheets) {
    for (const candidate of candidates) {
      const score = sheet[candidate];
      if (typeof score === "number") (scores[candidate] as number[]).push(score);
    }
    const top = Math.max(...candidates.map((candidate) => sheet[candidate] ?? Number.NEGATIVE_INFINITY));
    const leaders = candidates.filter((candidate) => sheet[candidate] === top);
    if (leaders.length === 1) votes.set(leaders[0] as string, (votes.get(leaders[0] as string) ?? 0) + 1);
  }
  if (sheets.length === 0) return { winner: null, scores, split: false, band: "INCONCLUSIVE" };
  const need = rule === "unanimous" ? sheets.length : Math.floor(sheets.length / 2) + 1;
  const winner = [...votes].find(([, count]) => count >= need)?.[0] ?? null;
  if (winner === null) return { winner, scores, split: true, band: "INCONCLUSIVE" };
  const given = scores[winner] as number[];
  const mean = given.reduce((sum, score) => sum + score, 0) / given.length;
  const band: Band = mean >= thresholds.pass ? "PASS" : mean >= thresholds.warn ? "WARNING" : "REVISE";
  return { winner, scores, split: false, band };
}

/**
 * Judges score every candidate from 0 to 100 against a rubric; the rule picks the winner and its
 * mean score the band (85 and above PASS, 75 and above WARNING, else REVISE by default). With
 * `blind` a judge sees labels, not the candidates' names. A judge of `authorVendor` does not judge,
 * and with `distinctVendors` only the first judge of each vendor does: when none is left, the panel
 * is `INCONCLUSIVE`.
 */
export async function panel<C>(
  key: string,
  opts: {
    candidates: Record<string, C>;
    judges: readonly Seat[];
    rubric: readonly string[];
    rule?: "majority" | "unanimous";
    thresholds?: { pass: number; warn: number };
    distinctVendors?: boolean;
    blind?: boolean;
    authorVendor?: string;
  },
): Promise<{ winner: string | null; scores: Record<string, number[]>; split: boolean; band: Band; judges: PanelJudge[] }> {
  checkKey(key, "the key of a panel");
  const names = Object.keys(opts.candidates);
  if (names.length === 0) throw new TypeError(`panel "${key}": give at least one candidate`);
  const seen = new Set<string>();
  const seats = opts.judges.filter((seat) => {
    const vendor = vendorOf(seat);
    if (opts.authorVendor !== undefined && vendor === opts.authorVendor) return false;
    if (opts.distinctVendors === true) {
      if (seen.has(vendor)) return false;
      seen.add(vendor);
    }
    return true;
  });
  const keys = seatKeys(seats, "the key of a judge");
  const judges = seats.map((seat, index): PanelJudge => ({
    seat: keys[index] as string,
    harness: harnessOf(seat),
    vendor: vendorOf(seat),
    ...(typeof seat !== "string" && seat.model !== undefined ? { model: seat.model } : {}),
  }));
  const thresholds = opts.thresholds ?? { pass: 85, warn: 75 };
  if (seats.length === 0) return { ...decidePanel(names, [], opts.rule ?? "majority", thresholds), judges };

  const shown = names.map((name, index) => (opts.blind === true ? blindLabel(index) : name));
  const { z } = script();
  const sheet = z.object({ scores: z.record(z.string(), z.number().min(0).max(100)) });
  const prompt = [
    "Score each candidate below from 0 to 100 against the rubric. Answer with a score for every candidate, by its name as shown.",
    "",
    "Rubric:",
    ...opts.rubric.map((line) => `- ${line}`),
    "",
    ...names.flatMap((name, index) => {
      const value = opts.candidates[name];
      return [`## ${shown[index] as string}`, typeof value === "string" ? value : JSON.stringify(value, null, 2), ""];
    }),
  ].join("\n");
  const outcomes = await map(key, seats.map((seat, index) => ({ seat, key: keys[index] as string })), { key: (one) => one.key }, (one) => askSeat(one.seat, prompt, sheet));
  const sheets = outcomes.flatMap((outcome) =>
    outcome.ok ? [Object.fromEntries(names.map((name, index) => [name, outcome.value.scores[shown[index] as string]]).filter(([, score]) => typeof score === "number"))] : [],
  ) as Record<string, number>[];
  return { ...decidePanel(names, sheets, opts.rule ?? "majority", thresholds), judges };
}
