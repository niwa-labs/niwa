// A worktree create cut off by a crash is made again under the same step identity, and finds what it
// made: the host is killed while `git worktree add` waits in a hook of the repository (the directory
// and the branch exist, the record does not), and the host that starts again takes that checkout as
// the worktree. One record, one directory, one branch.

import { expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventually, gate, spawnHost, tempHome, connectAsOwner, lastState, watch } from "@niwa-labs/testing";

import { Start } from "./fixtures/git-worktree-host.ts";
import { gitIn, makeRepo } from "./git-repo.ts";

const HOST_SCRIPT = new URL("./fixtures/git-worktree-host.ts", import.meta.url).pathname;

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
