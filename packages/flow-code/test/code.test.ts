// The repository helpers in a real script, on a real git repository: a worktree left clean is
// removed and one with commits is kept; a fork's losers are removed; review and fix stops once the
// reviewers pass; test first needs a test that fails before it passes; debugging and coverage stop
// when their command says so.

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

test("a self-test fails on any failed or broken scenario and is inconclusive with nothing passed", () => {
  expect(selfTestVerdict([{ status: "pass" }, { status: "pass" }])).toBe("PASS");
  expect(selfTestVerdict([{ status: "pass" }, { status: "gated" }])).toBe("PASS+NOTES");
  expect(selfTestVerdict([{ status: "pass" }, { status: "error" }])).toBe("FAIL");
  expect(selfTestVerdict([{ status: "gated" }])).toBe("INCONCLUSIVE");
  expect(selfTestVerdict([])).toBe("INCONCLUSIVE");
});
