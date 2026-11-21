import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { record } from "@niwa-labs/core";
import { createNiwa, plugin, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

import { git, gitWorktreeCreate, gitWorktreeGet, gitWorktreeRemove } from "../src/index.ts";
import { gitIn, makeRepo } from "./git-repo.ts";
import { closeAll, opened, refusalOf } from "./served.ts";

const held = opened();
afterEach(() => closeAll(held));

const Started = record("session.started", z.object({ session: z.string(), id: z.string(), cwd: z.string() }));
const project = { host: "example.invalid", path: "group/repository" };

async function fixture() {
  const repo = await makeRepo();
  gitIn(repo, "rm", "-q", ".worktreeinclude");
  gitIn(repo, "commit", "-q", "-m", "use a worktree without copied ignored files");
  gitIn(repo, "remote", "add", "origin", `https://${project.host}/${project.path}.git`);
  const home = await tempHome();
  held.homes.push(home);
  const host = createNiwa({ home: home.path });
  held.hosts.push(host);
  host.use(git({ cleanup: false }), plugin("test-sessions", (api) => api.declare(Started)));
  await host.serve();
  const tree = await host.call(gitWorktreeCreate, { repo, description: "selected worktree" });
  const match = {
    id: tree.id,
    onlyIf: { repo: tree.repo, path: tree.path, branch: tree.branch, head: tree.baseSha, project },
  };
  return { repo, host, tree, match };
}

test("remove only the selected checkout at the expected HEAD and retain its commits", async () => {
  const { repo, host, tree, match } = await fixture();
  writeFileSync(join(tree.path, "work.txt"), "a commit ahead of the local base\n");
  gitIn(tree.path, "add", "work.txt");
  gitIn(tree.path, "commit", "-q", "-m", "keep these commits independently of the checkout");
  const head = gitIn(tree.path, "rev-parse", "HEAD");
  const other = await host.call(gitWorktreeCreate, { repo, base: head, description: "another checkout at exactly the same HEAD" });
  expect(gitIn(other.path, "rev-parse", "HEAD")).toBe(head);
  const args = { ...match, onlyIf: { ...match.onlyIf, head } };
  await expect(host.call(gitWorktreeRemove, { ...args, force: true })).rejects.toThrow("onlyIf cannot be combined with force");
  expect(await host.call(gitWorktreeRemove, args)).toEqual({ id: tree.id, removed: true });
  expect(await host.call(gitWorktreeRemove, args)).toEqual({ id: tree.id, removed: false });
  expect(existsSync(tree.path)).toBe(false);
  expect(gitIn(other.path, "rev-parse", "HEAD")).toBe(head);
  expect(gitIn(repo, "rev-parse", tree.branch)).toBe(head);
  expect(await host.records.read()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "git.worktree.removal.claimed", data: { id: tree.id, onlyIf: args.onlyIf } }),
    expect.objectContaining({ type: "git.worktree.removed", data: { id: tree.id, forced: false, branchKept: true } }),
  ]));
});

test("keep a checkout locked or changed after inspecting it", async () => {
  const { repo, host, tree, match } = await fixture();
  expect((await host.call(gitWorktreeGet, { id: tree.id })).dirty).toBe(false);
  gitIn(repo, "worktree", "lock", tree.path);
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("changed");
  expect(existsSync(tree.path)).toBe(true);
  gitIn(repo, "worktree", "unlock", tree.path);
  writeFileSync(join(tree.path, "README.md"), "uncommitted\n");
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("dirty");
  expect(readFileSync(join(tree.path, "README.md"), "utf8")).toBe("uncommitted\n");
  gitIn(tree.path, "add", "README.md");
  gitIn(tree.path, "commit", "-q", "-m", "new HEAD after the PR receipt");
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("changed");
  expect(existsSync(tree.path)).toBe(true);
});

test("keep local-only files and reject changing the verified forge project", async () => {
  const { repo, host, tree, match } = await fixture();
  writeFileSync(join(tree.path, ".env"), "local only\n");
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("dirty");
  expect(readFileSync(join(tree.path, ".env"), "utf8")).toBe("local only\n");
  gitIn(repo, "remote", "set-url", "origin", "https://example.invalid/another/repository.git");
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("changed");
  expect(existsSync(tree.path)).toBe(true);
});

test("keep a worktree when a session started inside it after inspection", async () => {
  const { host, tree, match } = await fixture();
  expect((await host.call(gitWorktreeGet, { id: tree.id })).sessions).toEqual([]);
  await host.emit(Started, { session: "fixture native", id: "s-fixture", cwd: join(tree.path, "src") });
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("live-session");
  expect(existsSync(tree.path)).toBe(true);
});

test("keep a different checkout placed at the same path, branch and HEAD", async () => {
  const { repo, host, tree, match } = await fixture();
  renameSync(tree.path, join(tree.path, "..", "retained-original"));
  gitIn(repo, "worktree", "prune", "--expire=now");
  gitIn(repo, "worktree", "add", "-q", tree.path, tree.branch);
  expect(gitIn(tree.path, "rev-parse", "HEAD")).toBe(tree.baseSha);
  expect(await refusalOf(host.call(gitWorktreeRemove, match))).toBe("changed");
  expect(existsSync(tree.path)).toBe(true);
});
