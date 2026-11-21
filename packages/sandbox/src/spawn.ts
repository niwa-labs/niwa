/** Shared by the process-class sandboxes: start the wrapper, and the command inside it with exactly the listed environment. */

import { existsSync, statSync } from "node:fs";
import { constants } from "node:os";

import { BoxRefused, SandboxUnavailable } from "./sandbox.ts";
import type { LaunchOptions, LaunchedBox, SandboxName } from "./sandbox.ts";

/** Where a wrapper finds the system's tools: the host's choice, never the spec's. */
export const SYSTEM_PATH = "/usr/bin:/bin";

/** What a spec's variable is called in the wrapper's environment, on its way in. */
const CARRIED = "NIWA_BOX__";

/** Names a shell adds to what it starts, besides the ones it was given. */
const SHELL_ADDED = ["PWD", "OLDPWD", "SHLVL", "_"];

/**
 * The command a wrapper runs, and the variables it has to be started with for that command.
 *
 * The wrapper is the host's own process: it locates system tools and loads libraries before any
 * restriction exists, so the spec's environment must not reach it as its own, and it starts from a
 * directory of the host's, not the spec's, where files the command writes cannot be read as
 * configuration. A shell inside the box enters `cwd`, gives each variable its name and runs `env`,
 * which removes a launcher variable the spec leaves out and what the shell adds, so the command has
 * the variables the spec lists and what the wrapper adds itself.
 *
 * The values travel in the wrapper's environment under a prefix of their own. As arguments they
 * would be readable by every user of the machine for as long as the wrapper lives.
 */
export function insideBox(
  sandbox: SandboxName,
  launcher: Readonly<Record<string, string>>,
  guest: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  argv: readonly string[],
): { readonly command: string[]; readonly carried: Record<string, string> } {
  const program = argv[0];
  if (program === undefined) throw new BoxRefused([{ code: "adapter", message: "there is no program to run" }], sandbox);
  if (program.includes("=")) {
    throw new BoxRefused([{ code: "adapter", message: `the program ${JSON.stringify(program)} would be read by env as a variable` }], sandbox);
  }
  const names = Object.keys(guest.env);
  const unset = [...Object.keys(launcher), ...SHELL_ADDED].filter((name) => !(name in guest.env)).flatMap((name) => ["-u", name]);
  // The names are checked by the spec: letters, digits and `_` only.
  const script = [
    'cd -- "$1" || exit 126',
    "shift",
    ...names.map((name) => `export ${name}="$${CARRIED}${name}" || exit 126; unset ${CARRIED}${name}`),
    `exec /usr/bin/env ${unset.join(" ")} -- "$@"`,
  ].join("\n");
  return {
    command: ["/bin/sh", "-c", script, "niwa-box", guest.cwd, ...argv],
    carried: Object.fromEntries(names.map((name) => [`${CARRIED}${name}`, guest.env[name] ?? ""])),
  };
}

/** The name of the signal that ended a process, however the runtime reports it. */
function signalName(signal: NodeJS.Signals | number | null): NodeJS.Signals | null {
  if (typeof signal !== "number") return signal;
  const named = Object.entries(constants.signals).find(([, number]) => number === signal);
  return named === undefined ? null : (named[0] as NodeJS.Signals);
}

/** Is the program not to be found, where the spawn looks for it? */
function missing(program: string | undefined, env: Readonly<Record<string, string>>): boolean {
  if (program === undefined) return true;
  return program.includes("/") ? !existsSync(program) : Bun.which(program, { PATH: env["PATH"] ?? "" }) === null;
}

/** A working directory the command is to start in has to be there: the wrapper cannot tell the spec's fault from its own. */
function requireDirectory(cwd: string): void {
  let directory = false;
  try {
    directory = statSync(cwd).isDirectory();
  } catch {
    // Not there: reported below, as a spawn reports it.
  }
  if (!directory) throw Object.assign(new Error(`ENOENT: the working directory ${cwd} is not a directory`), { code: "ENOENT" });
}

/**
 * Starts the wrapper from `home` with the launcher's environment, and the command inside it. A
 * wrapper that is not there is `SandboxUnavailable` and no process exists, as it is when the probe
 * finds it missing; any other failure to start is the caller's to see as it is.
 */
export function spawnBox(
  sandbox: SandboxName,
  wrapper: readonly string[],
  guest: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly argv: readonly string[] },
  launcher: Readonly<Record<string, string>>,
  home: string,
  cleanup: () => Promise<void>,
  options: LaunchOptions = {},
): LaunchedBox {
  if (missing(wrapper[0], launcher)) throw new SandboxUnavailable(sandbox, `${wrapper[0] ?? "the wrapper"} is not there`);
  requireDirectory(guest.cwd);
  const stage = insideBox(sandbox, launcher, guest, guest.argv);
  const argv = [...wrapper, ...stage.command];
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn(argv, {
      cwd: home,
      env: { ...launcher, ...stage.carried },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: options.detached ?? false,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missing(argv[0], launcher)) {
      throw new SandboxUnavailable(sandbox, `${argv[0] ?? "the wrapper"} cannot be started: ${(error as Error).message}`);
    }
    throw error;
  }
  const ended = child.exited;
  const exited = ended.then(async (code) => {
    await cleanup();
    return code;
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    ended,
    signaled: exited.then(() => signalName(child.signalCode), () => null),
    kill: (signal) => child.kill(signal),
  };
}

/** Runs the wrapper once, from `home`, to see whether it can start a command in `cwd` on this machine. */
export async function probe(
  sandbox: SandboxName,
  wrapper: readonly string[],
  cwd: string,
  launcher: Readonly<Record<string, string>>,
  home: string,
): Promise<boolean> {
  try {
    const stage = insideBox(sandbox, launcher, { cwd, env: {} }, ["/usr/bin/true"]);
    const child = Bun.spawn([...wrapper, ...stage.command], { cwd: home, env: { ...launcher }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
