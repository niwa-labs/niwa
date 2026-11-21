import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@niwa-labs/client";
import { actionName, grant, principalOf } from "@niwa-labs/core";
import { gitWorktreeCreate } from "@niwa-labs/git/records";
import { HarnessInstanceRegistry } from "@niwa-labs/harness";
import { createNiwa } from "@niwa-labs/host";
import { procRun, fileTarget } from "@niwa-labs/proc";
import { nono, sandbox } from "@niwa-labs/sandbox";
import { fakeHarness, live, tempDir, tempHome } from "@niwa-labs/testing";
import { defaultComposition } from "../src/composition.ts";

const adapter = nono();
test.skipIf(!live || !(await adapter.available()))("the default composition reopens a registered checkout for a scoped nono Git commit", async () => {
  const home = await tempHome();
  const repo = realpathSync(await tempDir("box-binding-repo"));
  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(["git", "-c", "user.name=niwa", "-c", "user.email=niwa@example.com", ...args], {
      cwd, env: {...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"},
    });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  const registry = new HarnessInstanceRegistry();
  const harness = fakeHarness();
  registry.register(harness.binding);
  const plans: ReturnType<ReturnType<typeof sandbox>["plan"]>[] = [];
  const boxes = sandbox({adapter});
  const boot = () => {
    const host = createNiwa({home: home.path});
    host.use(...defaultComposition({home: home.path, harnesses: registry, git: {cleanup: false}, sandbox: {
      ...boxes, plan: input => { const result = boxes.plan(input); plans.push(result); return result; },
    }}));
    return host;
  };
  let host = boot();
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    await host.serve();
    const tree = await host.call(gitWorktreeCreate, {repo, description: "authoring checkout"});
    await host.close();
    host = boot();
    await host.serve();
    const cwd = realpathSync(tree.path);
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "answer"), "ok\n");
    const scoped = async (id: string, rules: string[]) => connect({home: home.path, id,
      token: host.issueToken(principalOf("run", id), {grant: grant(rules)}),
    });
    const author = await scoped("author", [`proc.run@${fileTarget(cwd)}`]);
    try {
      const result = await author.call(procRun, {cwd, cmd: ["/bin/sh", "-ec",
        "git add src/answer && git -c user.name=niwa -c user.email=niwa@example.com commit -qm author-change",
      ], timeout: 30000});
      expect(result.exit, result.tail).toBe(0);
      expect(git(cwd, "log", "-1", "--format=%s")).toBe("author-change");
      expect(git(repo, "log", "-1", "--format=%s")).toBe("base");
    } finally { await author.close(); }
    const reader = await scoped("reader", []);
    try {
      await expect(reader.call(procRun, {cwd, cmd: ["/usr/bin/true"], timeout: 5000})).rejects.toThrow();
    } finally { await reader.close(); }
    const previousPlans = plans.length;
    await host.call(actionName("session.start"), {harness: harness.instance.id, cwd, prompt: "review", box: {allow: ["project"]}});
    expect(plans.length).toBeGreaterThan(previousPlans);
    expect(plans.at(-1)?.paths).toContainEqual({from: "repository", mode: "write", path: join(repo, ".git", "worktrees", tree.id)});
  } finally { await host.close(); await home.cleanup(); rmSync(repo, {recursive: true, force: true}); }
});
