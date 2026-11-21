// A create or a look that was cut off is made again under the same operation and ends as if it had not been cut:
// the base is the one reserved, not the one the base branch has moved to, and the records a look wrote are written
// again in their places before it goes on.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempHome } from "@niwa-labs/testing";

import type { Worktree } from "../src/index.ts";
import { gitIn, makeRepo } from "./git-repo.ts";
import { CutOff, MemoryJournal, module, run } from "./replay.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await home.cleanup();
});

async function setup() {
  const home = await tempHome();
  homes.push(home);
  const journal = new MemoryJournal();
  return { journal, actions: module(journal, home.path), repo: await makeRepo() };
}

const NOTE = { description: "a worktree" };

function commitIn(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  gitIn(dir, "add", file);
  gitIn(dir, "commit", "-q", "-m", file);
  return gitIn(dir, "rev-parse", "HEAD");
}

test("a create cut off after its checkout, made again after the base moved, records the commit it reserved", async () => {
  const { journal, actions, repo } = await setup();
  const reservedAt = gitIn(repo, "rev-parse", "HEAD");

  // The checkout is made; the host stops before the worktree is recorded (the record after the reservation).
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-1", 2)).rejects.toBeInstanceOf(CutOff);
  expect(journal.of("git.worktree.created")).toEqual([]);
  commitIn(repo, "moved-on.txt");

  const made = await run<Worktree>(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-1");

  expect(made.baseSha).toBe(reservedAt);
  expect(gitIn(made.path, "rev-parse", "HEAD")).toBe(reservedAt);
  expect(existsSync(join(made.path, "moved-on.txt"))).toBe(false);
  expect(journal.of("git.worktree.reserved")).toHaveLength(1);
  expect(journal.of("git.worktree.created").map((row) => row.data)).toEqual([made]);
});

test("a create made again does not take a branch of that name that is somewhere else", async () => {
  const { journal, actions, repo } = await setup();
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-2", 2)).rejects.toBeInstanceOf(CutOff);
  const [reserved] = journal.of("git.worktree.reserved");
  const { id, path } = reserved?.data as Worktree;
  gitIn(repo, "worktree", "remove", "--force", path);
  const elsewhere = commitIn(repo, "elsewhere.txt");
  gitIn(repo, "branch", "-f", id, elsewhere);

  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-2")).rejects.toMatchObject({ code: "occupied" });
  expect(journal.of("git.worktree.created")).toEqual([]);
});

test("a create made again does not take a checkout of another repository at its directory", async () => {
  const { journal, actions, repo } = await setup();
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-3", 2)).rejects.toBeInstanceOf(CutOff);
  const [reserved] = journal.of("git.worktree.reserved");
  const { id, path } = reserved?.data as Worktree;
  gitIn(repo, "worktree", "remove", "--force", path);
  // Another repository has a checkout there, on a branch of the same name.
  const other = await makeRepo();
  gitIn(other, "worktree", "add", "-q", "-b", id, path);

  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-3")).rejects.toMatchObject({ code: "occupied" });
  expect(journal.of("git.worktree.created")).toEqual([]);
});

test("a create made again keeps the files its first attempt copied in, as they are now", async () => {
  const { journal, actions, repo } = await setup();
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-4", 2)).rejects.toBeInstanceOf(CutOff);
  const [reserved] = journal.of("git.worktree.reserved");
  const { path } = reserved?.data as Worktree;
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("TOKEN=1\n");
  writeFileSync(join(path, ".env"), "TOKEN=2\n");

  await run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-4");

  expect(readFileSync(join(path, ".env"), "utf8")).toBe("TOKEN=2\n");
});

test("a checkout with a replaced destination directory does not write outside the worktree", async () => {
  const { journal, actions, repo } = await setup();
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-linked-copy", 2)).rejects.toBeInstanceOf(CutOff);
  const [reserved] = journal.of("git.worktree.reserved");
  const { path } = reserved?.data as Worktree;
  const outside = join(repo, "outside");
  mkdirSync(outside);
  rmSync(join(path, "node_modules"), { recursive: true });
  symlinkSync(outside, join(path, "node_modules"), "dir");

  await run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-linked-copy");

  expect(existsSync(join(outside, "pkg"))).toBe(false);
});

test("a worktree created before reservations can still be named and its create replayed", async () => {
  const { journal, actions, repo } = await setup();
  const operation = "old-create";
  const made = await run<Worktree>(actions, journal, "git.worktree.create", { repo, ...NOTE }, operation);
  const [birth] = journal.of("git.worktree.reserved");
  const [created] = journal.of("git.worktree.created");
  if (birth === undefined || created === undefined) throw new Error("the create must write both records");
  journal.records.splice(0, journal.records.length, { ...created, id: birth.id, seq: birth.seq });

  await expect(run(actions, journal, "git.worktree.get", { id: made.id }, "get")).resolves.toMatchObject({ id: made.id });
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, operation)).resolves.toEqual(made);
  expect(journal.records).toHaveLength(1);
  await expect(run(actions, journal, "git.worktree.remove", { id: made.id }, "remove")).resolves.toEqual({ id: made.id, removed: true });
});

test("removal can find the repository when a recorded linked source has gone", async () => {
  const { journal, actions, repo } = await setup();
  const source = join(repo, "linked");
  gitIn(repo, "worktree", "add", "-q", "-b", "source", source);
  const made = await run<Worktree>(actions, journal, "git.worktree.create", { repo: source, ...NOTE }, "old-source");
  const [birth] = journal.of("git.worktree.reserved");
  const [created] = journal.of("git.worktree.created");
  if (birth === undefined || created === undefined) throw new Error("the create must write both records");
  journal.records.splice(0, journal.records.length, { ...created, id: birth.id, seq: birth.seq, data: { ...made, repo: source } });
  gitIn(repo, "worktree", "remove", source);
  commitIn(made.path, "child.txt");

  await expect(run(actions, journal, "git.worktree.get", { id: made.id }, "get")).resolves.toMatchObject({ aheadOfBase: 1 });
  await expect(run(actions, journal, "git.worktree.remove", { id: made.id }, "remove")).rejects.toMatchObject({ code: "ahead" });

  gitIn(repo, "merge", "--ff-only", made.branch);
  gitIn(repo, "branch", "-f", "source", made.branch);
  await expect(run(actions, journal, "git.worktree.remove", { id: made.id }, "remove")).resolves.toEqual({ id: made.id, removed: true });
  expect(gitIn(repo, "branch", "--list", made.branch)).toBe("");
});

test("a create does not take a pre-existing branch at the intended base", async () => {
  const { journal, actions, repo } = await setup();
  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-collision", 2)).rejects.toBeInstanceOf(CutOff);
  const [reserved] = journal.of("git.worktree.reserved");
  const { path } = reserved?.data as Worktree;
  gitIn(repo, "worktree", "remove", "--force", path);

  await expect(run(actions, journal, "git.worktree.create", { repo, ...NOTE }, "create-collision")).rejects.toMatchObject({ code: "occupied" });
  expect(journal.of("git.worktree.created")).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test("a look cut off after the first worktree it recorded, made again, records the second in its place and answers both", async () => {
  const { journal, actions, repo } = await setup();
  const first = await run<Worktree>(actions, journal, "git.worktree.create", { repo, description: "first" }, "make-1");
  const second = await run<Worktree>(actions, journal, "git.worktree.create", { repo, description: "second" }, "make-2");
  const heads = [commitIn(first.path, "a.txt"), commitIn(second.path, "b.txt")];

  await expect(run(actions, journal, "git.head.observe", {}, "look-1", 2)).rejects.toBeInstanceOf(CutOff);
  expect(journal.of("git.head.moved")).toHaveLength(1);

  const seen = await run<{ moved: Array<{ worktree: string; head: string }> }>(actions, journal, "git.head.observe", {}, "look-1");

  expect(seen.moved).toEqual([
    { worktree: first.id, head: heads[0] },
    { worktree: second.id, head: heads[1] },
  ]);
  expect(journal.of("git.head.moved").map((row) => [row.id, (row.data as { worktree: string }).worktree])).toEqual([
    ["look-1/emit/1", first.id],
    ["look-1/emit/2", second.id],
  ]);

  // Made once more after it ended: the same answer, and nothing new.
  const again = await run<typeof seen>(actions, journal, "git.head.observe", {}, "look-1");
  expect(again).toEqual(seen);
  expect(journal.of("git.head.moved")).toHaveLength(2);
});
