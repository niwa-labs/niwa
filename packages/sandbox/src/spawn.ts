/** Shared by the process-class sandboxes: spawn the wrapper with exactly the listed environment. */

import { existsSync } from "node:fs";

import { SandboxUnavailable } from "./sandbox.ts";
import type { LaunchOptions, LaunchedBox, SandboxName } from "./sandbox.ts";

/** Is the program not to be found, where the spawn looks for it? */
function missing(program: string | undefined, env: Readonly<Record<string, string>>): boolean {
  if (program === undefined) return true;
  return program.includes("/") ? !existsSync(program) : Bun.which(program, { PATH: env["PATH"] ?? "" }) === null;
}

/**
 * Starts the wrapper. A wrapper that is not there is `SandboxUnavailable` and no process exists, as
 * it is when the probe finds it missing; any other failure to start is the caller's to see as it is.
 */
export function spawnBox(
  sandbox: SandboxName,
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  cleanup: () => Promise<void>,
  options: LaunchOptions = {},
): LaunchedBox {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn([...argv], { cwd, env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: options.detached ?? false });
  } catch (error) {
    // A working directory that is not there fails the same way: that is the spec's fault, not the wrapper's.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missing(argv[0], env)) {
      throw new SandboxUnavailable(sandbox, `${argv[0] ?? "the wrapper"} cannot be started: ${(error as Error).message}`);
    }
    throw error;
  }
  const exited = child.exited.then(async (code) => {
    await cleanup();
    return code;
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: (signal) => child.kill(signal),
  };
}

/** Runs the wrapper once to see whether it works on this machine. */
export async function probe(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<boolean> {
  try {
    const child = Bun.spawn([...argv], { cwd, env: { ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
