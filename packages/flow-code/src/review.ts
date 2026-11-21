/**
 * Review in a worktree: reviewers judge the changes against a base and an author fixes what they
 * found, round after round; or several reviewers each look through lenses and their findings are
 * gathered.
 */

import { FindingSchema, askSeat, checkKey, map, revise, script, seatKeys, verify } from "@niwa-labs/flow";
import type { Attempt, Finding, Judged, Seat } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";
import type { ArtifactRef, Check } from "@niwa-labs/proc/flow";

import { headOf, seatIn } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** What reviewers are asked to judge: the changes of a worktree's branch against a base, at a commit. */
export function reviewSubject(wt: Worktree, base: string, sha: string): string {
  return `The changes on the branch ${wt.branch} in ${wt.path}, from ${base} to the commit ${sha}: read them with \`git diff ${base}...${sha}\` there.`;
}

/** The findings of a judgement as a list an author can work through. */
export function findingsText(findings: readonly Finding[]): string {
  return findings.length === 0 ? "(none listed)" : findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.evidence}`).join("\n");
}

/** Ask an author to change the worktree and commit: the commit it made. */
export function commitBy(author: Seat, wt: Worktree, prompt: string): Promise<{ sha: string }> {
  const { z } = script();
  return askSeat(seatIn(author, wt.path), `${prompt}\n\nWork in ${wt.path} on the branch ${wt.branch}. Commit what you change and answer with the commit id (sha).`, z.object({ sha: z.string() }));
}

/** A check that did not pass, as a judgement that blocks. */
export function checkFailed(what: string, summary: string): Judged {
  return { verdict: "FAIL", findings: [{ title: `${what} did not pass`, evidence: summary, severity: "blocks" }], method: `check (${what})` };
}

/**
 * Review the changes of a worktree against `base` and have `author` fix what blocks, for at most
 * `max` reviews (three by default). The first review is of the worktree as it is. With `test`, the
 * check runs before each review and a failing check is sent back to the author unreviewed.
 */
export async function reviewFix(
  key: string,
  opts: { wt: Worktree; base: string; author: Seat; reviewers: readonly Seat[]; focus?: readonly string[]; max?: number; test?: Check },
): Promise<Attempt<{ sha: string; check?: ArtifactRef }>> {
  checkKey(key, "the key of a review");
  if (opts.reviewers.length === 0) throw new TypeError(`reviewFix "${key}": give at least one reviewer`);
  const tested = new Map<number, { ok: boolean; summary: string }>();
  return revise(key, {
    ...(opts.max === undefined ? {} : { max: opts.max }),
    write: async (feedback, round) => {
      const sha =
        feedback === null
          ? await headOf("head", opts.wt)
          : (await commitBy(opts.author, opts.wt, `Fix what the review found in the changes against ${opts.base}:\n${findingsText(feedback.findings)}`)).sha;
      if (opts.test === undefined) return { sha };
      const check = await runCheck("test", opts.test);
      tested.set(round, { ok: check.ok, summary: check.summary });
      return { sha, check: check.artifact };
    },
    judge: async ({ sha }, round) => {
      const check = tested.get(round);
      if (check !== undefined && !check.ok) return checkFailed("the test", check.summary);
      return verify("review", {
        subject: reviewSubject(opts.wt, opts.base, sha),
        by: opts.reviewers.map((reviewer) => seatIn(reviewer, opts.wt.path)),
        ...(opts.focus === undefined ? {} : { lenses: opts.focus }),
      });
    },
  });
}

/**
 * Reviewers look at the changes of a worktree through each lens and list what they find. The
 * findings are gathered once each (by title and severity), and by lens.
 */
export async function reviewPanel(
  key: string,
  opts: { wt: Worktree; base: string; reviewers: readonly Seat[]; lenses: readonly string[] },
): Promise<{ findings: Finding[]; byLens: Record<string, Finding[]> }> {
  checkKey(key, "the key of a review");
  const keys = seatKeys(opts.reviewers, "the key of a reviewer");
  const { z } = script();
  const legs = opts.reviewers.flatMap((seat, at) => opts.lenses.map((lens, index) => ({ seat, lens, key: `${keys[at] as string}-l${String(index + 1)}` })));
  const answers = await script().scope(key, undefined, async () => {
    const sha = await headOf("head", opts.wt);
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
  answers.forEach((answer, index) => {
    if (!answer.ok) return;
    const leg = legs[index] as { seat: Seat; lens: string };
    for (const finding of answer.value.findings) {
      (byLens[leg.lens] as Finding[]).push(finding);
      const id = `${finding.severity}\0${finding.title}`;
      if (!seen.has(id)) findings.push(finding);
      seen.add(id);
    }
  });
  return { findings, byLens };
}
