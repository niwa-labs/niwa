/**
 * Workflow helpers for evaluation: blind candidate sets, rubric grading by graders independent of
 * the candidate, suites of cases over variants, and checks of what a session opened. They run on
 * the globals of a script, like the helpers of `@niwa-labs/flow`, and each opens a scope named by
 * its key. An evaluation of work in a repository imports `@niwa-labs/flow-code` itself.
 */

import { askSeat, blindLabel, checkKey, checkKeys, map, script, seatKeys, vendorOf } from "@niwa-labs/flow";
import type { Seat, Verdict } from "@niwa-labs/flow";

/** One line of a rubric: its id, and what it asks of the subject. */
export type RubricItem = { id: string; text: string };

/**
 * Candidates under labels a judge cannot read anything into: A, B, C in an order drawn with the
 * script's `random()`, which the run records, so a replay labels them the same. `reveal` names the
 * candidate behind a label.
 */
export async function blindSet<C>(key: string, candidates: Record<string, C>): Promise<{ labeled: Record<string, C>; reveal: (label: string) => string }> {
  checkKey(key, "the key of a blind set");
  const names = Object.keys(candidates);
  const g = script();
  const order = await g.scope(key, undefined, async () => {
    const shuffled = [...names];
    // Fisher-Yates over recorded draws.
    for (let at = shuffled.length - 1; at > 0; at -= 1) {
      const pick = Math.floor((await g.random()) * (at + 1));
      [shuffled[at], shuffled[pick]] = [shuffled[pick] as string, shuffled[at] as string];
    }
    return shuffled;
  });
  const labeled: Record<string, C> = {};
  const behind = new Map<string, string>();
  order.forEach((name, index) => {
    const label = blindLabel(index);
    labeled[label] = candidates[name] as C;
    behind.set(label, name);
  });
  return {
    labeled,
    reveal: (label) => {
      const name = behind.get(label);
      if (name === undefined) throw new Error(`blindSet "${key}": "${label}" is not a label of the set`);
      return name;
    },
  };
}

/**
 * Whether a rubric item passes on the scores the graders gave it: a score of 0.5 or more is a pass,
 * and the item passes by the rule (more than half of the graders, or all of them).
 */
export function itemPasses(scores: readonly number[], rule: "majority" | "unanimous"): boolean {
  const passing = scores.filter((score) => score >= 0.5).length;
  return scores.length > 0 && (rule === "unanimous" ? passing === scores.length : passing * 2 > scores.length);
}

/**
 * Grade a subject against a rubric, each item from 0 to 1, by graders of another vendor than the
 * candidate's: a grader of the candidate's vendor does not grade. The verdict is a pass when every
 * item passes by the rule (majority by default), a fail otherwise, and `INCONCLUSIVE` with no
 * independent grader or no answer.
 */
export async function gradeCase<S>(
  key: string,
  opts: { subject: S; rubric: readonly RubricItem[]; graders: readonly Seat[]; candidateVendor: string; rule?: "majority" | "unanimous" },
): Promise<{ scores: Record<string, number>; legs: { grader: Seat; scores: Record<string, number> }[]; verdict: Verdict }> {
  checkKey(key, "the key of a grade");
  checkKeys(
    opts.rubric.map((item) => item.id),
    "the id of a rubric item",
  );
  const graders = opts.graders.filter((seat) => vendorOf(seat) !== opts.candidateVendor);
  if (graders.length === 0) return { scores: {}, legs: [], verdict: "INCONCLUSIVE" };
  const keys = seatKeys(graders, "the key of a grader");
  const { z } = script();
  const sheet = z.object({ scores: z.record(z.string(), z.number().min(0).max(1)) });
  const subject = typeof opts.subject === "string" ? opts.subject : JSON.stringify(opts.subject, null, 2);
  const prompt = [
    "Grade the subject below against each item of the rubric, from 0 (not at all) to 1 (fully). Answer with a score for every item, by its id.",
    "",
    "Rubric:",
    ...opts.rubric.map((item) => `- ${item.id}: ${item.text}`),
    "",
    "Subject:",
    subject,
  ].join("\n");
  const answers = await map(key, graders.map((grader, index) => ({ grader, key: keys[index] as string })), { key: (one) => one.key }, (one) => askSeat(one.grader, prompt, sheet));
  const legs = answers.flatMap((answer, index) =>
    answer.ok
      ? [{ grader: graders[index] as Seat, scores: Object.fromEntries(opts.rubric.flatMap((item) => (typeof answer.value.scores[item.id] === "number" ? [[item.id, answer.value.scores[item.id] as number]] : []))) }]
      : [],
  );
  if (legs.length === 0) return { scores: {}, legs, verdict: "INCONCLUSIVE" };
  const scores: Record<string, number> = {};
  let all = true;
  for (const item of opts.rubric) {
    const given = legs.flatMap((leg) => (item.id in leg.scores ? [leg.scores[item.id] as number] : []));
    if (given.length > 0) scores[item.id] = given.reduce((sum, score) => sum + score, 0) / given.length;
    if (!itemPasses(given, opts.rule ?? "majority")) all = false;
  }
  return { scores, legs, verdict: all ? "PASS" : "FAIL" };
}

/** The mean of the scores of a grade, or 0 with none. */
const meanOf = (scores: Record<string, number>): number => {
  const values = Object.values(scores);
  return values.length === 0 ? 0 : values.reduce((sum, score) => sum + score, 0) / values.length;
};

/** The single best of named numbers, or null on a tie at the top or with none. */
export function bestOf(values: Record<string, number>): string | null {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  const top = Math.max(...entries.map(([, value]) => value));
  const leaders = entries.filter(([, value]) => value === top);
  return leaders.length === 1 ? (leaders[0] as [string, number])[0] : null;
}

/**
 * Run every case on every variant and grade each output against the rubric. `dir` is the cell's
 * own path, `<variant>/<case>`, for a run that keeps what it makes apart. A variant whose output is
 * graded is the candidate, so `vendorOf` names its vendor when graders of that vendor must not grade it.
 * `table[variant][case]` is the mean score; `perCase` the best variant of each case and
 * `recommend` the best variant overall, null on a tie.
 */
export async function evalSuite<V, O>(
  key: string,
  opts: {
    cases: readonly { id: string; prompt: string }[];
    variants: Record<string, V>;
    run: (variant: V, c: { id: string; prompt: string }, dir: string) => Promise<O>;
    rubric: readonly RubricItem[];
    graders: readonly Seat[];
    vendorOf?: (variant: string) => string;
    concurrency?: number;
  },
): Promise<{ table: Record<string, Record<string, number>>; perCase: Record<string, string | null>; recommend: string | null }> {
  checkKey(key, "the key of a suite");
  const variants = checkKeys(Object.keys(opts.variants), "the name of a variant");
  checkKeys(
    opts.cases.map((one) => one.id),
    "the id of a case",
  );
  const cells = variants.flatMap((variant) => opts.cases.map((one) => ({ variant, case: one, key: `${variant}-${one.id}` })));
  const graded = await map(key, cells, { key: (cell) => cell.key, ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, async (cell) => {
    const output = await opts.run(opts.variants[cell.variant] as V, cell.case, `${cell.variant}/${cell.case.id}`);
    const grade = await gradeCase("grade", {
      subject: { case: cell.case.prompt, output },
      rubric: opts.rubric,
      graders: opts.graders,
      candidateVendor: opts.vendorOf?.(cell.variant) ?? "",
    });
    return meanOf(grade.scores);
  });
  const table: Record<string, Record<string, number>> = Object.fromEntries(variants.map((variant) => [variant, {} as Record<string, number>]));
  graded.forEach((result, index) => {
    const cell = cells[index] as { variant: string; case: { id: string } };
    (table[cell.variant] as Record<string, number>)[cell.case.id] = result.ok ? result.value : 0;
  });
  const perCase = Object.fromEntries(opts.cases.map((one) => [one.id, bestOf(Object.fromEntries(variants.map((variant) => [variant, (table[variant] as Record<string, number>)[one.id] ?? 0])))]));
  const recommend = bestOf(Object.fromEntries(variants.map((variant) => [variant, meanOf(table[variant] as Record<string, number>)])));
  return { table, perCase, recommend };
}

/** A session as `history.read` names it: the harness it runs in and the id that harness gave it. */
export type SessionRef = { harness: string; native: string };

/**
 * Whether a session opened what it was expected to: each expected text (a file, a skill, a tool) is
 * looked for in the records of its transcript, read whole with `history.read`. `opened` lists the
 * ones found in the order the session first met them, `missing` the others. A transcript that could
 * not be read throws: nothing read is not nothing opened.
 */
export async function chainFromTranscript(key: string, session: SessionRef, expect: { opened: readonly string[] }): Promise<{ opened: string[]; missing: string[] }> {
  checkKey(key, "the key of a transcript check");
  const g = script();
  const answer = (await g.scope(key, undefined, () => g.call("history.read", { session, mode: "full" }))) as {
    records: unknown[];
    coverage: { status: string; reason?: string };
  };
  if (answer.coverage.status === "failed" || answer.coverage.status === "unavailable") {
    throw new Error(`the session ${session.harness}:${session.native} could not be read (${answer.coverage.status}): ${answer.coverage.reason ?? "no reason given"}`);
  }
  const texts = answer.records.map((record) => JSON.stringify(record));
  const firstAt = new Map<string, number>();
  for (const wanted of expect.opened) {
    const at = texts.findIndex((text) => text.includes(wanted));
    if (at >= 0) firstAt.set(wanted, at);
  }
  const opened = [...firstAt].sort(([, a], [, b]) => a - b).map(([wanted]) => wanted);
  return { opened, missing: expect.opened.filter((wanted) => !firstAt.has(wanted)) };
}
