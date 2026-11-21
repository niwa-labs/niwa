// A real git repository in a temporary directory, for the tests of the git module. Git runs with no
// global or system configuration, so the owner's hooks, signing and default branch do not reach it;
// the host processes the tests spawn inherit the same environment.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "niwa test";
process.env.GIT_AUTHOR_EMAIL = "test@niwa.invalid";
process.env.GIT_COMMITTER_NAME = "niwa test";
process.env.GIT_COMMITTER_EMAIL = "test@niwa.invalid";

/** Run git in a directory; its output, trimmed. */
export function gitIn(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/**
 * A repository on `main` with one commit, a `.gitignore` and a `.worktreeinclude`, and four untracked
 * files: `.env` and `node_modules/pkg/index.js` (ignored and named by the include), `secret.local`
 * (ignored, not named) and `plain.txt` (named, not ignored).
 */
export async function makeRepo(): Promise<string> {
  const repo = realpathSync(await tempDir("git-repo"));
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env\nsecret.local\nnode_modules/\n");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\nnode_modules/\nplain.txt\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "main.ts"), "export {};\n");
  writeFileSync(join(repo, "README.md"), "a repository\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "start");
  writeFileSync(join(repo, ".env"), "TOKEN=1\n");
  writeFileSync(join(repo, "secret.local"), "secret\n");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "plain.txt"), "plain\n");
  return repo;
}
