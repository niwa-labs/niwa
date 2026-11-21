/**
 * The git commands the module runs, and the copy of `.worktreeinclude` files.
 *
 * Every command is `git -C <dir> ...` with the output read whole; a command that fails is an
 * error carrying what git said, except where the caller asks for the exit code.
 */

import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** How many commits `branch` has that `base` has not. */
export async function aheadOf(dir: string, base: string, branch: string): Promise<number> {
  return Number((await gitOut(dir, ["rev-list", "--count", `${base}..${branch}`])).trim());
}

/** The paths, relative to the top, that a NUL-separated git listing gives. */
function paths(listing: string): string[] {
  return listing.split("\0").filter((path) => path !== "");
}

/**
 * Copy into a new worktree the files of the repository that are ignored by git and listed in
 * `<repo>/.worktreeinclude` (gitignore syntax): `.env`, local settings. A tracked file, or an
 * untracked one git does not ignore, is never copied, whatever the include says. The copy is a
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
  const copied = paths(ignored.stdout);
  for (const path of copied) {
    const target = join(into, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, path), target, constants.COPYFILE_FICLONE);
  }
  return copied.length;
}
