/**
 * The git commands the module runs, and the copy of `.worktreeinclude` files.
 *
 * Every command is `git -C <dir> ...` with the output read whole; a command that fails is an
 * error carrying what git said, except where the caller asks for the exit code.
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** What a git command answered. */
interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git in a directory; `input` goes to its stdin. */
export async function gitRun(dir: string, args: readonly string[], input?: string): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", dir, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    // A prompt for credentials or an editor would hang the host.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run git and give its output; a failure is an error with what git said. */
export async function gitOut(dir: string, args: readonly string[], input?: string): Promise<string> {
  const result = await gitRun(dir, args, input);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${dir}) failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/** The top of the repository a directory is in, or undefined when it is in none. */
export async function topOf(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const result = await gitRun(dir, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * The directory of the repository a checkout belongs to: the top of the repository, or, for a linked worktree,
 * the top of the repository that owns it, so the answer does not depend on the checkout it was asked from. A
 * repository whose git directory is not named `.git` (a submodule) is its own top.
 */
export async function repoOf(dir: string): Promise<string | undefined> {
  const top = await topOf(dir);
  if (top === undefined) return undefined;
  const common = await gitRun(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = common.code === 0 ? common.stdout.trim() : "";
  if (basename(gitDir) === ".git" && existsSync(dirname(gitDir))) return dirname(gitDir);
  return top;
}

/** The git directory a checkout shares with the others of its repository, with its links resolved. */
export async function commonDirOf(dir: string): Promise<string | undefined> {
  const result = await gitRun(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.code !== 0) return undefined;
  try {
    return realpathSync(result.stdout.trim());
  } catch {
    return undefined;
  }
}

/** The current branch of a checkout, or its commit when HEAD is detached. */
export async function currentBase(dir: string): Promise<string> {
  const branch = await gitRun(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.code === 0 && branch.stdout.trim() !== "") return branch.stdout.trim();
  return (await gitOut(dir, ["rev-parse", "HEAD"])).trim();
}

/** The commit a name points at, or undefined when it names none. */
export async function commitOf(dir: string, name: string): Promise<string | undefined> {
  const result = await gitRun(dir, ["rev-parse", "--verify", "-q", `${name}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Whether a checkout has changes: tracked files changed, or untracked files that are not ignored. */
export async function isDirty(dir: string): Promise<boolean> {
  return (await gitOut(dir, ["status", "--porcelain", "--untracked-files=normal"])).trim() !== "";
}

/** How many commits are reachable from the tips that `base` has not: work that would be lost with them. */
export async function aheadOf(dir: string, base: string, tips: readonly string[]): Promise<number> {
  return Number((await gitOut(dir, ["rev-list", "--count", ...tips, `^${base}`])).trim());
}

/** The commit the head of a checkout is on, or undefined when it has none. */
export async function headOf(dir: string): Promise<string | undefined> {
  const result = await gitRun(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The branch the head of a checkout is on, or undefined when it is detached. */
export async function branchOf(dir: string): Promise<string | undefined> {
  const result = await gitRun(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== "" ? branch : undefined;
}

/** A host name as a forge names its server: lower case, no port, no scheme. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
/** One group or the name of a project in its path. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The server and the project path a remote URL names: `https://host/group/name.git`, `ssh://user@host:22/group/name`,
 * `user@host:group/name.git`. A user, a token, a port and the `.git` ending are not part of it. A path on this machine
 * (`/srv/git/x.git`, `file://`), or a URL that names no group and name on a host, names none.
 */
export function remoteProject(url: string): { host: string; path: string } | undefined {
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme !== null) {
    if (!["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme[1]!.toLowerCase())) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      // A path that is not valid percent-encoding names no project.
      return undefined;
    }
  } else {
    // The scp-like form: [user@]host:path. A colon after a slash is a local path.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (scp === null) return undefined;
    host = scp[1]!;
    path = scp[2]!;
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const segments = path.split("/");
  if (!HOST.test(host) || segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment))) return undefined;
  return { host, path };
}

/** What a repository's configuration says for a key, or "" when it says nothing. */
async function configured(repo: string, key: string): Promise<string> {
  const result = await gitRun(repo, ["config", "--get", key]);
  return result.code === 0 ? result.stdout.trim() : "";
}

/**
 * The remote a push of `base` goes to, by the rules git pushes by: the push remote of the branch, else
 * `remote.pushDefault`, else the remote the branch tracks, else the only remote or `origin`. A branch that
 * tracks a local branch (remote ".") goes to no remote.
 */
async function pushRemoteOf(repo: string, base: string): Promise<string | undefined> {
  const named = (await configured(repo, `branch.${base}.pushRemote`)) || (await configured(repo, "remote.pushDefault"));
  const name = named || (await configured(repo, `branch.${base}.remote`));
  if (name !== "") return name === "." ? undefined : name;
  const remotes = (await gitRun(repo, ["remote"])).stdout.trim().split("\n");
  return remotes.length === 1 && remotes[0] !== "" ? remotes[0] : "origin";
}

/**
 * The remote the work on `base` goes to, verified from the repository's configuration: the remote a push of `base`
 * goes to. It is undefined when that remote is not configured, its URL names no project on a server, or any of its
 * push URLs names another project than its fetch URL.
 */
export async function verifiedRemote(repo: string, base: string): Promise<{ name: string; host: string; path: string } | undefined> {
  const name = await pushRemoteOf(repo, base);
  if (name === undefined) return undefined;
  const fetch = await gitRun(repo, ["remote", "get-url", name]);
  if (fetch.code !== 0) return undefined;
  const project = remoteProject(fetch.stdout.trim());
  if (project === undefined) return undefined;
  const push = await gitRun(repo, ["remote", "get-url", "--push", "--all", name]);
  const urls = push.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (push.code !== 0 || urls.length === 0) return undefined;
  for (const url of urls) {
    const pushed = remoteProject(url);
    if (pushed === undefined || pushed.host !== project.host || pushed.path !== project.path) return undefined;
  }
  return { name, ...project };
}

/** The paths, relative to the top, that a NUL-separated git listing gives. */
function paths(listing: string): string[] {
  return listing.split("\0").filter((path) => path !== "");
}

/** Whether a path is there, a link included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy into a new worktree the files of the repository that are ignored by git and listed in
 * `<repo>/.worktreeinclude` (gitignore syntax): `.env`, local settings. A tracked file, or an
 * untracked one git does not ignore, is never copied, whatever the include says; neither is a file
 * the new checkout tracks (the base may track what the source ignores), nor one that is there
 * already (a create made again), nor one that would land outside the checkout. The copy is a
 * clone where the file system makes one (APFS), a plain copy elsewhere; a link is followed, never
 * made. Answers how many files were copied.
 */
export async function copyIncluded(repo: string, into: string): Promise<number> {
  const include = join(repo, ".worktreeinclude");
  if (!existsSync(include)) return 0;
  // The untracked files the include names, then those of them git ignores.
  const named = paths(await gitOut(repo, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include}`]));
  if (named.length === 0) return 0;
  const ignored = await gitRun(repo, ["check-ignore", "-z", "--stdin"], `${named.join("\0")}\0`);
  // check-ignore answers 1 when none is ignored.
  if (ignored.code !== 0 && ignored.code !== 1) throw new Error(`git check-ignore failed: ${ignored.stderr.trim()}`);
  const candidates = paths(ignored.stdout);
  if (candidates.length === 0) return 0;
  const tracked = new Set(paths(await gitOut(into, ["ls-files", "-z"])));
  const inside = realpathSync(into);
  let copied = 0;
  for (const path of candidates) {
    const parts = path.split("/");
    // The path, or a directory on the way to it, is a tracked file of the new checkout.
    if (parts.some((_, at) => tracked.has(parts.slice(0, at + 1).join("/")))) continue;
    const target = join(into, path);
    if (present(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const landing = realpathSync(dirname(target));
    if (landing !== inside && !landing.startsWith(`${inside}${sep}`)) continue;
    copyFileSync(join(repo, path), target, constants.COPYFILE_FICLONE);
    copied += 1;
  }
  return copied;
}
