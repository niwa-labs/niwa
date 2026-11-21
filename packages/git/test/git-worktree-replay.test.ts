// A worktree create cut off by a crash is made again under the same step identity, and finds what it
// made: the host is killed while `git worktree add` waits in a hook of the repository (the directory
// and the branch exist, the record does not), and the host that starts again takes that checkout as
// the worktree. One record, one directory, one branch.

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eventually, gate, spawnHost, tempHome, connectAsOwner, lastState, watch } from "@niwa-labs/testing";

import { gitWorktreeCreate } from "../src/index.ts";
import { Start, Remove } from "./fixtures/git-worktree-host.ts";
import { gitIn, makeRepo } from "./git-repo.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/git-worktree-host.ts", import.meta.url));

test("a create cut off inside git is made again under the same identity and takes the checkout it made", async () => {
  const home = await tempHome();
  const repo = await makeRepo();
  const inside = join(home.path, "inside-hook");
  const opened = join(home.path, "gates", "hook");
  // The checkout of the new worktree runs this hook: it says it is there, then waits for the gate.
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch "${inside}"\nwhile [ ! -f "${opened}" ]; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);

  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    first = spawnHost(HOST_SCRIPT, home.path);
    await first.ready();
    observer = await watch(home.path);
    const client = await connectAsOwner(home.path);
    await client.emit(Start, { repo });
    await eventually(() => existsSync(inside), 15_000, "the create should reach the hook");

    await first.kill();
    await client.close().catch(() => {});
    gate(home.path, "hook").open();

    second = spawnHost(HOST_SCRIPT, home.path);
    await second.ready();
    const seen = observer.seen;
    await eventually(() => lastState(seen)?.state === "done", 20_000, "the handler should end as done");

    const created = seen.filter((row) => row.type === "git.worktree.created").map((row) => row.data as { id: string; path: string });
    expect(created).toHaveLength(1);
    const [made] = created;
    if (made === undefined) return;
    const store = join(realpathSync(home.path), "worktrees");
    expect(made.path).toBe(join(store, made.id));
    expect(readdirSync(store)).toEqual([made.id]);
    expect(gitIn(made.path, "symbolic-ref", "--short", "HEAD")).toBe(made.id);
    expect(gitIn(repo, "branch", "--list", "wt-*").split("\n").map((line) => line.replace(/^[*+ ]+/, "").trim())).toEqual([made.id]);
  } finally {
    await observer?.stop();
    await first?.kill().catch(() => {});
    await second?.stop().catch(() => {});
    await home.cleanup();
  }
}, 60_000);


test("a matched removal interrupted after Git is settled once on restart", async () => {
  const home = await tempHome();
  const repo = await makeRepo();
  gitIn(repo, "rm", "-q", ".worktreeinclude");
  gitIn(repo, "commit", "-q", "-m", "remove checkout fixture copies");
  gitIn(repo, "remote", "add", "origin", "https://example.invalid/cleanup/repo.git");
  const bin = join(home.path, "bin");
  const marker = join(home.path, "git-removed");
  const barrier = join(home.path, "gates", "removed");
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is required");
  mkdirSync(bin);
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `"${realGit}" "$@"`,
    "result=$?",
    'if [ "$result" = 0 ] && [ "$3" = worktree ] && [ "$4" = remove ]; then',
    `  touch "${marker}"`,
    `  while [ ! -f "${barrier}" ]; do sleep 0.05; done`,
    "fi",
    'exit "$result"',
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  let owner: Awaited<ReturnType<typeof connectAsOwner>> | undefined;
  try {
    first = spawnHost(HOST_SCRIPT, home.path, [bin]);
    await first.ready();
    observer = await watch(home.path);
    owner = await connectAsOwner(home.path);
    const tree = await owner.call(gitWorktreeCreate, { repo, description: "removed before the action could finish" });
    const onlyIf = { repo: tree.repo, path: tree.path, branch: tree.branch, head: tree.baseSha, project: { host: "example.invalid", path: "cleanup/repo" } };
    await owner.emit(Remove, { id: tree.id, onlyIf });
    await eventually(() => existsSync(marker), 15_000, "Git should have removed the checkout");
    expect(existsSync(tree.path)).toBe(false);
    expect(observer.seen.some((row) => row.type === "git.worktree.removal.claimed")).toBe(true);
    expect(observer.seen.some((row) => row.type === "git.worktree.removed")).toBe(false);

    await first.kill();
    await owner.close();
    gate(home.path, "removed").open();
    second = spawnHost(HOST_SCRIPT, home.path);
    await second.ready();
    const seen = observer.seen;
    await eventually(() => lastState(seen)?.state === "done", 15_000, "removal should finish after restart");
    expect(seen.filter((row) => row.type === "git.worktree.removal.claimed")).toHaveLength(1);
    expect(seen.filter((row) => row.type === "git.worktree.removed").map((row) => row.data)).toEqual([{ id: tree.id, forced: false, branchKept: true }]);
    expect(gitIn(repo, "rev-parse", tree.branch)).toBe(tree.baseSha);
  } finally {
    gate(home.path, "removed").open();
    await owner?.close().catch(() => {});
    await observer?.stop();
    await first?.kill().catch(() => {});
    await second?.stop().catch(() => {});
    await home.cleanup();
  }
}, 45_000);
