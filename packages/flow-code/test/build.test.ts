// The whole-task helpers in a real script, on a real git repository: an implementation judged by
// its test, one the owner did not let start, an integration of branches, a diagnosis that stops at
// a confirmed cause, and a self-test that fails on a failed scenario.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

const dirOf = (call: { cwd?: string }): string => {
  if (call.cwd === undefined) throw new Error("the agent was not started in a directory");
  return call.cwd;
};

test("an economy implementation commits in a new worktree and is judged by its test there", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "work.txt", "done\n") }) });
  const ended = await flow.run(`
    import { implement } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const done = await implement("task", {
        task: "Add work.txt",
        repo: "$REPO",
        mode: "economy",
        seats: { author: "author" },
        test: { cmd: ["sh", "-c", "test -f work.txt"], cwd: "$REPO" },
      });
      return { sha: done.sha, path: done.worktree.path, verdict: done.judged.verdict };
    });`);
  const out = resultOf(ended) as { sha: string; path: string; verdict: string };
  expect(out.verdict).toBe("PASS");
  expect(gitIn(out.path, "rev-parse", "HEAD")).toBe(out.sha);
  expect(out.path).not.toBe(flow.repo);
}, 30_000);

test("an economy implementation whose author leaves the work uncommitted is not judged by its test", async () => {
  const flow = await host({
    author: (call) => {
      writeFileSync(join(dirOf(call), "work.txt"), "done\n");
      return { summary: "done" };
    },
  });
  const ended = await flow.run(`
    import { implement } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const done = await implement("task", {
        task: "Add work.txt",
        repo: "$REPO",
        mode: "economy",
        seats: { author: "author" },
        test: { cmd: ["sh", "-c", "test -f work.txt"], cwd: "$REPO" },
      });
      return { sha: done.sha, path: done.worktree.path, judged: done.judged };
    });`);
  const out = resultOf(ended) as { sha: string; path: string; judged: { verdict: string; findings: Array<{ title: string }> } };
  expect(out.judged.verdict).toBe("FAIL");
  expect(out.judged.findings.map((one) => one.title)).toEqual(["the work was left uncommitted"]);
  expect(out.sha).toBe(gitIn(out.path, "rev-parse", "HEAD"));
}, 30_000);

test("a safe implementation the owner declines to start stops before any worktree or agent", async () => {
  const flow = await host({ author: (call) => ({ sha: commitFile(dirOf(call), "work.txt", "done\n") }) });
  const run = await flow.start(`
    import { implement } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      implement("task", { task: "Add work.txt", repo: "$REPO", mode: "safe", seats: { author: "author" } }).then(
        () => "implemented",
        (error: Error) => error.name + ": " + error.message,
      ));`);
  await flow.answer("decline");
  const ended = (await flow.host.call("workflow.wait" as never, { run, timeoutMs: 30_000 } as never)) as never;
  expect(resultOf(ended)).toBe("ImplementStopped: the owner did not let the task start (declined)");
  expect(flow.calls.author).toEqual([]);
}, 30_000);

test("an integration merges the branches into a worktree of the target and runs the test on the result", async () => {
  const flow = await host({
    integrator: (call) => {
      const dir = dirOf(call);
      gitIn(dir, "merge", "--no-edit", "-q", "feature-a", "feature-b");
      return { sha: gitIn(dir, "rev-parse", "HEAD"), conflicts: [] };
    },
  });
  for (const branch of ["feature-a", "feature-b"]) {
    gitIn(flow.repo, "checkout", "-q", "-b", branch, "main");
    commitFile(flow.repo, `${branch}.txt`, `${branch}\n`);
  }
  gitIn(flow.repo, "checkout", "-q", "main");
  const ended = await flow.run(`
    import { integrate } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      integrate("join", {
        repo: "$REPO",
        into: "main",
        branches: ["feature-a", "feature-b"],
        integrator: "integrator",
        test: { cmd: ["sh", "-c", "test -f feature-a.txt && test -f feature-b.txt"], cwd: "$REPO" },
      }));`);
  const out = resultOf(ended) as { sha: string; conflicts: unknown[]; judged: { verdict: string } };
  expect(out.judged.verdict).toBe("PASS");
  expect(out.conflicts).toEqual([]);
  expect(flow.calls.integrator?.[0]?.prompt).toContain("feature-a, feature-b");
  // niwa never merges into the target itself: main is where it was.
  expect(gitIn(flow.repo, "rev-parse", "main")).not.toBe(out.sha);
}, 30_000);

test("a diagnosis runs the repro each round and stops at the first confirmed cause", async () => {
  let rounds = 0;
  const flow = await host({
    investigator: () => {
      rounds += 1;
      return rounds === 1
        ? { hypotheses: [{ claim: "the cache is stale", status: "open", evidence: "the repro fails after a restart" }] }
        : {
            hypotheses: [
              { claim: "the cache is stale", status: "refuted", evidence: "it fails with the cache off" },
              { claim: "the clock is read twice", status: "confirmed", evidence: "two reads differ by a second" },
            ],
          };
    },
  });
  const ended = await flow.run(`
    import { diagnoseLoop } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const wt = { id: "wt-1", description: "here", repo: "$REPO", path: "$REPO", branch: "main", base: "main", baseSha: "" };
      return diagnoseLoop("why", { symptom: "the total is off by one", wt, repro: { cmd: ["sh", "-c", "echo off by one; exit 1"], cwd: "$REPO" }, investigator: "investigator", max: 3 });
    });`);
  const out = resultOf(ended) as { cause: string | null; hypotheses: Array<{ status: string }> };
  expect(out.cause).toBe("the clock is read twice");
  expect(out.hypotheses.map((one) => one.status)).toEqual(["refuted", "confirmed"]);
  expect(flow.calls.investigator).toHaveLength(2);
  expect(flow.calls.investigator?.[1]?.prompt).toContain("[open] the cache is stale");
  expect(flow.calls.investigator?.[0]?.prompt).toContain("off by one");
}, 30_000);

test("a self-test probes every scenario and fails when one of them fails", async () => {
  const flow = await host({
    probe: (call) => (call.prompt.includes("open the page") ? { status: "pass", evidence: "it opened" } : { status: "fail", evidence: "the total was 9" }),
  });
  const ended = await flow.run(`
    import { selfTest } from "@niwa-labs/flow-code";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      selfTest("probe", {
        probe: "probe",
        scenarios: [
          { id: "open", steps: "open the page", expect: "it opens" },
          { id: "sum", steps: "add two and two", expect: "four" },
        ],
      }));`);
  expect(resultOf(ended)).toEqual({
    verdict: "FAIL",
    rows: [
      { id: "open", status: "pass", evidence: "it opened" },
      { id: "sum", status: "fail", evidence: "the total was 9" },
    ],
  });
}, 30_000);
