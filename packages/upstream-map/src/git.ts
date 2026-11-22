/** A git checkout, or a folder inside one. Paths are relative to that folder. */
export class Git {
  private readonly resolved = new Map<string, string | undefined>();
  private readonly shown = new Map<string, string | undefined>();

  constructor(readonly dir: string) {}

  private spawn(args: readonly string[]) {
    return Bun.spawnSync(["git", "-C", this.dir, ...args], { stdout: "pipe", stderr: "pipe" });
  }

  /** Run git here: its exit and its output. */
  run(args: readonly string[]): { exit: number; out: string; err: string } {
    const ran = this.spawn(args);
    return { exit: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() };
  }

  /** Run git here; a command that fails throws. */
  out(args: readonly string[]): string {
    const ran = this.run(args);
    if (ran.exit !== 0) throw new Error(`git ${args.join(" ")} failed in ${this.dir}: ${ran.err.trim()}`);
    return ran.out;
  }

  /** The commit a revision names, in full; undefined when this checkout has no such commit. */
  resolve(rev: string): string | undefined {
    if (!this.resolved.has(rev)) {
      const ran = this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
      this.resolved.set(rev, ran.exit === 0 ? ran.out.trim() : undefined);
    }
    return this.resolved.get(rev);
  }

  /** A file as a commit holds it; undefined when the commit has no such file. A commit's files do not change, so they are kept. */
  show(rev: string, path: string): string | undefined {
    const key = `${rev}\0${path}`;
    if (!this.shown.has(key)) {
      this.shown.set(key, this.blob(rev, path)?.toString());
    }
    return this.shown.get(key);
  }

  /** The original bytes of a file in a commit. */
  blob(rev: string, path: string): Buffer | undefined {
    const ran = this.spawn(["show", `${rev}:./${path}`]);
    return ran.exitCode === 0 ? ran.stdout : undefined;
  }

  /** The files under a path as a commit holds them. */
  list(rev: string, path: string): string[] {
    const value = this.out(["ls-tree", "-r", "-z", "--name-only", rev, "--", path]);
    return value.split("\0").filter((file) => file !== "");
  }

  /**
   * What became of the files of one commit by another (or by the working tree, with no `to`): where a renamed file
   * went, and null for a deleted one. A file not named here kept its path.
   */
  moved(from: string, to?: string): Map<string, string | null> {
    const raw = this.out(["diff", "--name-status", "-M", "-z", "--relative", from, ...(to === undefined ? [] : [to])]);
    const parts = raw.split("\0");
    const moved = new Map<string, string | null>();
    for (let i = 0; i < parts.length; ) {
      const status = parts[i] ?? "";
      if (status === "") break;
      if (status.startsWith("R") || status.startsWith("C")) {
        if (status.startsWith("R")) moved.set(parts[i + 1] as string, parts[i + 2] as string);
        i += 3;
      } else {
        if (status === "D") moved.set(parts[i + 1] as string, null);
        i += 2;
      }
    }
    return moved;
  }
}
