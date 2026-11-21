/**
 * Loops of work in a worktree that a command judges: test first, diagnose, debug, raise coverage.
 * Each round's check is a step of the round, and a loop that runs out of rounds gives its last
 * result with the reason it stopped.
 */

import { askSeat, checkKey, loop, revise, script } from "@niwa-labs/flow";
import type { Attempt, Judged, Seat } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";
import type { ArtifactRef, Check } from "@niwa-labs/proc/flow";

import { checkFailed, commitBy, findingsText } from "./review.ts";
import { seatIn } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

const passed = (what: string): Judged => ({ verdict: "PASS", findings: [], method: `check (${what})` });

/**
 * Test first: the author writes a test for the task that fails, then makes it pass. A round whose
 * new test passes before the change is a fail, and the next round writes the test again. At most
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
        if (before.ok) {
          outcome.set(round, { verdict: "FAIL", findings: [{ title: "the new test passes before the change", evidence: before.summary, severity: "blocks" }], method: "check (red)" });
          return { sha: red.sha, redSha: "", check: before.artifact };
        }
        redSha = red.sha;
      }
      const green = await commitBy(opts.author, opts.wt, `Make the failing test of the commit ${redSha} pass, for this task:\n${opts.task}${notes}`);
      const after = await runCheck("green", opts.test);
      outcome.set(round, after.ok ? passed("green") : checkFailed("the test", after.summary));
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
 * change is no bug to fix: the answer is `INCONCLUSIVE` with no commit.
 */
export async function debugLoop(
  key: string,
  opts: { symptom: string; wt: Worktree; repro: Check; author: Seat; max?: number },
): Promise<{ cause: string; sha: string; before: ArtifactRef; after: ArtifactRef; judged: Judged }> {
  checkKey(key, "the key of a debug loop");
  const { z } = script();
  return script().scope(key, undefined, async () => {
    const before = await runCheck("before", opts.repro);
    if (before.ok) {
      return {
        cause: "",
        sha: "",
        before: before.artifact,
        after: before.artifact,
        judged: { verdict: "INCONCLUSIVE" as const, findings: [{ title: "the repro passes before any change", evidence: before.summary, severity: "note" as const }], method: "check (before)" },
      };
    }
    const results = new Map<number, { ok: boolean; summary: string; artifact: ArtifactRef }>();
    const attempt = await revise("fix", {
      ...(opts.max === undefined ? {} : { max: opts.max }),
      write: async (feedback, round) => {
        const fixed = await askSeat(
          seatIn(opts.author, opts.wt.path),
          `Fix this bug: ${opts.symptom}\n\nThe repro fails:\n${(feedback === null ? before.summary : findingsText(feedback.findings))}\n\n` +
            `Work in ${opts.wt.path} on the branch ${opts.wt.branch}. Commit the fix; answer with its commit id (sha) and the cause you found.`,
          z.object({ sha: z.string(), cause: z.string() }),
        );
        const after = await runCheck("after", opts.repro);
        results.set(round, { ok: after.ok, summary: after.summary, artifact: after.artifact });
        return fixed;
      },
      judge: async (_value, round) => {
        const after = results.get(round) as { ok: boolean; summary: string };
        return after.ok ? passed("repro") : checkFailed("the repro", after.summary);
      },
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

/**
 * Raise coverage to `threshold`: the measure reports it (`report: "json"` by default, read as its
 * `coverage`), and the author adds tests until it reaches the threshold or `max` rounds (three by
 * default) are spent.
 */
export async function coverageLoop(
  key: string,
  opts: { wt: Worktree; measure: Check; threshold: number; author: Seat; max?: number },
): Promise<{ before: number; after: number; sha: string; reached: boolean }> {
  checkKey(key, "the key of a coverage loop");
  const measure: Check = { ...opts.measure, report: opts.measure.report ?? "json" };
  const read = async (label: string): Promise<number> => {
    const measured = await runCheck(label, measure);
    const coverage = coverageOf(measured.report);
    if (coverage === undefined) throw new Error(`the coverage measure printed no report with a coverage: ${measured.summary}`);
    return coverage;
  };
  return script().scope(key, undefined, async () => {
    const before = await read("before");
    const raised = await loop("raise", {
      init: { coverage: before, sha: "" },
      max: opts.max ?? 3,
      done: (state) => state.coverage >= opts.threshold,
      step: async (state) => {
        const added = await commitBy(opts.author, opts.wt, `Add tests that raise the coverage from ${String(state.coverage)} to at least ${String(opts.threshold)}. Change no code under test.`);
        return { coverage: await read("measure"), sha: added.sha };
      },
    });
    return { before, after: raised.state.coverage, sha: raised.state.sha, reached: raised.state.coverage >= opts.threshold };
  });
}
