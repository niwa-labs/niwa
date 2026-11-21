// What looking at the heads of worktrees records: a change once, even when two looks overlap, and the remote a
// worktree's work goes to when it changes.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { gitHeadObserve, gitWorktreeCreate } from "../src/index.ts";
import { gitIn, makeRepo } from "./git-repo.ts";
import { closeAll, opened, served } from "./served.ts";

const held = opened();
afterEach(() => closeAll(held));

test("two looks at a worktree that overlap record its moved head once", async () => {
  const repo = await makeRepo();
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "two observers" });
  writeFileSync(join(made.path, "work.txt"), "work\n");
  gitIn(made.path, "add", "work.txt");
  gitIn(made.path, "commit", "-q", "-m", "work");

  const [first, second] = await Promise.all([host.call(gitHeadObserve, {}), host.call(gitHeadObserve, {})]);

  const head = gitIn(made.path, "rev-parse", "HEAD");
  expect([...first.moved, ...second.moved]).toEqual([{ worktree: made.id, head }]);
  expect((await host.records.read()).filter((row) => row.type === "git.head.moved")).toHaveLength(1);
});

test("a change of the remote a worktree's work goes to is recorded when it is seen, and its removal too", async () => {
  const repo = await makeRepo();
  gitIn(repo, "remote", "add", "origin", "https://forge.example/acme/app.git");
  const { host } = await served(held);
  const made = await host.call(gitWorktreeCreate, { repo, description: "a worktree with a remote" });
  const remotes = async () =>
    (await host.records.read()).filter((row) => row.type === "git.remote.updated").map((row) => row.data as { worktree: string; remote?: { host: string; path: string } });

  await host.call(gitHeadObserve, {});
  await host.call(gitHeadObserve, {});
  expect(await remotes()).toEqual([{ worktree: made.id, repo, remote: { name: "origin", host: "forge.example", path: "acme/app" } }]);

  gitIn(repo, "remote", "set-url", "origin", "https://forge.example/acme/renamed.git");
  await host.call(gitHeadObserve, {});
  gitIn(repo, "remote", "remove", "origin");
  await host.call(gitHeadObserve, {});
  await host.call(gitHeadObserve, {});

  expect((await remotes()).map((row) => row.remote?.path)).toEqual(["acme/app", "acme/renamed", undefined]);
});
