// What a create copies in and what it says of the remote: an ignored file never replaces what the base tracks, a
// push goes to the remote git would push to, and a remote that is not plainly one project is not shown.

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { remoteProject, verifiedRemote } from "../src/git.ts";
import { gitWorktreeCreate, gitWorktreeGet } from "../src/index.ts";
import { gitIn, makeRepo } from "./git-repo.ts";
import { closeAll, opened, served } from "./served.ts";

const held = opened();
afterEach(() => closeAll(held));

test("an ignored file does not replace the version of it that the base tracks", async () => {
  const repo = await makeRepo();
  // The base tracks local.cfg; the checkout the worktree is made from ignores it and holds its own version.
  writeFileSync(join(repo, "local.cfg"), "tracked\n");
  gitIn(repo, "add", "local.cfg");
  gitIn(repo, "commit", "-q", "-m", "track the config");
  const base = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "rm", "-q", "--cached", "local.cfg");
  writeFileSync(join(repo, ".gitignore"), ".env\nsecret.local\nnode_modules/\nlocal.cfg\n");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\nnode_modules/\nplain.txt\nlocal.cfg\n");
  gitIn(repo, "add", ".gitignore", ".worktreeinclude");
  gitIn(repo, "commit", "-q", "-m", "ignore the config");
  writeFileSync(join(repo, "local.cfg"), "mine\n");
  const { host } = await served(held);

  const made = await host.call(gitWorktreeCreate, { repo, base, description: "from the commit that tracks it" });

  expect(readFileSync(join(made.path, "local.cfg"), "utf8")).toBe("tracked\n");
  expect(readFileSync(join(made.path, ".env"), "utf8")).toBe("TOKEN=1\n");
  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ dirty: false });
});

test("a remote URL with a path that is not valid percent-encoding names no project", () => {
  expect(remoteProject("https://example.org/group/100%.git")).toBeUndefined();
  expect(remoteProject("https://example.org/group/name%20x.git")).toBeUndefined();
  expect(remoteProject("https://Example.org/group/name.git")).toEqual({ host: "example.org", path: "group/name" });
});

test("the remote shown is the one a push of the base goes to, and every push URL must name that project", async () => {
  const repo = await makeRepo();
  gitIn(repo, "remote", "add", "upstream", "https://forge.example/acme/app.git");
  gitIn(repo, "remote", "add", "fork", "git@forge.example:me/app.git");
  gitIn(repo, "config", "branch.main.remote", "upstream");

  expect(await verifiedRemote(repo, "main")).toEqual({ name: "upstream", host: "forge.example", path: "acme/app" });
  // A fork workflow: the branch tracks upstream, and pushes go to the fork.
  gitIn(repo, "config", "branch.main.pushRemote", "fork");
  expect(await verifiedRemote(repo, "main")).toEqual({ name: "fork", host: "forge.example", path: "me/app" });
  gitIn(repo, "config", "--unset", "branch.main.pushRemote");
  gitIn(repo, "config", "remote.pushDefault", "fork");
  expect(await verifiedRemote(repo, "main")).toEqual({ name: "fork", host: "forge.example", path: "me/app" });

  // A second push URL on another project is not one project.
  gitIn(repo, "remote", "set-url", "--add", "--push", "fork", "git@forge.example:me/app.git");
  gitIn(repo, "remote", "set-url", "--add", "--push", "fork", "git@forge.example:other/app.git");
  expect(await verifiedRemote(repo, "main")).toBeUndefined();
});

test("an unconfigured branch pushes to the only remote even when it is not origin", async () => {
  const repo = await makeRepo();
  gitIn(repo, "remote", "add", "fork", "git@forge.example:me/app.git");
  expect(await verifiedRemote(repo, "main")).toEqual({ name: "fork", host: "forge.example", path: "me/app" });

  gitIn(repo, "remote", "add", "upstream", "https://forge.example/acme/app.git");
  expect(await verifiedRemote(repo, "main")).toBeUndefined();

  gitIn(repo, "remote", "add", "origin", "https://forge.example/acme/app.git");
  expect(await verifiedRemote(repo, "main")).toEqual({ name: "origin", host: "forge.example", path: "acme/app" });
});
