/**
 * Loops of work in a worktree that a command judges: test first, diagnose, debug, raise coverage.
 * Each round's check is a step of the round, and a loop that runs out of rounds gives its last
 * result with the reason it stopped.
 */

import { askSeat, checkKey, loop, revise, script } from "@niwa-labs/flow";
import type { Attempt, Judged, Seat } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";
import type { ArtifactRef, Check } from "@niwa-labs/proc/flow";

import { changesAfterCheck, checkFailed, commitBy, findingsText, uncommitted } from "./review.ts";
import { seatIn, stateOf } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

const passed = (what: string): Judged => ({ verdict: "PASS", findings: [], method: `check (${what})` });

/**
 * Test first: the author writes a test for the task that fails, then makes it pass. A round whose
 * new test passes before the change is a fail, and so is one that does not finish (it timed out or
 * was cancelled: no failure was seen); the next round writes the test again. At most
 * `max` rounds (three by default).
 */
export async function tddLoop(
  key: string,
  opts: { task: string; wt: Worktree; author: Seat; test: Check; max?: number },
): Promise<Attempt<{ sha: string; redSha: string; check: ArtifactRef }>> {
  checkKey(key, "the key of a test-first loop");
  let redSha = "";
  const outcome = new Map<number, Judged>();
  return revise(key, {
    ...(opts.max === undefined ? {} : { max: opts.max }),
    write: async (feedback, round) => {
      const notes = feedback === null ? "" : `\n\nThe last round did not pass:\n${findingsText(feedback.findings)}`;
      if (redSha === "") {
        const red = await commitBy(opts.author, opts.wt, `Write a test for this task that fails now, before any change for it, and nothing else:\n${opts.task}${notes}`);
        const before = await runCheck("red", opts.test);
        if (before.exit === null) {
          // A test that timed out or was cancelled has not failed: nothing was seen.
          outcome.set(round, { verdict: "FAIL", findings: [{ title: "the new test did not finish", evidence: before.summary, severity: "blocks" }], method: "check (red)" });
          return { sha: red.sha, redSha: "", check: before.artifact };
        }
        if (before.ok) {
          outcome.set(round, { verdict: "FAIL", findings: [{ title: "the new test passes before the change", evidence: before.summary, severity: "blocks" }], method: "check (red)" });
          return { sha: red.sha, redSha: "", check: before.artifact };
        }
        const redChange = red.dirty ? uncommitted() : await changesAfterCheck(opts.wt, red.sha);
        if (redChange !== undefined) {
          outcome.set(round, redChange);
          return { sha: red.sha, redSha: "", check: before.artifact };
        }
        redSha = red.sha;
      }
      const green = await commitBy(opts.author, opts.wt, `Make the failing test of the commit ${redSha} pass, for this task:\n${opts.task}${notes}`);
      const after = await runCheck("green", opts.test);
      const greenFailure = green.dirty ? uncommitted() : after.ok ? await changesAfterCheck(opts.wt, green.sha) : checkFailed("the test", after.summary);
      outcome.set(round, greenFailure ?? passed("green"));
      return { sha: green.sha, redSha, check: after.artifact };
    },
    judge: async (_value, round) => outcome.get(round) as Judged,
  });
}

/** A hypothesis about a cause: what it claims, how it stands and what shows it. */
export type Hypothesis = { claim: string; status: "confirmed" | "refuted" | "open"; evidence: string };

/**
 * Find the cause of a symptom: each round runs the repro and the investigator says how the
 * hypotheses stand, adding new ones. It stops when one is confirmed, or after `max` rounds (three by
 * default) with no cause.
 */
export async function diagnoseLoop(
  key: string,
  opts: { symptom: string; wt: Worktree; repro: Check; investigator: Seat; max?: number },
): Promise<{ cause: string | null; hypotheses: Hypothesis[] }> {
  checkKey(key, "the key of a diagnosis");
  const { z } = script();
  const answer = z.object({
    hypotheses: z.array(z.object({ claim: z.string(), status: z.enum(["confirmed", "refuted", "open"]), evidence: z.string() })),
  });
  const found = await loop(key, {
    init: { hypotheses: [] as Hypothesis[], cause: null as string | null },
    max: opts.max ?? 3,
    done: (state) => state.cause !== null,
    step: async (state) => {
      const repro = await runCheck("repro", opts.repro);
      const known = state.hypotheses.map((one) => `- [${one.status}] ${one.claim}: ${one.evidence}`).join("\n") || "(none yet)";
      const told = await askSeat(
        seatIn(opts.investigator, opts.wt.path),
        `Find the cause of this symptom: ${opts.symptom}\n\nThe repro ${repro.ok ? "passed" : "failed"}:\n${repro.summary}\n\nThe hypotheses so far:\n${known}\n\n` +
          "Investigate in this directory without changing it. Answer with every hypothesis, old and new, each confirmed, refuted or still open, with its evidence.",
        answer,
      );
      return { hypotheses: told.hypotheses, cause: told.hypotheses.find((one) => one.status === "confirmed")?.claim ?? null };
    },
  });
  return found.state;
}

/**
 * Fix a bug a repro shows: the repro must fail first; then the author fixes it, round after round,
 * until the repro passes or `max` rounds (three by default) are spent. A repro that passes before any
 * change is no bug to fix, and one that does not finish (it timed out or was cancelled) shows none:
 * the answer is `INCONCLUSIVE` with no commit.
 */
export async function debugLoop(
  key: string,
  opts: { symptom: string; wt: Worktree; repro: Check; author: Seat; max?: number },
): Promise<{ cause: string; sha: string; before: ArtifactRef; after: ArtifactRef; judged: Judged }> {
  checkKey(key, "the key of a debug loop");
  const { z } = script();
  return script().scope(key, undefined, async () => {
    const before = await runCheck("before", opts.repro);
    if (before.ok || before.exit === null) {
      // A repro that passes shows no bug; one that did not finish (timed out, cancelled) shows nothing.
      const title = before.ok ? "the repro passes before any change" : "the repro did not finish";
      return {
        cause: "",
        sha: "",
        before: before.artifact,
        after: before.artifact,
        judged: { verdict: "INCONCLUSIVE" as const, findings: [{ title, evidence: before.summary, severity: before.ok ? ("note" as const) : ("blocks" as const) }], method: "check (before)" },
      };
    }
    const results = new Map<number, { judged: Judged; artifact: ArtifactRef }>();
    const attempt = await revise("fix", {
      ...(opts.max === undefined ? {} : { max: opts.max }),
      write: async (feedback, round) => {
        const fixed = await askSeat(
          seatIn(opts.author, opts.wt.path),
          `Fix this bug: ${opts.symptom}\n\nThe repro fails:\n${(feedback === null ? before.summary : findingsText(feedback.findings))}\n\n` +
            `Work in ${opts.wt.path} on the branch ${opts.wt.branch}. Commit the fix; answer with the cause you found.`,
          z.object({ cause: z.string() }),
        );
        const { sha, dirty } = await stateOf(opts.wt);
        const after = await runCheck("after", opts.repro);
        const failure = dirty ? uncommitted() : after.ok ? await changesAfterCheck(opts.wt, sha) : checkFailed("the repro", after.summary);
        results.set(round, { judged: failure ?? passed("repro"), artifact: after.artifact });
        return { sha, cause: fixed.cause };
      },
      judge: async (_value, round) => results.get(round)!.judged,
    });
    return { cause: attempt.value.cause, sha: attempt.value.sha, before: before.artifact, after: (results.get(attempt.rounds) as { artifact: ArtifactRef }).artifact, judged: attempt.judged };
  });
}

/** The coverage a measure reports: the `coverage` of its report (a JSON report, or lcov totals). */
export function coverageOf(report: unknown): number | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const value = (report as { coverage?: unknown }).coverage;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A coverage measure that gave no coverage: it failed, or printed no report with one. */
export class MeasureFailed extends Error {
  override name = "MeasureFailed";
  constructor(
    message: string,
    readonly artifact: ArtifactRef,
  ) {
    super(message);
  }
}

/**
 * Raise coverage to `threshold`: the measure reports it (`report: "json"` by default, read as its
 * `coverage`), and the author adds tests until it reaches the threshold or `max` rounds (three by
 * default) are spent. A measure that fails gives no coverage, whatever it printed: before the first
 * round that is a `MeasureFailed`; after a round it is sent to the author as the reason the round did
 * not count, and the answer carries it as `failure` when it is the last word.
 */
export async function coverageLoop(
  key: string,
  opts: { wt: Worktree; measure: Check; threshold: number; author: Seat; max?: number },
): Promise<{ before: number; after: number; sha: string; reached: boolean; failure?: { reason: string; artifact: ArtifactRef } }> {
  checkKey(key, "the key of a coverage loop");
  const measure: Check = { ...opts.measure, report: opts.measure.report ?? "json" };
  const read = async (label: string, sha?: string): Promise<{ coverage: number } | { failure: { reason: string; artifact: ArtifactRef } }> => {
    const measured = await runCheck(label, measure);
    if (!measured.ok) return { failure: { reason: `the coverage measure did not pass: ${measured.summary}`, artifact: measured.artifact } };
    const coverage = coverageOf(measured.report);
    if (coverage === undefined) return { failure: { reason: `the coverage measure printed no report with a coverage: ${measured.summary}`, artifact: measured.artifact } };
    if (sha !== undefined) {
      const change = await changesAfterCheck(opts.wt, sha);
      if (change !== undefined) return { failure: { reason: findingsText(change.findings), artifact: measured.artifact } };
    }
    return { coverage };
  };
  type State = { coverage: number; sha: string; clean: boolean; failure?: { reason: string; artifact: ArtifactRef } };
  return script().scope(key, undefined, async () => {
    const first = await read("before");
    if ("failure" in first) throw new MeasureFailed(first.failure.reason, first.failure.artifact);
    const before = first.coverage;
    const raised = await loop<State>("raise", {
      init: { coverage: before, sha: "", clean: true },
      max: opts.max ?? 3,
      done: (state) => state.failure === undefined && state.clean && state.coverage >= opts.threshold,
      step: async (state) => {
        const added = await commitBy(
          opts.author,
          opts.wt,
          `Add tests that raise the coverage from ${String(state.coverage)} to at least ${String(opts.threshold)}. Change no code under test.` +
            (state.clean ? "" : "\n\nThe last round left changes uncommitted: commit them.") +
            (state.failure === undefined ? "" : `\n\nThe last round did not count:\n${state.failure.reason}`),
        );
        const measured = await read("measure", added.dirty ? undefined : added.sha);
        return "failure" in measured
          ? { coverage: state.coverage, sha: added.sha, clean: !added.dirty, failure: measured.failure }
          : { coverage: measured.coverage, sha: added.sha, clean: !added.dirty };
      },
    });
    const { coverage, sha, clean, failure } = raised.state;
    return { before, after: coverage, sha, reached: failure === undefined && clean && coverage >= opts.threshold, ...(failure === undefined ? {} : { failure }) };
  });
}
