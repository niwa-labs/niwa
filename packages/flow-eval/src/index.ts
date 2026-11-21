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
 * script's `random()`, which the run records. The names are put in a fixed order before the draws
 * shuffle them, so a replay that collects the same candidates in another order labels them the
 * same. `reveal` names the candidate behind a label.
 */
export async function blindSet<C>(key: string, candidates: Record<string, C>): Promise<{ labeled: Record<string, C>; reveal: (label: string) => string }> {
  checkKey(key, "the key of a blind set");
  const names = Object.keys(candidates).sort();
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
  const labels = order.map((name, index) => [blindLabel(index), name] as const);
  const behind = new Map<string, string>(labels);
  const labeled: Record<string, C> = Object.fromEntries(labels.map(([label, name]) => [label, candidates[name] as C]));
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

/** The ids of a rubric, each a key and none given twice: checked before anything runs. */
function checkRubric(rubric: readonly RubricItem[]): string[] {
  return checkKeys(
    rubric.map((item) => item.id),
    "the id of a rubric item",
  );
}

/**
 * Grade a subject against a rubric, each item from 0 to 1, by graders of another vendor than the
 * candidate's: a grader of the candidate's vendor does not grade. A grader answers with a score for
 * every item or not at all. The rule (majority by default) is applied to all the independent graders:
 * the verdict is a pass or a fail when the graders that did not answer could not change it, and
 * `INCONCLUSIVE` otherwise, with no independent grader, or with no answer. A `candidateVendor` of
 * null says the subject is not the work of a model, so every grader is independent of it.
 */
export async function gradeCase<S>(
  key: string,
  opts: { subject: S; rubric: readonly RubricItem[]; graders: readonly Seat[]; candidateVendor: string | null; rule?: "majority" | "unanimous" },
): Promise<{ scores: Record<string, number>; legs: { grader: Seat; scores: Record<string, number> }[]; verdict: Verdict }> {
  checkKey(key, "the key of a grade");
  const ids = checkRubric(opts.rubric);
  const graders = opts.candidateVendor === null ? [...opts.graders] : opts.graders.filter((seat) => vendorOf(seat) !== opts.candidateVendor);
  if (graders.length === 0) return { scores: {}, legs: [], verdict: "INCONCLUSIVE" };
  const keys = seatKeys(graders, "the key of a grader");
  const { z } = script();
  const sheet = z.object({
    scores: z
      .array(z.object({ id: z.string(), score: z.number().min(0).max(1) }))
      .refine((given) => given.length === ids.length && ids.every((id) => given.some((one) => one.id === id)), "a score for every item of the rubric, once each, by its id"),
  });
  const subject = typeof opts.subject === "string" ? opts.subject : JSON.stringify(opts.subject, null, 2);
  const prompt = [
    "Grade the subject below against each item of the rubric, from 0 (not at all) to 1 (fully). Answer with a score for every item, once each, as a list of { id, score }.",
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
      ? [{ grader: graders[index] as Seat, scores: Object.fromEntries(ids.map((id) => [id, (answer.value.scores.find((one) => one.id === id) as { score: number }).score])) as Record<string, number> }]
      : [],
  );
  if (legs.length === 0) return { scores: {}, legs, verdict: "INCONCLUSIVE" };
  const rule = opts.rule ?? "majority";
  const scores = Object.fromEntries(ids.map((id) => [id, legs.reduce((sum, leg) => sum + (leg.scores[id] as number), 0) / legs.length])) as Record<string, number>;
  // The graders that gave no answer still count toward the threshold: the verdict stands only if
  // it is the same whether each of them would have passed every item or failed every one.
  const missing = graders.length - legs.length;
  const passesWith = (fill: number): boolean => ids.every((id) => itemPasses([...legs.map((leg) => leg.scores[id] as number), ...Array<number>(missing).fill(fill)], rule));
  const best = passesWith(1);
  const worst = passesWith(0);
  return { scores, legs, verdict: best && worst ? "PASS" : !best && !worst ? "FAIL" : "INCONCLUSIVE" };
}

/** Scores closer than this are the same score: sums of the same numbers in another order differ by more than none. */
const SAME_SCORE = 1e-9;

/** The mean of the scores of a grade, or null with none. */
const meanOf = (scores: readonly number[]): number | null => (scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length);

/** The single best of named numbers, or null on a tie at the top (scores the same within rounding) or with none. */
export function bestOf(values: Record<string, number>): string | null {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  const top = Math.max(...entries.map(([, value]) => value));
  const leaders = entries.filter(([, value]) => top - value <= SAME_SCORE);
  return leaders.length === 1 ? (leaders[0] as [string, number])[0] : null;
}

/** The names of the numbers when every one is known, or null when any is missing: a comparison with a gap compares nothing. */
function wholeOf(values: readonly [string, number | null][]): Record<string, number> | null {
  const known = values.flatMap(([name, value]) => (value === null ? [] : [[name, value] as const]));
  return known.length === values.length ? Object.fromEntries(known) : null;
}

/**
 * Run every case on every variant and grade each output against the rubric. `dir` is the cell's
 * own path, `<variant>/<case>`, for a run that keeps what it makes apart. A variant whose output is
 * graded is the candidate, so `vendorOf` names its vendor (graders of that vendor do not grade it),
 * or null for a variant that is not the work of a model. `table[variant][case]` is the mean score,
 * or null when the cell has none: its run failed (it is then in `failures`) or no independent grader
 * answered. `perCase` is the best variant of each case and `recommend` the best variant overall;
 * either is null on a tie, and when any score it rests on is missing.
 */
export async function evalSuite<V, O>(
  key: string,
  opts: {
    cases: readonly { id: string; prompt: string }[];
    variants: Record<string, V>;
    run: (variant: V, c: { id: string; prompt: string }, dir: string) => Promise<O>;
    rubric: readonly RubricItem[];
    graders: readonly Seat[];
    vendorOf: (variant: string) => string | null;
    concurrency?: number;
  },
): Promise<{
  table: Record<string, Record<string, number | null>>;
  perCase: Record<string, string | null>;
  recommend: string | null;
  failures: { variant: string; case: string; error: string }[];
}> {
  checkKey(key, "the key of a suite");
  const variants = checkKeys(Object.keys(opts.variants), "the name of a variant");
  checkKeys(
    opts.cases.map((one) => one.id),
    "the id of a case",
  );
  checkRubric(opts.rubric);
  // The length of the variant's name tells where it ends, so no two pairs share a key.
  const cells = variants.flatMap((variant) => opts.cases.map((one) => ({ variant, case: one, key: `v${String(variant.length)}-${variant}-${one.id}` })));
  const graded = await map(key, cells, { key: (cell) => cell.key, ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, async (cell) => {
    const output = await opts.run(opts.variants[cell.variant] as V, cell.case, `${cell.variant}/${cell.case.id}`);
    const grade = await gradeCase("grade", {
      subject: { case: cell.case.prompt, output },
      rubric: opts.rubric,
      graders: opts.graders,
      candidateVendor: opts.vendorOf(cell.variant),
    });
    return grade.legs.length === 0 ? null : meanOf(Object.values(grade.scores));
  });
  const scoreAt = (index: number): number | null => {
    const result = graded[index] as (typeof graded)[number];
    return result.ok ? result.value : null;
  };
  const table = Object.fromEntries(
    variants.map((variant) => [variant, Object.fromEntries(opts.cases.map((one) => [one.id, scoreAt(cells.findIndex((cell) => cell.variant === variant && cell.case.id === one.id))]))]),
  ) as Record<string, Record<string, number | null>>;
  const failures = graded.flatMap((result, index) => (result.ok ? [] : [{ variant: (cells[index] as (typeof cells)[number]).variant, case: (cells[index] as (typeof cells)[number]).case.id, error: result.error.message }]));
  const at = (variant: string, id: string): number | null => (table[variant] as Record<string, number | null>)[id] as number | null;
  const perCase = Object.fromEntries(
    opts.cases.map((one) => {
      const whole = wholeOf(variants.map((variant) => [variant, at(variant, one.id)]));
      return [one.id, whole === null ? null : bestOf(whole)];
    }),
  );
  const totals = wholeOf(
    variants.map((variant): [string, number | null] => {
      const scores = wholeOf(opts.cases.map((one) => [one.id, at(variant, one.id)]));
      return [variant, scores === null ? null : meanOf(Object.values(scores))];
    }),
  );
  return { table, perCase, recommend: totals === null ? null : bestOf(totals), failures };
}

/** A session as `history.read` names it: the harness it runs in and the id that harness gave it. */
export type SessionRef = { harness: string; native: string };

/** The fields of a record of a transcript that a check of what was opened reads. */
type TranscriptRecord = { kind?: string; callId?: string; name?: string; category?: string; target?: string; paths?: string[]; ok?: boolean };

/**
 * Whether a session opened what it was expected to: each expected text (a file, a skill, a tool) is
 * matched exactly against the target, the paths and the name of the tool calls in the transcript,
 * read whole with `history.read`; what the person or the model wrote in a message opens nothing. A
 * call that reads a file counts only with a result that did not fail. `opened` lists the ones found
 * in the order the session first called them, `missing` the others. A transcript that could not be
 * read throws: nothing read is not nothing opened.
 */
export async function chainFromTranscript(key: string, session: SessionRef, expect: { opened: readonly string[] }): Promise<{ opened: string[]; missing: string[] }> {
  checkKey(key, "the key of a transcript check");
  const g = script();
  const answer = (await g.scope(key, undefined, () => g.call("history.read", { session, mode: "full" }))) as {
    records: TranscriptRecord[];
    coverage: { status: string; reason?: string };
  };
  if (answer.coverage.status === "failed" || answer.coverage.status === "unavailable") {
    throw new Error(`the session ${session.harness}:${session.native} could not be read (${answer.coverage.status}): ${answer.coverage.reason ?? "no reason given"}`);
  }
  const failed = new Set<string>();
  const answered = new Set<string>();
  for (const record of answer.records) {
    if (record.kind !== "tool-result" || record.callId === undefined) continue;
    answered.add(record.callId);
    if (record.ok === false) failed.add(record.callId);
  }
  const firstAt = new Map<string, number>();
  answer.records.forEach((record, index) => {
    if (record.kind !== "tool-call") return;
    const succeeded = record.category !== "read" || (record.callId !== undefined && answered.has(record.callId) && !failed.has(record.callId));
    if (!succeeded) return;
    const names = [record.name, record.target, ...(record.paths ?? [])];
    for (const wanted of expect.opened) if (!firstAt.has(wanted) && names.includes(wanted)) firstAt.set(wanted, index);
  });
  const opened = [...firstAt].sort(([, a], [, b]) => a - b).map(([wanted]) => wanted);
  return { opened, missing: expect.opened.filter((wanted) => !firstAt.has(wanted)) };
}
