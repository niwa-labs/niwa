/**
 * serve.ts — running a host from a composition.
 *
 * A composition is a file that exports the plugins of a host: the file says which plugins run,
 * and nothing else. The CLI starts the host, the host takes the journal, and the plugins do
 * their work.
 *
 * The file may export the plugins as a default export, as a named `plugins` export, or as any
 * number of named exports that are plugins. A plugin is anything with a `setup` function: that
 * is what the core calls, and that is what the file must give.
 */

import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

import { tokenOf, connect, livingHolderPid } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Plugin } from "@niwa-labs/plugin";

/** A plugin is anything the host can install: it has a name and a setup function. */
function isPlugin(value: unknown): value is Plugin {
  if (value === null || typeof value !== "object") return false;
  const holder = value as { name?: unknown; setup?: unknown };
  return typeof holder.name === "string" && typeof holder.setup === "function";
}

/**
 * The plugins of a composition file.
 *
 * Every export that is a plugin, or an array of plugins, is taken, in the order of the exports.
 */
export function pluginsOf(module: Record<string, unknown>): Plugin[] {
  const found: Plugin[] = [];
  const push = (value: unknown): void => {
    if (isPlugin(value)) {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) push(item);
    }
  };
  for (const value of Object.values(module)) push(value);
  return found;
}

/**
 * Run a host from a composition file, until it is stopped.
 *
 * The host owns the journal: only one host may hold it, and a second one is refused.
 */
export async function serveComposition(opts: { file: string; home: string }): Promise<void> {
  const path = resolve(opts.file);
  const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const plugins = pluginsOf(module);
  if (plugins.length === 0) {
    throw new Error(`the composition "${path}" exports no plugin`);
  }

  const niwa = createNiwa({ home: opts.home, onStop: () => stop() });
  niwa.use(...plugins);
  await niwa.serve();
  console.error(`niwa: serving ${opts.home} with ${String(plugins.length)} plugin(s)`);

  // The host ends when it is told to: the journal is given back, so the next host may take it.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    niwa.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`niwa: closing failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** The exit code of `niwa serve -d` when a host already serves the home. */
export const ALREADY_SERVING = 5;

/** How long `niwa serve -d` waits for the host to answer on its socket. */
const READY_WAIT_MS = 30_000;

/** How many lines of the log a failed start shows. */
const LOG_TAIL_LINES = 20;

/** What `niwa serve -d` did: the text to print and the exit code. */
export interface DetachedServe {
  readonly output: string;
  readonly code: number;
}

/**
 * Start the host of a composition as a background process, and wait until it answers.
 *
 * The host is a new session, so it outlives the terminal; its output is appended to
 * `<home>/niwa.log`. When it exits early or does not answer in time, what it logged in this
 * start is the answer, and the code is non-zero.
 */
export async function serveDetached(opts: { file: string; home: string; entry: string }): Promise<DetachedServe> {
  const home = resolve(opts.home);
  const holder = livingHolderPid(home);
  if (holder !== undefined) {
    return { output: `a host already serves ${home} (pid ${String(holder)})`, code: ALREADY_SERVING };
  }
  mkdirSync(home, { recursive: true });
  const logPath = join(home, "niwa.log");
  const logFd = openSync(logPath, "a");
  const logStart = statSync(logPath).size;
  const child = Bun.spawn([process.execPath, opts.entry, "--home", home, "serve", resolve(opts.file)], {
    detached: true,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  closeSync(logFd);
  child.unref();

  const failed = (reason: string): DetachedServe => ({
    output: `${reason}\n${logTail(logPath, logStart)}`,
    code: 1,
  });
  const deadline = Date.now() + READY_WAIT_MS;
  while (child.exitCode === null) {
    if (await answers(home)) {
      return { output: [`pid ${String(child.pid)}`, `home ${home}`, `log ${logPath}`].join("\n"), code: 0 };
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      return failed(`the host did not answer within ${String(READY_WAIT_MS / 1000)} s`);
    }
    await Bun.sleep(100);
  }
  return failed(`the host exited with code ${String(child.exitCode)} before it answered`);
}

/** Does a host answer on the socket of the home? */
async function answers(home: string): Promise<boolean> {
  const token = tokenOf(home);
  try {
    const api = await connect({ home, id: "cli", ...(token === undefined ? {} : { token }) });
    await api.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** The last lines of the log written since `from`. */
function logTail(path: string, from: number): string {
  const text = readFileSync(path).subarray(from).toString("utf8").trimEnd();
  return text.split("\n").slice(-LOG_TAIL_LINES).join("\n");
}
