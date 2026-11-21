/**
 * Watching one started command: its output into a capture, its time, and its end.
 *
 * The command leads its own process group, so what it started goes with it. The group is stopped
 * when the time is up, and again when the command itself is over: a background child that
 * outlives its parent holds the output pipes open, and a run waiting for them would never end.
 */

import type { LaunchedBox } from "@niwa-labs/sandbox";

import type { OutputCapture } from "./artifact.ts";
import { ProcRefusal } from "./refusal.ts";
import type { ProcOutcome } from "./records.ts";

export interface SuperviseOptions {
  /** How long the command may run, in milliseconds. */
  readonly timeout: number;
  /** How long a stopped group has to end before it is killed, in milliseconds. */
  readonly killGraceMs: number;
  /** How long to wait for the output to be read once the command is over, in milliseconds. */
  readonly drainMs: number;
  /** Aborted when the call is cancelled: the command is stopped like one that ran out of time. */
  readonly signal?: AbortSignal | undefined;
}

/** How the command ended. */
export interface Ended {
  readonly outcome: ProcOutcome;
  /** The exit code; null when the command was stopped for its time or because the call was cancelled. */
  readonly exit: number | null;
  readonly durationMs: number;
  /**
   * Reading the output was given up while something the command started still held its pipes open
   * (it had left the command's process group), or a pipe failed: what it wrote after that is not in
   * the output.
   */
  readonly outputCut: boolean;
}

/** Signals the group a command leads; a group that is gone is not an error. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Nothing is left in the group.
  }
}

/** What the supervisor needs of a stream's reader. */
interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<unknown>;
}

/** What went wrong while the output was read. */
interface ReadState {
  /** The capture could not keep what it was given: the error is the call's. */
  failure?: { readonly error: unknown };
  /** A pipe failed before it ended. */
  broken: boolean;
}

/** Reads a stream into the capture until it ends, fails or is cancelled. */
async function pump(reader: Reader, feed: (chunk: Uint8Array) => void, state: ReadState, stop: () => void): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value === undefined || state.failure !== undefined) continue;
      try {
        feed(value);
      } catch (error) {
        // The output cannot be kept: the command is stopped, and the call fails with this.
        state.failure = { error };
        stop();
      }
    }
  } catch {
    state.broken = true;
  }
}

/** Runs a started command to its end, with its output going to the capture. */
export async function supervise(child: LaunchedBox, capture: OutputCapture, options: SuperviseOptions): Promise<Ended> {
  const started = Date.now();
  child.stdin.end();
  const readers: readonly [Reader, Reader] = [child.stdout.getReader(), child.stderr.getReader()];
  const state: ReadState = { broken: false };
  const stop = () => signalGroup(child.pid, "SIGKILL");
  const reading = Promise.all([
    pump(readers[0], (chunk) => capture.feed("out", chunk), state, stop),
    pump(readers[1], (chunk) => capture.feed("err", chunk), state, stop),
  ]);

  // The first reason the command is stopped for is the one it ended with.
  let stopped: "timed-out" | "cancelled" | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stopFor = (reason: "timed-out" | "cancelled") => {
    if (stopped !== undefined) return;
    stopped = reason;
    signalGroup(child.pid, "SIGTERM");
    killer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), options.killGraceMs);
  };
  const timer = setTimeout(() => stopFor("timed-out"), options.timeout);
  const cancel = () => stopFor("cancelled");
  if (options.signal?.aborted === true) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });

  // The command ends with its process. A box that is slow to clean up, or fails to, after the
  // process is gone has not changed how the command ended: the clean-up is waited for apart.
  const code = await (child.ended ?? child.exited).then(
    (value) => value,
    () => null,
  );
  clearTimeout(timer);
  clearTimeout(killer);
  options.signal?.removeEventListener("abort", cancel);
  signalGroup(child.pid, "SIGKILL");
  let drain: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    reading.then(() => true),
    new Promise<boolean>((resolve) => {
      drain = setTimeout(() => resolve(false), options.drainMs);
    }),
  ]);
  clearTimeout(drain);
  for (const reader of readers) void reader.cancel().catch(() => {});
  await child.exited.catch(() => undefined);
  if (state.failure !== undefined) throw state.failure.error;

  return { outcome: stopped ?? "exited", exit: stopped === undefined ? code : null, durationMs: Date.now() - started, outputCut: !drained || state.broken };
}

/**
 * Starts a command with no box, leading its own process group, with exactly the environment given.
 * A program that cannot be started is a refusal: nothing ran.
 */
export function launchPlain(cmd: readonly string[], cwd: string, env: Readonly<Record<string, string>>): LaunchedBox {
  try {
    const child = Bun.spawn([...cmd], { cwd, env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  } catch (error) {
    throw new ProcRefusal("not-started", `cannot start ${cmd[0] ?? "the command"}: ${(error as Error).message}`);
  }
}
