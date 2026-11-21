// The example of the flow libraries, run as it is written: a registered script that imports
// `revise`, `verify` and `Attempt` from flow and `inWorktree` from flow-code. Its copy in the home
// finds the libraries through the packages niwa runs with. In a worktree of a real repository the
// author commits, two verifiers judge the commit, and a fail sends the author round again.

import { afterEach, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { codeHost, commitFile, gitIn, resultOf } from "./support.ts";
import type { CodeHost } from "./support.ts";

const hosts: CodeHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

const EXAMPLE = `
import { Attempt, revise, verify } from "@niwa-labs/flow";
import type { Judged } from "@niwa-labs/flow";
import { inWorktree } from "@niwa-labs/flow-code";

const prompt = (task: string, feedback: Judged | null): string =>
  feedback === null ? task : task + "\\n\\nThe last attempt did not pass:\\n" + feedback.findings.map((f) => "- " + f.title + ": " + f.evidence).join("\\n");

export default workflow({
  description: "Fix and verify",
  input: z.object({ task: z.string(), repo: z.string() }),
  output: Attempt(z.object({ sha: z.string() })),
  uses: ["session.start.*", "git.worktree.*"],
  phases: [{ title: "Build" }, { title: "Verify" }],
}, async ({ task, repo }) =>
  inWorktree("wt", { repo }, (wt) =>
    revise("fix", {
      max: 3,
      write: (feedback) => {
        phase("Build");
        return agent(prompt(task, feedback), { harness: "author", cwd: wt.path, schema: z.object({ sha: z.string() }) });
      },
      judge: ({ sha }) => {
        phase("Verify");
        return verify("check", { subject: \`\${repo}@\${sha}\`, by: ["verifier", "verifier-alt"], require: "all" });
      },
    })));
`;

test("the example fixes, verifies and fixes again until both verifiers pass, from its stored copy", async () => {
  let builds = 0;
  let altChecks = 0;
  const flow = await codeHost({
    author: (call) => {
      builds += 1;
      if (call.cwd === undefined) throw new Error("the author was not started in the worktree");
      return { sha: commitFile(call.cwd, "fix.txt", `attempt ${String(builds)}\n`) };
    },
    verifier: () => ({ verdict: "PASS", findings: [] }),
    "verifier-alt": () => {
      altChecks += 1;
      return altChecks === 1 ? { verdict: "FAIL", findings: [{ title: "the edge case is not handled", evidence: "empty input", severity: "blocks" }] } : { verdict: "PASS+NOTES", findings: [{ title: "naming", evidence: "x", severity: "note" }] };
    },
  });
  hosts.push(flow);
  const src = join(flow.home, "example");
  await Bun.write(join(src, ".keep"), "");
  await symlink(realpathSync(join(import.meta.dir, "..", "..", "workflow", "node_modules")), join(src, "node_modules"), "dir");
  await writeFile(join(src, "fix-and-verify.ts"), EXAMPLE);

  const { id, version } = (await flow.host.call("workflow.register" as never, { file: join(src, "fix-and-verify.ts") } as never)) as { id: string; version: string };
  const manifest = JSON.parse(readFileSync(join(flow.home, "workflows", id, `${version}.json`), "utf8")) as { imports: Record<string, string | null> };
  expect(manifest.imports).toEqual({ "@niwa-labs/flow": "0.0.0", "@niwa-labs/flow-code": "0.0.0" });

  const { run } = (await flow.host.call("workflow.start" as never, { id, args: { task: "Handle empty input", repo: flow.repo }, limits: { deadline: 7_200_000 } } as never)) as { run: string };
  const ended = (await flow.host.call("workflow.wait" as never, { run, timeoutMs: 30_000 } as never)) as never;
  const attempt = resultOf(ended) as { value: { sha: string }; judged: { verdict: string; findings: unknown[] }; rounds: number; history: Array<{ verdict: string }>; stopped: string };

  expect(attempt.stopped).toBe("accepted");
  expect(attempt.rounds).toBe(2);
  expect(attempt.history.map((one) => one.verdict)).toEqual(["FAIL", "PASS+NOTES"]);
  expect(attempt.judged.findings).toHaveLength(1);
  expect(flow.calls.author?.[1]?.prompt).toContain("the edge case is not handled");
  // The worktree with the commits is kept, on a branch of its own: niwa never merges.
  const worktree = flow.calls.author?.[1]?.cwd as string;
  expect(gitIn(worktree, "rev-parse", "HEAD")).toBe(attempt.value.sha);
  expect(gitIn(flow.repo, "rev-parse", "main")).not.toBe(attempt.value.sha);
}, 60_000);
