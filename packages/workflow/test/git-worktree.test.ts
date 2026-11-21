// The git module's worktrees, on real git repositories in temporary directories: a worktree is made
// from the current branch with the ignored files `.worktreeinclude` names, the list flags what is odd,
// a remove refuses a dirty, unmerged or occupied worktree unless forced, `session.start({ worktree })`
// runs the session in one, `agent({ worktree })` removes a clean one and keeps a changed one, and the
// built-in cleanup removes the old clean ones only. The replay of a create cut off by a crash is
// tested in the git package.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { gitHeadObserve, gitWorktreeCreate, gitWorktreeGet, gitWorktreeList, gitWorktreeRemove } from "@niwa-labs/git/records";
import { NoOptions, harnessId, kindOptions, machineId, sessionId } from "@niwa-labs/harness";
import type { AskAnswer, AskOptions, Harness, SessionControl, SessionId, StartOptions, StartedSession } from "@niwa-labs/harness";
import { SessionTurnEnded, sessionStart } from "@niwa-labs/sessions/records";
import { createNiwa, CLEANUP_TIMER, WorktreeRefusal, git, sessions, timer, timerList, timers, eventually, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowInstallationList } from "../src/index.ts";

import { gitIn, makeRepo } from "./git-repo.ts";

const hosts: Host[] = [];
const homes: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const HARNESS = harnessId("claude-sonnet");

/** A control side that keeps what each session was started with and keeps it alive; a prompt with "change" writes a file where the session runs. */
class WorkingControl implements SessionControl {
  readonly starts: StartOptions[] = [];
  private readonly cwds = new Map<string, string | undefined>();

  async start(options: StartOptions): Promise<StartedSession> {
    this.starts.push(options);
    const id = sessionId(HARNESS, `session-${String(this.starts.length)}`);
    this.cwds.set(String(id), options.cwd);
    return { session: id };
  }

  async resume(): Promise<void> {
    throw new Error("this session cannot be resumed");
  }

  async send() {
    return { status: "started" as const, turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    const cwd = this.cwds.get(String(id));
    if (JSON.stringify(options.prompt).includes("change") && cwd !== undefined) writeFileSync(join(cwd, "made-by-agent.txt"), "work\n");
    return { session: id, value: { answer: "done" } as T, at: 0 as never };
  }

  /** The sessions live until the host stops: their stream of life ends only then. */
  private stop = (): void => {};
  private readonly stopped = new Promise<void>((resolve) => (this.stop = resolve));

  async *life(): AsyncIterable<never> {
    await this.stopped;
  }

  async dispose(): Promise<void> {
    this.stop();
  }

  async state(): Promise<"unknown"> {
    return "unknown";
  }
}

const instance: Harness = {
  id: HARNESS,
  kind: "claude-code" as never,
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    control: {
      start: true,
      resume: false,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: true,
      launch: { model: false, effort: [], modes: [] },
    },
  },
};

/** A host with the git module, and the sessions and workflow modules over the working control when asked. */
async function served(withSessions = false): Promise<{ host: Host; home: string; control: WorkingControl }> {
  const home = await tempHome();
  homes.push(home);
  const control = new WorkingControl();
  const host = createNiwa({ home: home.path });
  // The cleanup is its own test: these hosts have no timers or workflow module to run it.
  host.use(git({ cleanup: false }));
  if (withSessions) {
    host.use(sessions({ harnesses: [{ instance, control, options: kindOptions("claude", NoOptions) }] }));
    host.use(workflow({ harnesses: [HARNESS] }));
  }
  await host.serve();
  hosts.push(host);
  return { host, home: realpathSync(home.path), control };
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> =>
  (await host.records.read()).filter((row) => row.type === type);

/** The refusal a call ended with. */
async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeRefusal);
    return (error as WorktreeRefusal).code;
  }
  throw new Error("the call was not refused");
}

test("a worktree is made from the current branch, on a branch named like its id, with the ignored files .worktreeinclude names", async () => {
  const repo = await makeRepo();
  gitIn(repo, "switch", "-q", "-c", "feature");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  gitIn(repo, "add", "feature.txt");
  gitIn(repo, "commit", "-q", "-m", "feature");
  const { host, home } = await served();

  const made = await host.call(gitWorktreeCreate, { repo: join(repo, "src"), description: "try the feature" });

  expect(made.id).toMatch(/^wt-[0-9a-f]{6,8}$/);
  expect(made.branch).toBe(made.id);
  expect(made.path).toBe(join(home, "worktrees", made.id));
  expect(made.repo).toBe(repo);
  expect(made.base).toBe("feature");
  expect(made.baseSha).toBe(gitIn(repo, "rev-parse", "feature"));
  expect(gitIn(made.path, "symbolic-ref", "--short", "HEAD")).toBe(made.id);
  expect(existsSync(join(made.path, "feature.txt"))).toBe(true);
  // Ignored and named: copied. Ignored and not named, or named and not ignored: not.
  expect(readFileSync(join(made.path, ".env"), "utf8")).toBe("TOKEN=1\n");
  expect(readFileSync(join(made.path, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  expect(existsSync(join(made.path, "secret.local"))).toBe(false);
  expect(existsSync(join(made.path, "plain.txt"))).toBe(false);

  const now = await host.call(gitWorktreeGet, { id: made.id.slice(0, 5) });
  expect(now).toMatchObject({ id: made.id, dirty: false, aheadOfBase: 0, sessions: [] });
  expect((await ofType(host, "git.worktree.created")).map((row) => row.data)).toEqual([made]);
});

test("a detached HEAD is the base by its commit; an explicit base is taken as given", async () => {
  const repo = await makeRepo();
  const sha = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "switch", "-q", "--detach", "HEAD");
  const { host } = await served();

  const detached = await host.call(gitWorktreeCreate, { repo, description: "from a detached head" });
  expect(detached.base).toBe(sha);
  const named = await host.call(gitWorktreeCreate, { repo, base: "main", description: "from main" });
  expect(named.base).toBe("main");
  expect(named.id).not.toBe(detached.id);
});

test("a remove refuses a dirty worktree and one ahead of its base, removes it with force, and a second remove is a no-op", async () => {
  const repo = await makeRepo();
  const { host } = await served();
  const made = await host.call(gitWorktreeCreate, { repo, description: "work to keep" });

  writeFileSync(join(made.path, "new.txt"), "draft\n");
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("dirty");
  gitIn(made.path, "add", "new.txt");
  gitIn(made.path, "commit", "-q", "-m", "draft");
  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ dirty: false, aheadOfBase: 1 });
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("ahead");
  expect(existsSync(made.path)).toBe(true);

  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
  expect(existsSync(made.path)).toBe(false);
  expect(gitIn(repo, "branch", "--list", made.id)).toBe("");
  expect(await host.call(gitWorktreeRemove, { id: made.id })).toEqual({ id: made.id, removed: false });
  expect((await ofType(host, "git.worktree.removed")).map((row) => row.data)).toEqual([{ id: made.id, forced: true }]);
});

test("commits merged into the base do not hold a worktree: a clean one whose base took its commits is removed", async () => {
  const repo = await makeRepo();
  const { host } = await served();
  const made = await host.call(gitWorktreeCreate, { repo, description: "merged work" });
  writeFileSync(join(made.path, "done.txt"), "done\n");
  gitIn(made.path, "add", "done.txt");
  gitIn(made.path, "commit", "-q", "-m", "done");
  gitIn(repo, "merge", "-q", "--ff-only", made.branch);

  expect(await host.call(gitWorktreeRemove, { id: made.id })).toEqual({ id: made.id, removed: true });
  expect((await ofType(host, "git.worktree.removed")).map((row) => row.data)).toEqual([{ id: made.id, forced: false }]);
});

test("the list flags a worktree whose directory is gone and a directory of the store no record names", async () => {
  const repo = await makeRepo();
  const { host, home } = await served();
  const kept = await host.call(gitWorktreeCreate, { repo, description: "stays as it is" });
  const lost = await host.call(gitWorktreeCreate, { repo, base: "main", description: "its directory goes" });
  rmSync(lost.path, { recursive: true, force: true });
  mkdirSync(join(home, "worktrees", "wt-0abcde"), { recursive: true });

  const { items } = await host.call(gitWorktreeList, {});
  const byId = new Map(items.map((item) => [item.id, item]));
  expect(byId.get(kept.id)).toMatchObject({ state: "ok", dirty: false, aheadOfBase: 0, sessions: [] });
  expect(byId.get(kept.id)?.ageDays).toBeGreaterThanOrEqual(0);
  expect(byId.get(lost.id)).toMatchObject({ state: "missing" });
  expect(byId.get("wt-0abcde" as never)).toMatchObject({ state: "orphan", path: join(home, "worktrees", "wt-0abcde") });

  // An orphan goes with force only; a missing one is removed with its branch.
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: "wt-0abcde" }))).toBe("orphan");
  expect(await host.call(gitWorktreeRemove, { id: "wt-0abcde", force: true })).toEqual({ id: "wt-0abcde", removed: true });
  expect(await host.call(gitWorktreeRemove, { id: lost.id })).toEqual({ id: lost.id, removed: true });
  expect(gitIn(repo, "branch", "--list", lost.id)).toBe("");
  expect((await host.call(gitWorktreeList, {})).items.map((item) => item.id)).toEqual([kept.id]);
});

test("session.start({ worktree }) runs the session in a new worktree of its cwd, which a remove then refuses for the live session", async () => {
  const repo = await makeRepo();
  const { host, control } = await served(true);

  const started = await host.call(sessionStart, { harness: HARNESS, prompt: "", cwd: repo, worktree: true });

  const made = started.worktree;
  expect(made).toBeDefined();
  if (made === undefined) return;
  expect(control.starts[0]?.cwd).toBe(made.path);
  const [record] = await ofType(host, "session.started");
  expect((record?.data as { cwd?: string }).cwd).toBe(made.path);
  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ sessions: [started.session], description: "a session of claude-sonnet" });
  expect(await refusalOf(host.call(gitWorktreeRemove, { id: made.id }))).toBe("live-session");
  expect(await host.call(gitWorktreeRemove, { id: made.id, force: true })).toEqual({ id: made.id, removed: true });
});

/** Run a script to its end on the host; the outcome it finished with. */
async function runScript(host: Host, home: string, lines: readonly string[]): Promise<unknown> {
  const file = join(home, `script-${String(Date.now())}.js`);
  writeFileSync(file, lines.join("\n"));
  await host.call("workflow.start" as ActionName, { file } as never);
  let outcome: unknown;
  await eventually(
    async () => {
      outcome = (await ofType(host, "workflow.run.finished")).at(-1)?.data;
      return outcome !== undefined;
    },
    20_000,
    "the run should finish",
  );
  return (outcome as { outcome: unknown }).outcome;
}

test("agent({ worktree: true }) removes the worktree when the agent left it clean", async () => {
  const repo = await makeRepo();
  const { host, home } = await served(true);

  const outcome = await runScript(host, home, [
    'export default workflow({ uses: ["session.start.claude-sonnet"], output: z.json() }, async () => {',
    `  return await agent("look around", { harness: "claude-sonnet", cwd: ${JSON.stringify(repo)}, worktree: true });`,
    "});",
  ]);

  expect(outcome).toEqual({ status: "done", result: { answer: "done" } });
  const [created] = await ofType(host, "git.worktree.created");
  const made = created?.data as { id: string; path: string; description: string };
  expect(made.description).toBe("look around");
  expect(existsSync(made.path)).toBe(false);
  // Its own session is still alive in it, and is the only one: the agent removes it past that.
  expect((await ofType(host, "git.worktree.removed")).map((row) => row.data)).toEqual([{ id: made.id, forced: true }]);
}, 30_000);

test("agent({ worktree }) keeps the worktree the agent changed, and the answer says where it is", async () => {
  const repo = await makeRepo();
  const { host, home } = await served(true);

  const outcome = await runScript(host, home, [
    'export default workflow({ uses: ["session.start.claude-sonnet"], output: z.json() }, async () => {',
    "  const answer = await agent(\"change a file\", {",
    `    harness: "claude-sonnet", worktree: { repo: ${JSON.stringify(repo)}, description: "the change" },`,
    "    schema: z.object({ answer: z.string() }),",
    "  });",
    "  return answer;",
    "});",
  ]);

  const [created] = await ofType(host, "git.worktree.created");
  const made = created?.data as { id: string; path: string; branch: string };
  expect(outcome).toEqual({
    status: "done",
    result: { answer: "done", worktree: { id: made.id, path: made.path, branch: made.branch, changed: true } },
  });
  expect(readFileSync(join(made.path, "made-by-agent.txt"), "utf8")).toBe("work\n");
  expect(await ofType(host, "git.worktree.removed")).toEqual([]);
}, 30_000);

test("the built-in cleanup removes the old clean worktrees and keeps the dirty and the unmerged ones", async () => {
  const repo = await makeRepo();
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  // The host writes only git(): the module offers its timer and its workflow. A timer of the same id the host lists is
  // the one scheduled, so the test fires it often; no days, so the worktrees just made are old enough.
  host.use(timers([timer.every(300, { id: CLEANUP_TIMER })]), git({ cleanup: { days: 0 } }), workflow());
  await host.serve();
  hosts.push(host);

  const clean = await host.call(gitWorktreeCreate, { repo, description: "nothing in it" });
  const dirty = await host.call(gitWorktreeCreate, { repo, base: "main", description: "a draft in it" });
  writeFileSync(join(dirty.path, "draft.txt"), "draft\n");
  const ahead = await host.call(gitWorktreeCreate, { repo, base: gitIn(repo, "rev-parse", "HEAD"), description: "a commit in it" });
  writeFileSync(join(ahead.path, "work.txt"), "work\n");
  gitIn(ahead.path, "add", "work.txt");
  gitIn(ahead.path, "commit", "-q", "-m", "work");

  await eventually(async () => (await ofType(host, "git.worktree.removed")).length > 0, 20_000, "cleanup should record its removal");
  await eventually(async () => (await ofType(host, "workflow.run.finished")).length >= 2, 20_000, "two cleanups should run");
  expect(existsSync(clean.path)).toBe(false);
  expect(existsSync(dirty.path)).toBe(true);
  expect(existsSync(ahead.path)).toBe(true);
  expect((await ofType(host, "git.worktree.removed")).map((row) => row.data)).toEqual([{ id: clean.id, forced: false }]);
  const [installed] = (await host.call(workflowInstallationList, {})).items;
  expect(installed?.builtin).toEqual({ plugin: "git", name: "worktree-cleanup" });
}, 40_000);

test("git({ cleanup: false }) offers no cleanup: nothing is registered or installed", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(timers([]), git({ cleanup: false }), workflow());
  await host.serve();
  hosts.push(host);
  await Bun.sleep(300);
  expect((await host.call(workflowInstallationList, {})).items).toEqual([]);
  expect(await ofType(host, "workflow.registered")).toEqual([]);
  expect((await host.call(timerList, {})).timers).toEqual([]);
}, 20_000);

test("the list shows each worktree's head and the remote its base pushes to, when fetch and push name the same project", async () => {
  const repo = await makeRepo();
  gitIn(repo, "remote", "add", "origin", "git@GitLab.Example.com:acme/billing.git");
  gitIn(repo, "config", "branch.main.remote", "origin");
  gitIn(repo, "config", "branch.main.merge", "refs/heads/main");
  const other = await makeRepo();
  gitIn(other, "remote", "add", "upstream", "https://token@gitlab.example.com:8443/acme/tools/cli.git/");
  gitIn(other, "config", "branch.main.remote", "upstream");
  const split = await makeRepo();
  gitIn(split, "remote", "add", "origin", "https://gitlab.example.com/acme/billing.git");
  gitIn(split, "remote", "set-url", "--push", "origin", "https://gitlab.example.com/acme/fork.git");
  const local = await makeRepo();
  gitIn(local, "remote", "add", "origin", "/srv/git/billing.git");
  const bare = await makeRepo();
  const { host } = await served();

  const made = await host.call(gitWorktreeCreate, { repo, description: "with a remote" });
  const tools = await host.call(gitWorktreeCreate, { repo: other, description: "tracks upstream" });
  const forked = await host.call(gitWorktreeCreate, { repo: split, description: "pushes elsewhere" });
  const onDisk = await host.call(gitWorktreeCreate, { repo: local, description: "a local remote" });
  const none = await host.call(gitWorktreeCreate, { repo: bare, description: "no remote" });
  writeFileSync(join(made.path, "next.txt"), "next\n");
  gitIn(made.path, "add", "next.txt");
  gitIn(made.path, "commit", "-q", "-m", "next");

  const byId = new Map((await host.call(gitWorktreeList, {})).items.map((item) => [item.id, item]));
  expect(byId.get(made.id)).toMatchObject({ head: gitIn(made.path, "rev-parse", "HEAD"), remote: { name: "origin", host: "gitlab.example.com", path: "acme/billing" } });
  expect(byId.get(tools.id)?.remote).toEqual({ name: "upstream", host: "gitlab.example.com", path: "acme/tools/cli" });
  expect(byId.get(none.id)?.head).toBe(none.baseSha);
  for (const unverified of [forked, onDisk, none]) expect(byId.get(unverified.id)?.remote).toBeUndefined();
  expect(await host.call(gitWorktreeGet, { id: made.id })).toMatchObject({ remote: { host: "gitlab.example.com", path: "acme/billing" } });
});

test("a head that moved in a worktree is recorded once, for the session whose turn ended there or the caller that looked", async () => {
  const repo = await makeRepo();
  const { host } = await served(true);
  const started = await host.call(sessionStart, { harness: HARNESS, prompt: "", cwd: repo, worktree: true });
  const made = started.worktree;
  if (made === undefined) throw new Error("no worktree");
  const commit = (file: string): string => {
    writeFileSync(join(made.path, file), `${file}\n`);
    gitIn(made.path, "add", file);
    gitIn(made.path, "commit", "-q", "-m", file);
    return gitIn(made.path, "rev-parse", "HEAD");
  };

  // A turn that moved nothing writes nothing.
  await host.emit(SessionTurnEnded, { session: started.ref as never, turn: 1 });
  const first = commit("one.txt");
  await host.emit(SessionTurnEnded, { session: started.ref as never, turn: 2 });
  await eventually(async () => (await ofType(host, "git.head.moved")).length > 0);
  expect((await ofType(host, "git.head.moved")).map((row) => row.data)).toEqual([
    { worktree: made.id, repo, path: made.path, branch: made.branch, head: first, previous: gitIn(repo, "rev-parse", "main"), session: started.ref },
  ]);
  // Looked at again, a head that stayed is not written again.
  expect(await host.call(gitHeadObserve, {})).toEqual({ moved: [] });

  // A caller that looks itself is who the record is of: no session is named.
  const second = commit("two.txt");
  expect(await host.call(gitHeadObserve, { worktree: made.id })).toEqual({ moved: [{ worktree: made.id, head: second }] });
  const rows = await ofType(host, "git.head.moved");
  expect(rows.map((row) => row.data)).toEqual([
    expect.objectContaining({ head: first, session: started.ref }),
    { worktree: made.id, repo, path: made.path, branch: made.branch, head: second, previous: first },
  ]);
});
