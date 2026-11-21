/**
 * Review in a worktree: reviewers judge the changes against a base and an author fixes what they
 * found, round after round; or several reviewers each look through lenses and their findings are
 * gathered.
 */

import { FindingSchema, askSeat, checkKey, map, revise, script, seatKeys, verify } from "@niwa-labs/flow";
import type { Attempt, Finding, Judged, Seat } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";
import type { ArtifactRef, Check } from "@niwa-labs/proc/flow";

import { seatIn, stateOf } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** What reviewers are asked to judge: the changes of a worktree's branch against a base, at a commit. */
export function reviewSubject(wt: Worktree, base: string, sha: string): string {
  return `The changes on the branch ${wt.branch} in ${wt.path}, from ${base} to the commit ${sha}: read them with \`git diff ${base}...${sha}\` there.`;
}

/** The findings of a judgement as a list an author can work through. */
export function findingsText(findings: readonly Finding[]): string {
  return findings.length === 0 ? "(none listed)" : findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.evidence}`).join("\n");
}

/**
 * Ask an author to change the worktree and commit. What comes back is read from the worktree after
 * the author is done, not from the author's word: the commit its branch is at, and whether changes
 * are left out of it (`dirty`). A check of the worktree applies to that commit only when nothing is.
 */
export async function commitBy(author: Seat, wt: Worktree, prompt: string): Promise<{ sha: string; dirty: boolean }> {
  const { z } = script();
  await askSeat(seatIn(author, wt.path), `${prompt}\n\nWork in ${wt.path} on the branch ${wt.branch}. Commit what you change, and answer with a short account of what you did.`, z.object({ summary: z.string().optional() }));
  return stateOf(wt);
}

/** Changes left out of the commit a check was run for, as a judgement that blocks. */
export function uncommitted(): Judged {
  return {
    verdict: "FAIL",
    findings: [{ title: "the work was left uncommitted", evidence: "the worktree holds changes (or new files) that are not in the commit it is at: commit them, or remove what is not part of the work", severity: "blocks" }],
    method: "check (worktree)",
  };
}

/** A check that did not pass, as a judgement that blocks. */
export function checkFailed(what: string, summary: string): Judged {
  return { verdict: "FAIL", findings: [{ title: `${what} did not pass`, evidence: summary, severity: "blocks" }], method: `check (${what})` };
}

/**
 * Review the changes of a worktree against `base` and have `author` fix what blocks, for at most
 * `max` reviews (three by default). The first review is of the worktree as it is. With `test`, the
 * check runs before each review and a failing check is sent back to the author unreviewed. So is a
 * worktree that holds changes outside the commit (the commit is read from the worktree, not taken
 * from the author's word), which includes files a check leaves behind: a check has to leave the
 * worktree as it found it, or have its output ignored by git.
 */
export async function reviewFix(
  key: string,
  opts: { wt: Worktree; base: string; author: Seat; reviewers: readonly Seat[]; focus?: readonly string[]; max?: number; test?: Check },
): Promise<Attempt<{ sha: string; check?: ArtifactRef }>> {
  checkKey(key, "the key of a review");
  if (opts.reviewers.length === 0) throw new TypeError(`reviewFix "${key}": give at least one reviewer`);
  const blocked = new Map<number, Judged>();
  return revise(key, {
    ...(opts.max === undefined ? {} : { max: opts.max }),
    write: async (feedback, round) => {
      const state = feedback === null ? await stateOf(opts.wt, "head") : await commitBy(opts.author, opts.wt, `Fix what the review found in the changes against ${opts.base}:\n${findingsText(feedback.findings)}`);
      const check = opts.test === undefined ? undefined : await runCheck("test", opts.test);
      if (state.dirty) blocked.set(round, uncommitted());
      else if (check !== undefined && !check.ok) blocked.set(round, checkFailed("the test", check.summary));
      return { sha: state.sha, ...(check === undefined ? {} : { check: check.artifact }) };
    },
    judge: async ({ sha }, round) =>
      blocked.get(round) ??
      verify("review", {
        subject: reviewSubject(opts.wt, opts.base, sha),
        by: opts.reviewers.map((reviewer) => seatIn(reviewer, opts.wt.path)),
        ...(opts.focus === undefined ? {} : { lenses: opts.focus }),
      }),
  });
}

/**
 * Reviewers look at the changes of a worktree through each lens and list what they find. The
 * findings are gathered once each (by title and severity), and by lens. A reviewer that could not
 * look through a lens is in `failures` with its error: no findings from it is not a clean review, so
 * a panel is complete only when `failures` is empty.
 */
export async function reviewPanel(
  key: string,
  opts: { wt: Worktree; base: string; reviewers: readonly Seat[]; lenses: readonly string[] },
): Promise<{ findings: Finding[]; byLens: Record<string, Finding[]>; failures: { reviewer: string; lens: string; error: string }[] }> {
  checkKey(key, "the key of a review");
  const keys = seatKeys(opts.reviewers, "the key of a reviewer");
  const { z } = script();
  const legs = opts.reviewers.flatMap((seat, at) => opts.lenses.map((lens, index) => ({ seat, reviewer: keys[at] as string, lens, key: `${keys[at] as string}-l${String(index + 1)}` })));
  const answers = await script().scope(key, undefined, async () => {
    const { sha } = await stateOf(opts.wt, "head");
    return map("legs", legs, { key: (leg) => leg.key }, (leg) =>
      askSeat(
        seatIn(leg.seat, opts.wt.path),
        `Review the work below through this lens only: ${leg.lens}. List what you find, each with its evidence; a finding that must be fixed blocks.\n\n${reviewSubject(opts.wt, opts.base, sha)}`,
        z.object({ findings: z.array(FindingSchema()) }),
      ),
    );
  });
  const byLens: Record<string, Finding[]> = Object.fromEntries(opts.lenses.map((lens) => [lens, [] as Finding[]]));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const failures: { reviewer: string; lens: string; error: string }[] = [];
  answers.forEach((answer, index) => {
    const leg = legs[index] as { reviewer: string; lens: string };
    if (!answer.ok) {
      failures.push({ reviewer: leg.reviewer, lens: leg.lens, error: answer.error.message });
      return;
    }
    for (const finding of answer.value.findings) {
      (byLens[leg.lens] as Finding[]).push(finding);
      const id = `${finding.severity}\0${finding.title}`;
      if (!seen.has(id)) findings.push(finding);
      seen.add(id);
    }
  });
  return { findings, byLens, failures };
}
