/**
 * The runner of a workflow script.
 *
 * The script runs in a disposable process (`child.ts`). The parent owns all state: the child asks
 * it to make every call, and the answers come back by the number of the call, so the order of the
 * results does not depend on which branch finishes first.
 */

import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { StepCancelled, TOKEN_ENV, isSuspend } from "@niwa-labs/core";
import { spawnAgent } from "@niwa-labs/sandbox";
import type { AgentProcess, BoxSandboxName } from "@niwa-labs/sandbox";

import { isPausing } from "./bridge.ts";
import { readableRoots } from "./installation.ts";
import { PROTOCOL_PREFIX, ScriptRequest } from "./language.ts";

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

/** The run a script process belongs to: its id, so a process can be told from the host's own. */
export const RUN_ENV = "NIWA_WORKFLOW_RUN";

/** Whether the script process runs in a box: `boxed` or `plain`. */
export const BOX_ENV = "NIWA_WORKFLOW_BOX";

/**
 * The box a script process runs in: the sandbox that holds it. The box is empty: nothing to write
 * outside the process, no network, and an environment of only what the bridge needs.
 */
export interface ScriptBox {
  readonly sandbox: BoxSandboxName;
  /** The host's keys: a box never reads them, whatever else it may read. */
  readonly denyRead: readonly string[];
}

/** What the script asks the parent to do: one call, wait, sleep or read. */
export interface CallRequest {
  /** The key the request is recorded under: its label, or its place among the unlabeled calls. */
  key: string;
  /** The declared phase the branch of the call is in, when it is in one: the step belongs to it. */
  phase?: string;
  /** A call before it in its branch ran instead of being taken from an earlier start: it lies after a change. */
  after?: boolean;
  /** What is asked. */
  request: ScriptRequest;
}

/** What the parent does for the child. */
export interface RunnerDeps {
  /** Do what the script asked and answer it. */
  call(request: CallRequest): Promise<unknown>;
  /** Whether the call under the key ran instead of being taken from an earlier start of the run. */
  fresh?(key: string): boolean;
  /** A branch of the script entered a phase (`""` is the script itself): the `ordinal`-th change in that branch, 0 being the phase it was made in. */
  phase(entered: { branch: string; ordinal: number; phase: string }): void;
  /** A branch that was in a phase ended. */
  left(branch: string): void;
  /** A branch joined a group of branches, before its first step. */
  branched?(joined: { scope: string; key: string }): void;
  /** The script wrote a line to the log. */
  log(text: string): void;
  /** The run is being stopped: the calls of the script that are in flight are no longer wanted. */
  stopped?(): void;
  /**
   * The script process is gone: a call that waits for something only the process could bring
   * about must answer now, or the calls in flight that the runner waits for never end.
   */
  gone?(): void;
}

/** What a run of a script ended with. */
export interface RunnerResult {
  ok: boolean;
  /** What the script returned: any JSON, until the host checks it against the `output` of the script. */
  result?: unknown;
  error?: string;
  /** The name of the error the script ended with (`AskCancelled`, `TypeError`, ...), when it threw one. */
  errorName?: string;
  /** The run was stopped while it was going: its child was killed. */
  cancelled?: boolean;
}

/**
 * The child process of a run that is going.
 *
 * A run is a process: the handle is what makes it possible to stop it, and a run that is not
 * going has no handle and nothing to stop.
 */
interface Running {
  readonly child: AgentProcess;
  /** What the run is told when it is stopped. */
  readonly deps: RunnerDeps;
  /** Whether the run was stopped by a cancel. */
  stopped: boolean;
}

const children = new Map<string, Running>();

/** How long a child that has a suspended call may stay silent before it is stopped. */
const QUIET_MS = 50;

/**
 * Stop the child process of a run.
 *
 * The child is disposable and holds nothing, so it is stopped and not asked. It says whether
 * there was a child to stop.
 */
export function stopRun(run: string): boolean {
  const running = children.get(run);
  if (running === undefined) return false;
  running.stopped = true;
  running.deps.stopped?.();
  running.child.kill();
  return true;
}

/** What a stream says, read to its end. */
async function textOf(stream: Readable): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  return text + decoder.decode();
}

const Message = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("call"),
    ordinal: z.number(),
    key: z.string(),
    phase: z.string().optional(),
    after: z.boolean().optional(),
    request: ScriptRequest,
  }),
  z.object({ kind: z.literal("phase"), branch: z.string(), ordinal: z.number().int().nonnegative(), phase: z.string() }),
  z.object({ kind: z.literal("left"), branch: z.string() }),
  z.object({ kind: z.literal("branched"), scope: z.string(), key: z.string() }),
  z.object({ kind: z.literal("log"), text: z.string() }),
  z.object({ kind: z.literal("done"), result: z.unknown() }),
  z.object({ kind: z.literal("failed"), error: z.string(), name: z.string().optional() }),
]);

/**
 * Start the disposable process of a script, in a mode of the child (`run` or `describe`).
 *
 * The process is born in the launch funnel. The token of the owner is never handed on, boxed or not; in
 * a box nothing of the host's environment is, and the markers tell the two modes apart. A script that
 * is run in a box is also read in one: its top level is the script's own code.
 */
export async function spawnScriptChild(mode: "run" | "describe", file: string, extra: readonly string[], run: string, box?: ScriptBox): Promise<AgentProcess> {
  const path = resolve(file);
  return spawnAgent({
    harness: "workflow",
    program: process.execPath,
    args: [CHILD, mode, pathToFileURL(path).href, ...extra],
    unset: [TOKEN_ENV],
    env: { [RUN_ENV]: run, [BOX_ENV]: box === undefined ? "plain" : "boxed" },
    ...(box === undefined
      ? {}
      : {
          cwd: dirname(path),
          box: {
            sandbox: box.sandbox,
            // Reading is all the box gives: the child and its modules, and the script.
            spec: { cwd: dirname(path), read: readableRoots(), denyRead: [...box.denyRead] },
            mark: run,
          },
        }),
  });
}

/**
 * Run a script in a disposable process and wait for its end. The process never outlives this call.
 *
 * The run may be stopped while it is going: the child is killed, and the call that was in flight
 * is left to the caller — it is a step of the invocation, and the invocation decides what becomes
 * of it. The runner waits for the child and nothing else.
 *
 * A call that waits for a record that has not arrived suspends the invocation it runs in. That
 * is not a failure of the script: the child is stopped, the calls that are in flight are waited
 * for, and the suspend is passed on, so the invocation ends as "waiting" and the run goes on
 * when the answer arrives.
 */
export async function runScript(
  deps: RunnerDeps,
  file: string,
  args: unknown,
  run: string,
  box?: ScriptBox,
): Promise<RunnerResult> {
  const child = await spawnScriptChild("run", file, [JSON.stringify(args ?? null)], run, box);
  // A script that exits before it reads its answers must not take the host down with a broken pipe.
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  const running: Running = { child, deps, stopped: false };
  children.set(run, running);
  let ended: RunnerResult | undefined;
  let stopped = false;
  let suspended: unknown;
  const calls: Promise<void>[] = [];
  // The calls the host is making for the child now: a suspended call is not one of them, nor a wait for a deadline.
  let busy = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  /**
   * A call suspended: the child goes on while the host still makes calls for it, so the branches
   * that do not wait move on and their steps are recorded. Once the host makes none and the child
   * asks for nothing more for a moment, the child is stopped and the suspend is passed on.
   */
  const stopWhenQuiet = (): void => {
    if (suspended === undefined || busy > 0) return;
    if (quiet !== undefined) clearTimeout(quiet);
    quiet = setTimeout(() => {
      if (busy === 0) child.kill();
    }, QUIET_MS);
  };

  const answer = (ordinal: number, reply: { ok: boolean; value?: unknown; error?: string; name?: string; pauses?: boolean; fresh?: boolean }): void => {
    if (stopped) return;
    child.stdin.write(`${JSON.stringify({ ordinal, ...reply })}\n`);
  };

  const handle = (line: string): void => {
    // Only a line of the protocol is a message: the script shares the stdout with the child,
    // and a line the script wrote is its own output, which is passed through as a log.
    if (!line.startsWith(PROTOCOL_PREFIX)) {
      deps.log(line);
      return;
    }
    const message = Message.parse(JSON.parse(line.slice(PROTOCOL_PREFIX.length)));
    switch (message.kind) {
      case "call": {
        // The call is made, and its answer goes back to the child. A call that is still in flight
        // when the child is stopped is not waited for here: the invocation it belongs to owns it.
        const counted = message.request.op !== "scope-deadline";
        if (counted) busy += 1;
        if (quiet !== undefined) clearTimeout(quiet);
        calls.push(
          deps.call({
            key: message.key,
            ...(message.phase === undefined ? {} : { phase: message.phase }),
            ...(message.after === true ? { after: true } : {}),
            request: message.request,
          }).then(
            // The child is told when the call ran instead of being taken: what comes after it in its branch runs too.
            (value) => answer(message.ordinal, { ok: true, value: value ?? null, ...(deps.fresh?.(message.key) === true ? { fresh: true } : {}) }),
            (error: unknown) => {
              // A call that suspends is not a failure: the invocation waits, and the call is made
              // again when the answer arrives. The child is stopped once it is quiet, and the suspend is passed on.
              if (isSuspend(error)) {
                suspended ??= error;
                return;
              }
              answer(message.ordinal, {
                ok: false,
                // A cancelled step says why it was cancelled: the script sees the reason, as for a cancel of its own.
                error: error instanceof StepCancelled ? error.reason : error instanceof Error ? error.message : String(error),
                // The name goes with the message, so a script can tell one error from another.
                ...(error instanceof Error ? { name: error.name } : {}),
                // An error that pauses the run is not the outcome of a branch: the script ends on it.
                ...(isPausing(error) ? { pauses: true } : {}),
                ...(deps.fresh?.(message.key) === true ? { fresh: true } : {}),
              });
            },
          ).finally(() => {
            if (counted) busy -= 1;
            stopWhenQuiet();
          }),
        );
        return;
      }
      case "phase":
        deps.phase({ branch: message.branch, ordinal: message.ordinal, phase: message.phase });
        return;
      case "left":
        deps.left(message.branch);
        return;
      case "branched":
        deps.branched?.({ scope: message.scope, key: message.key });
        return;
      case "log":
        deps.log(message.text);
        return;
      case "done":
        ended = { ok: true, result: message.result };
        return;
      case "failed":
        ended = { ok: false, error: message.error, ...(message.name === undefined ? {} : { errorName: message.name }) };
        return;
    }
  };

  const stderr = textOf(child.stderr);
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line !== "") handle(line);
      }
    }
    const code = await exited;
    // A call suspended: the child is stopped, the calls that are in flight are waited for, and
    // the suspend is passed on. The invocation ends as "waiting", and the run goes on when the
    // answer arrives.
    if (suspended !== undefined) {
      deps.gone?.();
      await Promise.allSettled([...calls]);
      throw suspended;
    }
    if (ended !== undefined) return ended;
    // The run was stopped: its child was killed, so it ended there and not by the script.
    if (running.stopped) return { ok: false, cancelled: true, error: "the run was cancelled" };
    const reason = (await stderr).trim();
    return { ok: false, error: reason !== "" ? reason : `the script exited with ${String(code)} without a result` };
  } finally {
    stopped = true;
    if (quiet !== undefined) clearTimeout(quiet);
    deps.gone?.();
    child.kill();
    // The handle of the run goes with it: a run that is not going has nothing to stop.
    if (children.get(run) === running) children.delete(run);
    // The calls that are in flight are not waited for: a call that was cut off is the
    // invocation's, and it decides what becomes of it.
    for (const call of calls) void call.catch(() => undefined);
  }
}
