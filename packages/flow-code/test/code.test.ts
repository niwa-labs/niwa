// The repository helpers in a real script, on a real git repository: a worktree left clean is
// removed and one with commits is kept; a fork's losers are removed; review and fix stops once the
// reviewers pass; test first needs a test that fails before it passes; debugging and coverage stop
// when their command says so.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { selfTestVerdict } from "../src/index.ts";
import { codeHost, commitFile, gitIn, resultOf } from "./support.ts";
import type { CodeHost, Reply } from "./support.ts";

const hosts: CodeHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

async function host(agents: Record<string, Reply> = {}): Promise<CodeHost> {
  const made = await codeHost(agents);
  hosts.push(made);
  return made;
}

/** The directory an agent call worked in. */
const dirOf = (call: { cwd?: string }): string => {
  if (call.cwd === undefined) throw new Error("the agent was not started in a directory");
  return call.cwd;
};

test("a worktree left clean is removed, and one with a commit is kept with its branch", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "work.txt", "done\n") }) });
  const ended = await flow.run(`
    import { inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const clean = await inWorktree("look", { repo: "$REPO" }, async (wt) => wt.path);
      const kept = await inWorktree("work", { repo: "$REPO" }, async (wt) => {
        const done = await agent("Do the work", { harness: "author", cwd: wt.path, schema: z.object({ sha: z.string() }) });
        return { path: wt.path, branch: wt.branch, sha: done.sha };
      });
      return { clean, kept };
    });`);
  const out = resultOf(ended) as { clean: string; kept: { path: string; branch: string; sha: string } };
  expect(existsSync(out.clean)).toBe(false);
  expect(readFileSync(join(out.kept.path, "work.txt"), "utf8")).toBe("done\n");
  expect(gitIn(flow.repo, "rev-parse", out.kept.branch)).toBe(out.kept.sha);
}, 30_000);

test("forkSelect keeps the picked fork and removes the others with their commits", async () => {
  const build: Reply = (call) => ({ sha: commitFile(dirOf(call), "fork.txt", `${String(call.harness)}\n`) });
  const flow = await host({ a: build, b: build });
  const ended = await flow.run(`
    import { commitBy, forkSelect } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const picked = await forkSelect("race", {
        seats: ["a", "b"],
        repo: "$REPO",
        build: async (seat, wt) => ({ ...(await commitBy(seat, wt, "Build it")), path: wt.path }),
        pick: async () => "b",
      });
      return { winner: picked.winner.id, path: picked.winner.worktree.path, rejected: picked.rejected };
    });`);
  const out = resultOf(ended) as { winner: string; path: string; rejected: string[] };
  expect(out.winner).toBe("b");
  expect(out.rejected).toEqual(["a"]);
  expect(existsSync(out.path)).toBe(true);
  const losers = flow.calls.a?.map(dirOf) ?? [];
  expect(losers).toHaveLength(1);
  expect(existsSync(losers[0] as string)).toBe(false);
}, 30_000);

test("forkSelect refuses a pick that names no build, a name every object has among them", async () => {
  const flow = await host({ a: (call) => ({ sha: commitFile(dirOf(call), "fork.txt", "a\n") }) });
  const ended = await flow.run(`
    import { commitBy, forkSelect } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      forkSelect("race", { seats: ["a"], repo: "$REPO", build: (seat, wt) => commitBy(seat, wt, "Build it"), pick: async () => "constructor" }).then(
        (picked) => "picked " + typeof picked.winner.value,
        (error: Error) => error.message,
      ));`);
  expect(resultOf(ended)).toBe('forkSelect "race": "constructor" is not a build that succeeded');
}, 30_000);

test("forkSelect names why each build failed when none succeeded", async () => {
  const flow = await host({ a: () => ({ sha: "unused" }) });
  const ended = await flow.run(`
    import { forkSelect } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      forkSelect("race", { seats: ["a"], repo: "$REPO", build: async () => { throw new Error("the build broke"); }, pick: async () => "a" }).then(
        () => "picked",
        (error: Error) => error.message,
      ));`);
  expect(resultOf(ended)).toBe('forkSelect "race": no build succeeded (a: the build broke)');
}, 30_000);

test("review and fix sends blocking findings to the author and stops once the reviewers pass", async () => {
  let reviews = 0;
  const flow = await host({
    author: (call) => ({ sha: commitFile(dirOf(call), "fix.txt", "fixed\n") }),
    reviewer: () => {
      reviews += 1;
      return reviews === 1 ? { verdict: "FAIL", findings: [{ title: "no error handling", evidence: "main.ts:3", severity: "blocks" }] } : { verdict: "PASS", findings: [] };
    },
  });
  const ended = await flow.run(`
    import { inWorktree, reviewFix } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await reviewFix("review", { wt, base: "main", author: "author", reviewers: ["reviewer"] });
        return { sha: out.value.sha, rounds: out.rounds, stopped: out.stopped, history: out.history.map((j) => j.verdict) };
      }));`);
  const out = resultOf(ended) as { sha: string; rounds: number; stopped: string; history: string[] };
  expect(out).toMatchObject({ rounds: 2, stopped: "accepted", history: ["FAIL", "PASS"] });
  expect(flow.calls.author?.[0]?.prompt).toContain("no error handling");
  expect(gitIn(dirOf(flow.calls.author?.[0] ?? {}), "rev-parse", "HEAD")).toBe(out.sha);
}, 30_000);

test("the commit a review round reports is the one the worktree is at, not the one the author names", async () => {
  const flow = await host({
    author: (call) => {
      commitFile(dirOf(call), "fix.txt", "fixed\n");
      // The author names a commit that is not the one it made.
      return { sha: "0".repeat(40) };
    },
    reviewer: (call) => (call.prompt.includes(`to the commit ${"0".repeat(40)}`) ? { verdict: "FAIL", findings: [{ title: "no such commit", evidence: "x", severity: "blocks" }] } : { verdict: "PASS", findings: [] }),
  });
  const ended = await flow.run(`
    import { commitBy, inWorktree, reviewFix } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const built = await commitBy("author", wt, "Fix it");
        const out = await reviewFix("review", { wt, base: "main", author: "author", reviewers: ["reviewer"] });
        return { built, sha: out.value.sha, verdict: out.judged.verdict };
      }));`);
  const out = resultOf(ended) as { built: { sha: string; dirty: boolean }; sha: string; verdict: string };
  const worktree = dirOf(flow.calls.author?.[0] ?? {});
  expect(out.built).toEqual({ sha: gitIn(worktree, "rev-parse", "HEAD"), dirty: false });
  expect(out.built.sha).not.toBe("0".repeat(40));
  expect(out.verdict).toBe("PASS");
}, 30_000);

test("a fix left uncommitted is sent back to the author without being reviewed", async () => {
  let fixes = 0;
  let reviews = 0;
  const flow = await host({
    author: (call) => {
      fixes += 1;
      // The first fix is written and not committed: the review would not see it.
      if (fixes === 1) writeFileSync(join(dirOf(call), "fix.txt"), "fixed\n");
      else commitFile(dirOf(call), "fix.txt", "fixed\n");
      return { summary: "done" };
    },
    reviewer: () => {
      reviews += 1;
      return reviews === 1 ? { verdict: "FAIL", findings: [{ title: "not handled", evidence: "main.ts", severity: "blocks" }] } : { verdict: "PASS", findings: [] };
    },
  });
  const ended = await flow.run(`
    import { inWorktree, reviewFix } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await reviewFix("review", { wt, base: "main", author: "author", reviewers: ["reviewer"] });
        return { history: out.history.map((j) => j.verdict), titles: out.history.map((j) => j.findings.map((f) => f.title)) };
      }));`);
  expect(resultOf(ended)).toEqual({ history: ["FAIL", "FAIL", "PASS"], titles: [["not handled"], ["the work was left uncommitted"], []] });
  expect(reviews).toBe(2);
}, 30_000);

test("a passing check that changes the worktree cannot clear a review round", async () => {
  const flow = await host({ reviewer: () => ({ verdict: "PASS", findings: [] }) });
  const ended = await flow.run(`
    import { inWorktree, reviewFix } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await reviewFix("review", {
          wt, base: "main", author: "reviewer", reviewers: ["reviewer"], max: 1,
          test: { cmd: ["sh", "-c", "touch uncommitted.txt"], cwd: wt.path },
        });
        return { verdict: out.judged.verdict, check: out.value.check?.digest, findings: out.judged.findings };
      }));`);
  expect(resultOf(ended)).toMatchObject({
    verdict: "FAIL",
    check: expect.stringMatching(/^sha256:/),
    findings: [{ title: "the work was left uncommitted" }],
  });
  expect(flow.calls.reviewer).toEqual([]);
}, 30_000);

test("a review panel names the reviewer that could not look, apart from a clean review", async () => {
  const flow = await host({
    author: () => ({ summary: "unused" }),
    careful: () => ({ findings: [{ title: "unchecked input", evidence: "main.ts:9", severity: "blocks" }] }),
    // An answer that is not what was asked for.
    absent: () => ({ findings: "none" }),
  });
  const ended = await flow.run(`
    import { inWorktree, reviewPanel } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, (wt) => reviewPanel("panel", { wt, base: "main", reviewers: ["careful", "absent"], lenses: ["security", "style"] })));`);
  const out = resultOf(ended) as { findings: Array<{ title: string }>; byLens: Record<string, unknown[]>; failures: Array<{ reviewer: string; lens: string; error: string }> };
  expect(out.findings.map((one) => one.title)).toEqual(["unchecked input"]);
  expect(out.failures.map((one) => `${one.reviewer}/${one.lens}`)).toEqual(["absent/security", "absent/style"]);
  expect(out.failures[0]?.error).not.toBe("");
}, 30_000);

test("test first takes a test that fails before the change, then a change that makes it pass", async () => {
  let reds = 0;
  const flow = await host({
    author: (call) => {
      const dir = dirOf(call);
      if (call.prompt.includes("fails now")) {
        reds += 1;
        // The first test it writes passes already: it is sent back.
        return { sha: commitFile(dir, "check.sh", reds === 1 ? "exit 0\n" : "test -f impl.txt\n") };
      }
      return { sha: commitFile(dir, "impl.txt", "impl\n") };
    },
  });
  const ended = await flow.run(`
    import { inWorktree, tddLoop } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await tddLoop("tdd", { task: "add impl", wt, author: "author", test: { cmd: ["sh", "check.sh"], cwd: wt.path } });
        return { red: out.value.redSha !== "", stopped: out.stopped, history: out.history.map((j) => j.verdict) };
      }));`);
  expect(resultOf(ended)).toEqual({ red: true, stopped: "accepted", history: ["FAIL", "PASS"] });
  expect(reds).toBe(2);
}, 30_000);

test("a red-phase check that changes the worktree cannot establish a failing commit", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "check.txt", "x\n") }) });
  const ended = await flow.run(`
    import { inWorktree, tddLoop } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await tddLoop("tdd", {
          task: "add a test", wt, author: "author", max: 1,
          test: { cmd: ["sh", "-c", "touch uncommitted.txt; exit 1"], cwd: wt.path },
        });
        return { redSha: out.value.redSha, judged: out.judged };
      }));`);
  expect(resultOf(ended)).toMatchObject({ redSha: "", judged: { verdict: "FAIL", findings: [{ title: "the work was left uncommitted" }] } });
  expect(flow.calls.author).toHaveLength(1);
}, 30_000);

test("debugging needs a failing repro, and fixes until the repro passes", async () => {
  let tries = 0;
  const flow = await host({
    author: (call) => {
      tries += 1;
      const dir = dirOf(call);
      return { sha: commitFile(dir, tries === 1 ? "wrong.txt" : "fixed.txt", "x\n"), cause: tries === 1 ? "a guess" : "the file was missing" };
    },
  });
  const ended = await flow.run(`
    import { debugLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await debugLoop("bug", { symptom: "fixed.txt is missing", wt, author: "author", repro: { cmd: ["test", "-f", "fixed.txt"], cwd: wt.path } });
        const none = await debugLoop("nobug", { symptom: "nothing", wt, author: "author", repro: { cmd: ["true"], cwd: wt.path } });
        return { cause: out.cause, verdict: out.judged.verdict, none: none.judged.verdict, noneSha: none.sha };
      }));`);
  expect(resultOf(ended)).toEqual({ cause: "the file was missing", verdict: "PASS", none: "INCONCLUSIVE", noneSha: "" });
  expect(tries).toBe(2);
}, 30_000);

test("a passing repro that changes the worktree cannot clear a bug fix", async () => {
  const flow = await host({ author: (call) => ({ cause: "missing file", sha: commitFile(dirOf(call), "fixed.txt", "x\n") }) });
  const ended = await flow.run(`
    import { debugLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await debugLoop("bug", {
          wt, symptom: "missing file", author: "author", max: 1,
          repro: { cmd: ["sh", "-c", "test -f fixed.txt && touch uncommitted.txt"], cwd: wt.path },
        });
        return out.judged;
      }));`);
  expect(resultOf(ended)).toMatchObject({ verdict: "FAIL", findings: [{ title: "the work was left uncommitted" }] });
}, 30_000);

test("coverage rises round by round until the measure reports the threshold", async () => {
  const flow = await host({
    author: (call) => {
      const dir = dirOf(call);
      const now = Number(readFileSync(join(dir, "cov.txt"), "utf8"));
      return { sha: commitFile(dir, "cov.txt", String(now + 0.25)) };
    },
  });
  const ended = await flow.run(`
    import { coverageLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        await call("proc.run", { cmd: ["sh", "-c", "echo 0.25 > cov.txt"], cwd: wt.path, timeout: 1000 });
        const out = await coverageLoop("cov", { wt, threshold: 0.7, author: "author", measure: { cmd: ["sh", "-c", 'echo "{\\\\"coverage\\\\": $(cat cov.txt)}"'], cwd: wt.path } });
        return { before: out.before, after: out.after, reached: out.reached };
      }));`);
  expect(resultOf(ended)).toEqual({ before: 0.25, after: 0.75, reached: true });
  expect(flow.calls.author).toHaveLength(2);
}, 30_000);

test("a coverage measure that changes a committed round cannot reach the threshold", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "added.txt", "x\n") }) });
  const ended = await flow.run(`
    import { coverageLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, (wt) => coverageLoop("cov", {
        wt, threshold: 0.5, author: "author", max: 1,
        measure: {
          cmd: ["sh", "-c", "if test -f added.txt; then touch uncommitted.txt; echo '{\\"coverage\\": 1}'; else echo '{\\"coverage\\": 0}'; fi"],
          cwd: wt.path,
        },
      })));`);
  expect(resultOf(ended)).toMatchObject({ before: 0, after: 0, reached: false, failure: { reason: expect.stringContaining("the work was left uncommitted") } });
}, 30_000);

test("a coverage measure that fails gives no coverage, whatever it printed", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "t.txt", "x\n") }) });
  const ended = await flow.run(`
    import { coverageLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, (wt) =>
        coverageLoop("cov", { wt, threshold: 0.5, author: "author", measure: { cmd: ["sh", "-c", "echo '{\\"coverage\\": 1}'; echo tests crashed; exit 1"], cwd: wt.path } }).then(
          () => "measured",
          (error: any) => ({ name: error.name, message: error.message, digest: error.artifact?.digest }),
        )));`);
  const out = resultOf(ended) as { name: string; message: string; digest: string };
  expect(out.name).toBe("MeasureFailed");
  expect(out.message).toContain("tests crashed");
  expect(out.digest).toMatch(/^sha256:/);
  expect(flow.calls.author).toHaveLength(0);
}, 30_000);

test("a coverage measure that fails after a round is sent to the author and is the last word when it stays failed", async () => {
  const flow = await host({
    author: (call) => {
      const dir = dirOf(call);
      if (call.prompt.includes("did not count")) {
        gitIn(dir, "rm", "-q", "broken");
        gitIn(dir, "commit", "-q", "-m", "mend");
        return { sha: gitIn(dir, "rev-parse", "HEAD") };
      }
      return { sha: commitFile(dir, "broken", "x\n") };
    },
  });
  const ended = await flow.run(`
    import { coverageLoop, inWorktree } from "@niwa-labs/flow-code";
    const measure = (cwd: string) => ({ cmd: ["sh", "-c", "if test -f broken; then echo suite crashed; exit 1; fi; echo '{\\"coverage\\": 0.25}'"], cwd });
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const stuck = await inWorktree("one", { repo: "$REPO" }, (wt) => coverageLoop("cov", { wt, threshold: 0.7, author: "author", max: 1, measure: measure(wt.path) }));
      const mended = await inWorktree("two", { repo: "$REPO" }, (wt) => coverageLoop("cov", { wt, threshold: 0.7, author: "author", max: 2, measure: measure(wt.path) }));
      return { stuck, mended };
    });`);
  const out = resultOf(ended) as { stuck: { after: number; reached: boolean; failure?: { reason: string } }; mended: { reached: boolean; failure?: unknown } };
  expect(out.stuck).toMatchObject({ before: 0.25, after: 0.25, reached: false });
  expect(out.stuck.failure?.reason).toContain("suite crashed");
  expect(out.mended.failure).toBeUndefined();
  expect(flow.calls.author?.[2]?.prompt).toContain("suite crashed");
}, 30_000);

test("a test that times out in the red phase has shown no failure", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), call.prompt.includes("fails now") ? "check.sh" : "impl.txt", "x\n") }) });
  const ended = await flow.run(`
    import { inWorktree, tddLoop } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        // It hangs until impl.txt exists: the red phase times out, and the green phase would pass.
        const test = { cmd: ["sh", "-c", "if test -f impl.txt; then exit 0; fi; exec sleep 5"], cwd: wt.path, timeout: 300 };
        const out = await tddLoop("tdd", { task: "add impl", wt, author: "author", test, max: 1 });
        return { stopped: out.stopped, redSha: out.value.redSha, titles: out.judged.findings.map((f) => f.title) };
      }));`);
  expect(resultOf(ended)).toEqual({ stopped: "max-rounds", redSha: "", titles: ["the new test did not finish"] });
  expect(flow.calls.author).toHaveLength(1);
}, 30_000);

test("a repro that times out is no bug to fix", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "x.txt", "x\n"), cause: "none" }) });
  const ended = await flow.run(`
    import { debugLoop, inWorktree } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      inWorktree("wt", { repo: "$REPO" }, async (wt) => {
        const out = await debugLoop("bug", { symptom: "it hangs", wt, author: "author", repro: { cmd: ["sh", "-c", "exec sleep 5"], cwd: wt.path, timeout: 300 } });
        return { verdict: out.judged.verdict, sha: out.sha, titles: out.judged.findings.map((f) => f.title) };
      }));`);
  expect(resultOf(ended)).toEqual({ verdict: "INCONCLUSIVE", sha: "", titles: ["the repro did not finish"] });
  expect(flow.calls.author).toHaveLength(0);
}, 30_000);

test("a self-test fails on any failed or broken scenario and is inconclusive with nothing passed", () => {
  expect(selfTestVerdict([{ status: "pass" }, { status: "pass" }])).toBe("PASS");
  expect(selfTestVerdict([{ status: "pass" }, { status: "gated" }])).toBe("PASS+NOTES");
  expect(selfTestVerdict([{ status: "pass" }, { status: "error" }])).toBe("FAIL");
  expect(selfTestVerdict([{ status: "gated" }])).toBe("INCONCLUSIVE");
  expect(selfTestVerdict([])).toBe("INCONCLUSIVE");
});
