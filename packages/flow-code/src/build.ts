/**
 * Whole pieces of work: probe a running system with scenarios, implement a task in one of four
 * modes, and integrate branches.
 */

import { askSeat, checkKey, checkKeys, humanGate, map, script, verify } from "@niwa-labs/flow";
import type { Judged, Seat, Verdict } from "@niwa-labs/flow";
import { runCheck } from "@niwa-labs/proc/flow";
import type { Check, CheckResult } from "@niwa-labs/proc/flow";

import { changesAfterCheck, checkFailed, commitBy, reviewFix, uncommitted } from "./review.ts";
import { forkRace, makeWorktree, seatIn, stateOf } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** How a scenario of a self-test went: passed, failed, held behind a gate it cannot pass, or could not be run. */
export type ScenarioStatus = "pass" | "fail" | "gated" | "error";

/**
 * The verdict of a self-test: a fail or an error fails it, nothing run (or only gated scenarios) is
 * `INCONCLUSIVE`, passes with gated scenarios are a pass with notes.
 */
export function selfTestVerdict(rows: readonly { status: ScenarioStatus }[]): Verdict {
  if (rows.some((row) => row.status === "fail" || row.status === "error")) return "FAIL";
  const passed = rows.filter((row) => row.status === "pass").length;
  if (passed === 0) return "INCONCLUSIVE";
  return passed === rows.length ? "PASS" : "PASS+NOTES";
}

/** Probe scenarios, each in a branch of its own: the probe follows the steps and says whether what it saw is what is expected. */
export async function selfTest(
  key: string,
  opts: { scenarios: readonly { id: string; steps: string; expect: string }[]; probe: Seat; concurrency?: number },
): Promise<{ verdict: Verdict; rows: { id: string; status: ScenarioStatus; evidence: string }[] }> {
  checkKey(key, "the key of a self-test");
  checkKeys(
    opts.scenarios.map((one) => one.id),
    "the id of a scenario",
  );
  const { z } = script();
  const answer = z.object({ status: z.enum(["pass", "fail", "gated"]), evidence: z.string() });
  const outcomes = await map(key, opts.scenarios, { key: (one) => one.id, ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, (one) =>
    askSeat(
      opts.probe,
      `Run this scenario and report what you saw.\n\nSteps:\n${one.steps}\n\nExpected:\n${one.expect}\n\n` +
        "Answer pass when what you saw is what is expected, fail when it is not, gated when something you may not pass (a login, an approval) stopped you; give the evidence.",
      answer,
    ),
  );
  const rows = outcomes.map((outcome, index) => {
    const id = (opts.scenarios[index] as { id: string }).id;
    return outcome.ok ? { id, status: outcome.value.status as ScenarioStatus, evidence: outcome.value.evidence } : { id, status: "error" as const, evidence: outcome.error.message };
  });
  return { verdict: selfTestVerdict(rows), rows };
}

/** How `implement` works: one author; cheap forks raced on the test; review and fix; or that with the owner's word before and after. */
export type ImplementMode = "economy" | "race" | "quality" | "safe";

/** What the owner did not let through in a `safe` implementation. */
export class ImplementStopped extends Error {
  override name = "ImplementStopped";
}

/** The judgement of a check, or none run. */
async function judgedBy(test: Check | undefined, label: string, wt: Worktree, sha: string): Promise<Judged> {
  if (test === undefined) return { verdict: "INCONCLUSIVE", findings: [], method: "no check was given" };
  const check = await runCheck(label, test);
  if (!check.ok) return checkFailed("the test", check.summary);
  return (await changesAfterCheck(wt, sha)) ?? { verdict: "PASS", findings: [], method: "check (test)" };
}

/** A fork of a race: its commit, test result, and any reason it could not pass. */
type Candidate = { sha: string; tested?: CheckResult; failure?: Judged };

/** The test, run in a worktree. */
const testIn = (test: Check | undefined, wt: Worktree): Check | undefined => (test === undefined ? undefined : { ...test, cwd: wt.path });

/**
 * Implement a task in a new worktree of `repo`; the worktree is kept with the commits.
 *
 * - `economy`: the author works once; the test, if given, judges.
 * - `race`: each cheap seat (the author when none) builds in a fork; the first fork whose test
 *   passes wins and the others are cancelled and removed, and the reviewer, if given, judges it.
 *   When no fork passes the first seat's is kept and fails with what its test said, whatever the
 *   reviewer would say.
 * - `quality`: the author works, then the reviewer (the author when none) reviews and the author fixes.
 * - `safe`: `quality` with the owner's word before the work starts and before it is handed back.
 */
export async function implement(
  key: string,
  opts: { task: string; repo: string; mode: ImplementMode; seats: { author: Seat; cheap?: readonly Seat[]; reviewer?: Seat }; test?: Check; base?: string },
): Promise<{ sha: string; worktree: Worktree; judged: Judged }> {
  checkKey(key, "the key of an implementation");
  const prompt = `Implement this task:\n${opts.task}`;
  return script().scope(key, undefined, async () => {
    if (opts.mode === "safe") {
      const go = await humanGate("start", { summary: `Start this task in ${opts.repo}?\n\n${opts.task}`, options: ["start"] });
      if (go.outcome !== "chosen") throw new ImplementStopped(`the owner did not let the task start (${go.outcome})`);
    }
    if (opts.mode === "race") {
      const raced = await forkRace("forks", {
        seats: opts.seats.cheap !== undefined && opts.seats.cheap.length > 0 ? opts.seats.cheap : [opts.seats.author],
        repo: opts.repo,
        ...(opts.base === undefined ? {} : { base: opts.base }),
        build: async (seat, wt): Promise<Candidate> => {
          const built = await commitBy(seat, wt, prompt);
          const test = testIn(opts.test, wt);
          if (built.dirty) return { sha: built.sha, failure: uncommitted() };
          if (test === undefined) return { sha: built.sha };
          const tested = await runCheck("test", test);
          const failure = tested.ok ? await changesAfterCheck(wt, built.sha) : checkFailed("the test", tested.summary);
          return { sha: built.sha, tested, ...(failure === undefined ? {} : { failure }) };
        },
        passes: (one) => one.failure === undefined,
      });
      const { sha, tested, failure } = raced.winner.value;
      const wt = raced.winner.worktree;
      // A winner that did not pass is judged by what its own check said, whoever the reviewer is.
      const judged = failure ?? (opts.seats.reviewer !== undefined
        ? await verify("review", { subject: `The work for this task on the branch ${wt.branch} in ${wt.path}, at ${sha}:\n${opts.task}`, by: [seatIn(opts.seats.reviewer, wt.path)] })
        : tested !== undefined
          ? { verdict: "PASS" as const, findings: [], method: "check (test)" }
          : await judgedBy(undefined, "judge", wt, sha));
      return { sha, worktree: wt, judged };
    }
    const wt = await makeWorktree({ repo: opts.repo, ...(opts.base === undefined ? {} : { base: opts.base }), description: `implement ${key}` });
    const built = await commitBy(opts.seats.author, wt, prompt);
    const test = testIn(opts.test, wt);
    if (opts.mode === "economy") return { sha: built.sha, worktree: wt, judged: built.dirty ? uncommitted() : await judgedBy(test, "judge", wt, built.sha) };
    const reviewed = await reviewFix("review", { wt, base: wt.baseSha, author: opts.seats.author, reviewers: [opts.seats.reviewer ?? opts.seats.author], ...(test === undefined ? {} : { test }) });
    if (opts.mode === "safe") {
      const done = await humanGate("accept", { summary: `Hand back the work on ${wt.branch} (${reviewed.value.sha}), judged ${reviewed.judged.verdict}?`, options: ["accept"] });
      if (done.outcome !== "chosen") throw new ImplementStopped(`the owner did not accept the work (${done.outcome})`);
    }
    return { sha: reviewed.value.sha, worktree: wt, judged: reviewed.judged };
  });
}

/**
 * Integrate branches into `into`: in a new worktree of it, the integrator merges each branch,
 * resolving conflicts, and commits; the test, if given, judges the result.
 */
export async function integrate(
  key: string,
  opts: { repo: string; into: string; branches: readonly string[]; integrator: Seat; test?: Check },
): Promise<{ sha: string; conflicts: { files: string[]; resolvedBy: Seat }[]; judged: Judged }> {
  checkKey(key, "the key of an integration");
  if (opts.branches.length === 0) throw new TypeError(`integrate "${key}": give at least one branch`);
  const { z } = script();
  return script().scope(key, undefined, async () => {
    const wt = await makeWorktree({ repo: opts.repo, base: opts.into, description: `integrate into ${opts.into}` });
    const merged = await askSeat(
      seatIn(opts.integrator, wt.path),
      `Merge these branches, in this order, into the branch ${wt.branch} checked out in ${wt.path} (made from ${opts.into}): ${opts.branches.join(", ")}.\n` +
        "Resolve every conflict so both sides' intent holds, and commit. Answer with, for each merge that conflicted, the files.",
      z.object({ conflicts: z.array(z.object({ files: z.array(z.string()) })) }),
    );
    const { sha, dirty } = await stateOf(wt);
    const judged = dirty ? uncommitted() : await judgedBy(testIn(opts.test, wt), "test", wt, sha);
    return { sha, conflicts: merged.conflicts.map((one) => ({ files: one.files, resolvedBy: opts.integrator })), judged };
  });
}
