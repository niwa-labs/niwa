// What a remove of a worktree keeps: a directory git will not remove, work committed on a detached head, work in a
// repository whose checkout the worktree was made from, and a directory that took the place of a removed worktree.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gitWorktreeCreate, gitWorktreeGet, gitWorktreeList, gitWorktreeRemove } from "../src/index.ts";
import { gitIn, makeRepo } from "./git-repo.ts";
import { closeAll, opened, refusalOf, served } from "./served.ts";

const held = opened();
afterEach(() => closeAll(held));

test("a remove leaves a worktree git will not remove, and removes it with force", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "locked by its owner" });
  gitIn(repo, "worktree", "lock", made.path);

  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("changed");
  expect(existsSync(made.path)).toBe(true);
  expect(gitIn(repo, "branch", "--list", made.id)).not.toBe("");
  expect((await host.records.read()).filter((row) => row.type === "git.worktree.removed")).toEqual([]);

  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
  expect(existsSync(made.path)).toBe(false);
  expect(gitIn(repo, "branch", "--list", made.id)).toBe("");
});

test("commits made after the head was detached hold the worktree, though its branch is at the base", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "detached work" });
  gitIn(made.path, "switch", "-q", "--detach");
  writeFileSync(join(made.path, "kept.txt"), "work\n");
  gitIn(made.path, "add", "kept.txt");
  gitIn(made.path, "commit", "-q", "-m", "work on a detached head");

  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ dirty: false, aheadOfBase: 1 });
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("ahead");
  expect(existsSync(made.path)).toBe(true);

  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
  expect(existsSync(made.path)).toBe(false);
});

test("a worktree made from a linked worktree belongs to the repository that owns it, and keeps its commits when the source goes", async () => {
  const repo = await makeRepo();
  const source = join(repo, "..", `linked-${String(Date.now())}`);
  gitIn(repo, "worktree", "add", "-q", "-b", "source", source);
  writeFileSync(join(source, "source.txt"), "source work\n");
  writeFileSync(join(source, ".env"), "TOKEN=source\n");
  gitIn(source, "add", "source.txt");
  gitIn(source, "commit", "-q", "-m", "source work");
  const base = gitIn(source, "rev-parse", "HEAD");
  const { host } = await served(held);

  const made = await host.call(gitWorktreeCreate, { repo: source, description: "from a linked checkout" });
  expect(made).toMatchObject({ repo, base: "source", baseSha: base });
  expect(readFileSync(join(made.path, ".env"), "utf8")).toBe("TOKEN=source\n");
  writeFileSync(join(made.path, "child.txt"), "work\n");
  gitIn(made.path, "add", "child.txt");
  gitIn(made.path, "commit", "-q", "-m", "child work");
  gitIn(repo, "worktree", "remove", "--force", source);

  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ aheadOfBase: 1 });
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("ahead");
  expect(existsSync(made.path)).toBe(true);
  expect(gitIn(repo, "branch", "--list", made.id)).not.toBe("");
});

test("a worktree whose repository is gone is not known to be clean, and is removed with force", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "its repository goes" });
  rmSync(repo, { recursive: true, force: true });

  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("unverifiable");
  expect(existsSync(made.path)).toBe(true);
  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
  expect(existsSync(made.path)).toBe(false);
});

test("a directory that took the place of a removed worktree is an orphan that a remove can remove with force", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "removed, then replaced" });
  expect(await host.call(gitWorktreeRemove, { id: made.id })).toEqual({ id: made.id, removed: true });
  expect(await host.call(gitWorktreeRemove, { id: made.id })).toEqual({ id: made.id, removed: false });

  mkdirSync(made.path, { recursive: true });
  expect((await host.call(gitWorktreeList, {})).items).toMatchObject([{ id: made.id, state: "orphan" }]);
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("orphan");
  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
  expect(existsSync(made.path)).toBe(false);
  expect(await host.call(gitWorktreeRemove, { id: made.id })).toEqual({ id: made.id, removed: false });
});

test("force keeps an unrelated checkout that replaced a recorded worktree", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "replaced checkout" });
  gitIn(repo, "worktree", "remove", made.path);
  mkdirSync(made.path);
  gitIn(made.path, "init", "-q");
  writeFileSync(join(made.path, "owner.txt"), "keep me\n");

  await expect(refusalOf(host.call(gitWorktreeRemove, { id: made.id, force: true }))).resolves.toBe("changed");
  expect(readFileSync(join(made.path, "owner.txt"), "utf8")).toBe("keep me\n");
  expect(gitIn(repo, "branch", "--list", made.id)).not.toBe("");
});

test("overlapping removals report one outcome and write one removed record", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "two removals" });

  const results = await Promise.all([
    host.call(gitWorktreeRemove, { id: made.id }),
    host.call(gitWorktreeRemove, { id: made.id }),
  ]);

  expect(results.map(({ removed }) => removed).sort()).toEqual([false, true]);
  expect((await host.records.read()).filter((row) => row.type === "git.worktree.removed")).toHaveLength(1);
});
