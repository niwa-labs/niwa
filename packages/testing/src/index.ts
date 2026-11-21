/**
 * Testing helpers for niwa: a real host, a real journal, a real signal.
 *
 * Effects are counted through files in the home, one line per hit, so a count survives the
 * death of the process that wrote it. A gate blocks a stubbed action until the test opens it;
 * that block is the point, so it has no deadline. Everything else has one.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";

import { action } from "@niwa-labs/core";
import type { Clock, Action, ActionContext, Effect, Recovery } from "@niwa-labs/core";
import { socketPath } from "@niwa-labs/client";

// What nearly every test needs besides the helpers below: a host to run, a client to speak with,
// and the helpers shared by the tests.
export { createNiwa } from "@niwa-labs/host";
export { connect } from "@niwa-labs/client";
export { live, loginWeb, opt, pick, webFetch } from "./helpers.ts";
export { COCKPIT_MODULE, plugin } from "./cli.ts";
export {
  STATE_TYPE,
  connectAsOwner,
  invocationOf,
  lastState,
  ownerTokenOf,
  runFinishes,
  watch,
} from "./client.ts";
export type { InvocationStateData, WaitedRun } from "./client.ts";
export { claudePrompt, fakeSdkQuery } from "./harness-claude.ts";
export type { FakeCall } from "./harness-claude.ts";
export { ZCODE_FAKE } from "./harness-zcode.ts";
export * from "./messages.ts";
export * from "./niwa.ts";
export * from "./requests.ts";
export { unreadable, unsendable } from "./schema-reads.ts";
export * from "./sessions.ts";
export * from "./tasks.ts";
export * from "./web.ts";
export * from "./workflow.ts";

const READY_TIMEOUT_MS = 10_000; // How long `ready()` waits for the host to accept a connection.
const STOP_GRACE_MS = 5_000; // How long `stop()` gives SIGTERM before SIGKILL.
const POLL_INTERVAL_MS = 20; // The interval of every poll in this file.

/** The file a counter's hits are appended to, or a gate is opened by. */
function homeFile(home: string, dir: "counters" | "gates", name: string): string {
  const what = dir === "counters" ? "counter name" : "gate name";
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  if (/[/\\]/.test(name) || name === "." || name === "..") {
    throw new TypeError(`${what} "${name}" must not contain a path separator`);
  }
  return join(home, dir, name);
}

/** Poll until the condition holds; the failure names what was waited for. */
async function pollUntil(
  fn: () => boolean | Promise<boolean>,
  deadline: number,
  message: () => string,
): Promise<void> {
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(message());
    await sleep(POLL_INTERVAL_MS);
  }
}

const TEMP_PREFIX = "niwa-test-"; // Every directory made here starts with it, then the pid of the run that made it.
const owned = new Set<string>(); // The directories this process made and has not removed yet.
let sweeping = false;

/** Whether a process is alive; a process of another user counts as alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A directory that cannot be removed must not hide the failure of the test before it.
  }
}

/** Remove the directories this process made and has not removed yet. */
export function sweepTempDirs(): void {
  for (const path of owned) removeQuietly(path);
  owned.clear();
}

/**
 * The backstop for a directory a test did not remove (it failed, timed out or never reached its
 * cleanup). This run's own directories go when the process exits or is interrupted, and when the
 * test runner calls `sweepTempDirs` (`bun test` does not emit `exit`). The directories of runs
 * whose process is gone (killed, so it could not sweep) go when the next run starts. A directory
 * of a run that is still alive is never touched.
 */
function startSweeping(): void {
  if (sweeping) return;
  sweeping = true;
  for (const name of readdirSync(tmpdir())) {
    const pid = new RegExp(`^${TEMP_PREFIX}(\\d+)-`).exec(name)?.[1];
    if (pid !== undefined && !alive(Number(pid))) removeQuietly(join(tmpdir(), name));
  }
  process.on("exit", sweepTempDirs);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      sweepTempDirs();
      process.exit(code);
    });
  }
}

/** A fresh, empty directory that is removed when the process ends, whatever became of the test. */
export async function tempDir(label: string): Promise<string> {
  startSweeping();
  const path = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${String(process.pid)}-${label}-`));
  owned.add(path);
  return path;
}

/** `tempDir` for a test that cannot await. */
export function tempDirSync(label: string): string {
  startSweeping();
  const path = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${String(process.pid)}-${label}-`));
  owned.add(path);
  return path;
}

/** A fresh, empty home: where the journal, the socket, the counters and the gates live. */
export async function tempHome(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await tempDir("home");
  return {
    path,
    // A failing cleanup must not hide the failure of the test before it.
    cleanup: async (): Promise<void> => {
      owned.delete(path);
      await rm(path, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** A counter: how many times something happened, counted across processes. */
export interface Counter {
  hit(): void;
  count(): number;
}

/** A counter shared through the file system: one hit appends one line, atomically. */
export function counter(home: string, name: string): Counter {
  const path = homeFile(home, "counters", name);
  return {
    hit(): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${Date.now()}\n`);
    },
    count(): number {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      return text.split("\n").filter((line) => line.trim() !== "").length;
    },
  };
}

/**
 * A gate: a point where an action waits until the test lets it through. The gate is a file:
 * `open()` creates it, `wait()` returns once it exists. A gate that is never opened blocks the
 * action forever — that is how a test parks a host inside a step.
 */
export interface Gate {
  open(): void;
  isOpen(): boolean;
  /** Resolves once the gate is open; with `timeoutMs` it rejects instead of waiting forever. */
  wait(timeoutMs?: number): Promise<void>;
}

/** A gate shared through the file system. */
export function gate(home: string, name: string): Gate {
  const path = homeFile(home, "gates", name);
  return {
    open(): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    },
    isOpen(): boolean {
      return existsSync(path);
    },
    async wait(timeoutMs?: number): Promise<void> {
      await pollUntil(
        () => existsSync(path),
        timeoutMs === undefined ? Infinity : Date.now() + timeoutMs,
        () => `the gate "${name}" was not opened within ${String(timeoutMs)} ms`,
      );
    },
  };
}

/**
 * The operation ids of the calls of one action, in the order they were made.
 *
 * They are appended to a file in the home, one per line, so they survive the death of the
 * process that made them. A test reads them to tell one operation from another across a
 * crash: the same operation id means the other side will dedupe the call.
 */
export interface Operations {
  hit(operationId: string): void;
  /** The operation ids, in the order they were recorded. */
  ids(): string[];
}

/** The operation ids of the calls of one action, shared through the file system. */
export function operations(home: string, name: string): Operations {
  const path = homeFile(home, "counters", `operations-${name}`);
  return {
    hit(operationId: string): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${operationId}\n`);
    },
    ids(): string[] {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      return text.split("\n").filter((line) => line.trim() !== "");
    },
  };
}

/**
 * A stubbed action: it counts, it may wait on a gate, and it returns a fixed result.
 *
 * It may also record the operation id of every call, so a test can tell one operation from
 * another across a crash: the ids are appended to a file, one per line, in the same order as
 * the calls.
 *
 * The recovery contract is given by the test, like the gate: a stub that counts its calls is
 * not safe to make again by itself, and one that stands for an effect that cannot be
 * repeated says so.
 */
export function stubAction<I, O, In = I>(
  name: string,
  opts: {
    home: string;
    input: z.ZodType<I, In>;
    output: z.ZodType<O>;
    recovery: Recovery;
    /** What a call changes. Default: "write". */
    effect?: Effect;
    /** The name of the gate this action waits on before it returns. */
    gate?: string;
    /** Record the operation id of every call, under this name. */
    operations?: string;
    result: (input: I) => O;
  },
): Action<I, O, In> {
  const { home, input, output, recovery, result } = opts;
  const count = counter(home, name);
  const ids = opts.operations === undefined ? undefined : operations(home, opts.operations);
  return action<I, O, In>(name, {
    description: `A stubbed action "${name}": it counts its calls and returns a fixed result.`,
    input,
    output,
    recovery,
    effect: opts.effect ?? "write",
    async run(value: I, ctx: ActionContext): Promise<O> {
      count.hit();
      ids?.hit(ctx.operationId);
      if (opts.gate !== undefined) await gate(home, opts.gate).wait();
      return result(value);
    },
  });
}

/**
 * A clock a test moves by hand.
 *
 * The clock starts at a moment the test names and only moves when the test says so. The work
 * that was scheduled for a moment that the clock has passed runs then, in the order the moments
 * come, and `advance` waits for it: a test can watch a week of work without waiting a week.
 *
 * The callbacks are run in time order, and one at a time: a callback that schedules more work
 * for a later moment does not jump ahead of the work that was due before it.
 */
export interface TestClock extends Clock {
  /** The moment now, in milliseconds since the epoch. */
  now(): number;
  /**
   * Move the clock forward by `ms`, and run the work that comes due.
   *
   * The callbacks that come due are awaited, so the work they did is done when `advance`
   * returns. A callback that fails does not stop the others: the failure is reported, and the
   * clock keeps moving.
   */
  advance(ms: number): Promise<void>;
  /** The failures of the callbacks that were run, in the order they failed. */
  failures(): Error[];
}

/** One scheduled piece of work: when it is due, and what it does. */
interface Scheduled {
  readonly at: number;
  readonly fn: () => void | Promise<void>;
  cancelled: boolean;
}

/**
 * A clock that only moves when the test says so.
 *
 * `start` is the moment it begins at, in milliseconds since the epoch; the default is the moment
 * the clock was made.
 */
export function testClock(start: number = Date.now()): TestClock {
  let now = start;
  let scheduled: Scheduled[] = [];
  const failures: Error[] = [];
  return {
    now: (): number => now,
    schedule: (at, fn): (() => void) => {
      const entry: Scheduled = { at, fn, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    async advance(ms: number): Promise<void> {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError(`the clock advances by a non-negative number of milliseconds, got ${String(ms)}`);
      }
      const target = now + ms;
      for (;;) {
        // The nearest moment that is due, and not cancelled.
        let next: Scheduled | undefined;
        for (const entry of scheduled) {
          if (entry.cancelled || entry.at > target) continue;
          if (next === undefined || entry.at < next.at) next = entry;
        }
        if (next === undefined) break;
        next.cancelled = true;
        scheduled = scheduled.filter((entry) => entry !== next && !entry.cancelled);
        // The clock stands at the moment of the work, so the work sees the time it was due at.
        now = Math.max(now, next.at);
        try {
          await next.fn();
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      now = target;
    },
    failures: (): Error[] => [...failures],
  };
}

/** Wait until a condition holds; the message says what was waited for. */
export async function eventually(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  message?: string,
): Promise<void> {
  await pollUntil(
    fn,
    Date.now() + timeoutMs,
    () => message ?? `the condition was not met within ${String(timeoutMs)} ms`,
  );
}

/** A host process under test. */
export interface HostProcess {
  readonly pid: number;
  /** Resolves when the host accepts a connection on its socket. */
  ready(): Promise<void>;
  /** Crash the host: SIGKILL, no clean shutdown. */
  kill(): Promise<void>;
  /** Stop the host: SIGTERM, then SIGKILL if it does not exit. */
  stop(): Promise<void>;
  output(): string;
}

/** Host children still running. A test that times out skips its `finally`, so they are also
 * killed when the runner exits. */
const liveHosts = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const child of liveHosts) child.kill("SIGKILL");
});

/**
 * Spawn a host program: `bun <script> <home> [args...]`, with the home as its argument. The
 * script is an absolute path (a test names the program that sits next to it); the child runs in
 * the directory of the script. Its output is collected from the start: a host that died during
 * startup says why only in what it printed.
 */
export function spawnHost(script: string, home: string, args: string[] = []): HostProcess {
  const path = resolve(script);
  const cwd = dirname(path);
  const child = Bun.spawn([process.execPath, path, home, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  liveHosts.add(child);
  void child.exited.then(() => liveHosts.delete(child));

  const chunks: string[] = [];
  void collect(chunks, child.stdout);
  void collect(chunks, child.stderr);

  let gone = false;
  void child.exited.then(() => {
    gone = true;
  });

  const output = (): string => chunks.join("");

  /** Wait until the socket accepts a connection: the host deletes a stale socket before it
   * listens, so the file can exist while nobody answers. */
  const waitForSocket = (): Promise<void> =>
    pollUntil(
      async () => {
        if (await connectOnce(socketPath(home))) return true;
        if (gone) {
          throw new Error(`the host process exited before it was ready.\n--- output ---\n${output()}`);
        }
        return false;
      },
      Date.now() + READY_TIMEOUT_MS,
      () =>
        `the host did not accept a connection within ${String(READY_TIMEOUT_MS)} ms.\n` +
        `--- output ---\n${output()}`,
    );

  let readyPromise: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    readyPromise ??= waitForSocket();
    return readyPromise;
  };

  return {
    pid: child.pid,
    ready,
    async kill(): Promise<void> {
      if (!gone) child.kill("SIGKILL");
      await child.exited;
    },
    async stop(): Promise<void> {
      if (gone) {
        await child.exited;
        return;
      }
      child.kill("SIGTERM");
      // A host that ignores SIGTERM must not hang the test.
      const exited = await Promise.race([
        child.exited.then(() => true),
        sleep(STOP_GRACE_MS).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL");
      await child.exited;
    },
    output,
  };
}

/**
 * Append the text of a stream to the shared output. Each stream has its own decoder: a
 * multibyte character split across two chunks must survive, and two streams must not share
 * the state of a split character.
 */
async function collect(chunks: string[], stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (stream === null) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }));
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
  } catch {
    // The stream was closed under us (the process died); what was read is what there is.
  }
}

/** One connection attempt to a unix socket, with a deadline: a refused or silent socket is false. */
function connectOnce(path: string): Promise<boolean> {
  return new Promise<boolean>((resolveAttempt) => {
    const socket = net.connect({ path });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveAttempt(false);
    }, 1_000);
    timer.unref?.();

    socket.once("connect", () => {
      clearTimeout(timer);
      // Greet the host the way a client does, then leave: this proves the host is serving.
      try {
        socket.write(`${JSON.stringify({ id: 1, op: "hello", client: "niwa-testing" })}\n`);
      } catch {
        // The host may have closed the connection already; the greeting was best-effort.
      }
      socket.end();
      resolveAttempt(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveAttempt(false);
    });
  });
}
