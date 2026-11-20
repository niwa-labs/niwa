/** Shared by the process-class sandboxes: spawn the wrapper with exactly the listed environment. */

import type { LaunchedBox } from "./sandbox.ts";

export function spawnBox(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, cleanup: () => Promise<void>): LaunchedBox {
  const child = Bun.spawn([...argv], { cwd, env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    kill: () => child.kill(),
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
