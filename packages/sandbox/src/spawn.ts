/** Shared by the process-class sandboxes: spawn the wrapper with exactly the listed environment. */

import { existsSync } from "node:fs";

import { SandboxUnavailable, SandboxUnsupported } from "./sandbox.ts";
import type { LaunchOptions, LaunchedBox, SandboxName } from "./sandbox.ts";

/** Where a wrapper finds the system's tools: the host's choice, never the spec's. */
export const SYSTEM_PATH = "/usr/bin:/bin";

/**
 * The command a wrapper runs, with the spec's environment put on it from the inside.
 *
 * The wrapper is the host's own process: it locates system tools and loads libraries before any
 * restriction exists, so the spec's environment must not reach it. The spec's variables are set by
 * `env` once the restrictions hold, on the command alone; a launcher variable the spec leaves out
 * is removed there, so the command has the variables the spec lists and what the wrapper adds
 * itself.
 */
export function insideBox(
  sandbox: SandboxName,
  launcher: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): string[] {
  const program = argv[0];
  if (program === undefined) throw new SandboxUnsupported(sandbox, "there is no program to run");
  if (program.includes("=") || program.startsWith("-")) {
    throw new SandboxUnsupported(sandbox, `the program ${JSON.stringify(program)} would be read by env as a variable or an option`);
  }
  const unset = Object.keys(launcher).filter((name) => !(name in env)).flatMap((name) => ["-u", name]);
  return ["/usr/bin/env", ...unset, ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...argv];
}

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
