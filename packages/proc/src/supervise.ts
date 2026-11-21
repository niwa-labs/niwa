/**
 * Watching one started command: its output into a capture, its time, and its end.
 *
 * The command leads its own process group, so what it started goes with it. The group is stopped
 * when the time is up, and again when the command itself is over: a background child that
 * outlives its parent holds the output pipes open, and a run waiting for them would never end.
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { LaunchedBox } from "@niwa-labs/sandbox";

import type { OutputCapture } from "./artifact.ts";
import type { ProcOutcome } from "./records.ts";

export interface SuperviseOptions {
  /** How long the command may run, in milliseconds. */
  readonly timeout: number;
  /** How long a stopped group has to end before it is killed, in milliseconds. */
  readonly killGraceMs: number;
  /** How long to wait for the output to be read once the command is over, in milliseconds. */
  readonly drainMs: number;
}

/** How the command ended. */
export interface Ended {
  readonly outcome: ProcOutcome;
  /** The exit code; null when the command was stopped for its time. */
  readonly exit: number | null;
  readonly durationMs: number;
}

/** Signals the group a command leads; a group that is gone is not an error. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Nothing is left in the group.
  }
}

/** Reads a stream into the capture until it ends or is cancelled. */
async function pump(reader: ReadableStreamDefaultReader<Uint8Array>, feed: (chunk: Uint8Array) => void): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      feed(value);
    }
  } catch {
    // A stream that fails has said all it will.
  }
}

/** Runs a started command to its end, with its output going to the capture. */
export async function supervise(child: LaunchedBox, capture: OutputCapture, options: SuperviseOptions): Promise<Ended> {
  const started = Date.now();
  child.stdin.end();
  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
  const reading = Promise.all([
    pump(readers[0], (chunk) => capture.feed("out", chunk)),
    pump(readers[1], (chunk) => capture.feed("err", chunk)),
  ]);

  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup(child.pid, "SIGTERM");
    killer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), options.killGraceMs);
  }, options.timeout);

  // A box whose clean-up failed has still ended the process: the output is what it was.
  const code = await child.exited.then(
    (value) => value,
    () => null,
  );
  clearTimeout(timer);
  clearTimeout(killer);
  signalGroup(child.pid, "SIGKILL");
  await Promise.race([reading, sleep(options.drainMs)]);
  for (const reader of readers) void reader.cancel().catch(() => {});

  return { outcome: timedOut ? "timed-out" : "exited", exit: timedOut ? null : code, durationMs: Date.now() - started };
}
