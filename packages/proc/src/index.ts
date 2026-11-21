/**
 * The proc module: run a command.
 *
 * - **proc.run** runs a command in a box from `@niwa-labs/sandbox`: it may write only in its working
 *   directory, it has no network, and it has no credentials: its environment is `PATH`, `HOME` and what
 *   the call lists, and the keys of the host and the places credentials live are closed to it. Because
 *   the box holds this, the class of the action is honest for any command: a write in the local world. It
 *   never runs without a box: a box that cannot run here stops the call before a process exists.
 *
 * - **proc.exec** runs a command with no box. Nothing limits what it writes or reaches, so it is an
 *   irreversible action in the external world, and a grant has to name it. It gets `PATH`, `HOME`,
 *   what the call lists, and the secrets the call names. A secret is a reference, `secret("name")`; its value
 *   is resolved by the host's secret store, handed to the process, and removed from the output before
 *   the artifact or the tail is made. Nothing the host holds goes into the environment of the command
 *   unless the call lists it.
 *
 * A command ends like this: the output is stored as an artifact of the host before anything points at it, the
 * result has the exit code and a bounded tail, and a `proc.finished` record says how the command
 * ended. A non-zero exit is a result: the caller reads it.
 *
 * A command that was cut off may have done any part of its work, so the recovery contract is
 * `do-not-repeat`.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { HOST_KEY_FILE, OWNER_TOKEN_FILE, RECORD_DATA_LIMIT, action } from "@niwa-labs/core";
import type { ActionContext } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { SandboxUnavailable, SandboxUnsupported, boxSpec, nono, requireSandbox, srt } from "@niwa-labs/sandbox";
import type { BoxSpec, Sandbox } from "@niwa-labs/sandbox";

import { OutputCapture } from "./artifact.ts";
import { ProcRefusal } from "./refusal.ts";
import { MAX_TAIL_BYTES, ProcFinished, fileTarget, procExec, procRun } from "./records.ts";
import type { BoxUsed, ProcFinishedData, ProcResult } from "./records.ts";
import { launchPlain, supervise } from "./supervise.ts";

export * from "./records.ts";
export { ProcRefusal } from "./refusal.ts";
export type { ProcRefusalCode } from "./refusal.ts";

/** What the module is given. Every field has a default. */
export interface ProcOptions {
  /** The sandbox of `proc.run`. Default: nono where it can run, else srt. */
  readonly sandbox?: Sandbox;
  /** The most bytes of output kept in an artifact. Default: 16 MiB. */
  readonly outputLimit?: number;
  /**
   * The bytes of the end of the output a result carries, 0 to 64 KiB. Default: 4 KiB. A tail that
   * would not fit the record of the command, once escaped, is cut to fit.
   */
  readonly tailBytes?: number;
  /** How long a stopped command has to end before it is killed, in milliseconds. Default: 2000. */
  readonly killGraceMs?: number;
}

const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 4096;
const DEFAULT_KILL_GRACE_MS = 2000;
const DRAIN_MS = 1000;

/** Places under the user's home where credentials live. A box does not read them. */
const CREDENTIAL_PLACES = [".ssh", ".aws", ".gnupg", ".netrc", ".config/gh", ".config/gcloud", ".docker", ".kube"] as const;

/**
 * The directory a call is about, as a grant names it: the real path, so a link cannot name a place
 * the grant does not cover.
 */
function cwdTarget(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/**
 * The directory a command runs in: the real path of an existing directory, and the one the grant
 * was checked against. `authorized` is the real path the call was matched at: if the path now leads
 * somewhere else (a link was moved after the check), the command does not start.
 */
function directoryOf(cwd: string, authorized: string | undefined): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    throw new ProcRefusal("bad-cwd", `${cwd} does not exist`);
  }
  if (authorized !== undefined && real !== authorized) {
    throw new ProcRefusal("bad-cwd", `${cwd} changed after the call was checked: it was ${authorized}, it is ${real}`);
  }
  if (!statSync(real).isDirectory()) throw new ProcRefusal("bad-cwd", `${cwd} is not a directory`);
  return real;
}

/** The environment every command has before the call adds to it. */
function baseEnv(): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: homedir() };
}

/**
 * What a sandbox says before any process exists, as the refusal of the call: the command never
 * started, so the caller is told so, and it is not a failure that may have had an effect.
 */
async function beforeStart<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (error instanceof SandboxUnavailable || error instanceof SandboxUnsupported) throw new ProcRefusal("no-sandbox", error.message);
    throw error;
  }
}

/** An option that is a whole number in a range, or the error that says which one is not. */
function wholeNumber(name: string, value: number | undefined, fallback: number, least: number, most: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < least || chosen > most) {
    throw new TypeError(`proc option ${name} must be a whole number from ${String(least)} to ${String(most)}, got ${String(chosen)}`);
  }
  return chosen;
}

/** Room left in a record for what is not the tail: names the record's own fields and the escaping of the paths. */
const RECORD_SLACK = 8 * 1024;

/** The result with its tail cut from the front, for as long as the record that carries it would be more than a record holds. */
function fitted(data: Omit<ProcFinishedData, keyof ProcResult>, result: ProcResult): ProcResult {
  let tail = result.tail;
  while (tail.length > 0 && Buffer.byteLength(JSON.stringify({ ...data, ...result, tail })) > RECORD_DATA_LIMIT - RECORD_SLACK) {
    tail = tail.slice(Math.ceil(tail.length / 2));
    // A cut in the middle of a character leaves half of it.
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  }
  return { ...result, tail };
}

/** The proc module. */
export function proc(options: ProcOptions = {}): Plugin {
  const limit = wholeNumber("outputLimit", options.outputLimit, DEFAULT_OUTPUT_LIMIT, 1, Number.MAX_SAFE_INTEGER);
  const tailBytes = wholeNumber("tailBytes", options.tailBytes, DEFAULT_TAIL_BYTES, 0, MAX_TAIL_BYTES);
  const killGraceMs = wholeNumber("killGraceMs", options.killGraceMs, DEFAULT_KILL_GRACE_MS, 0, Number.MAX_SAFE_INTEGER);
  const natural = [nono(), srt()];
  // The host reads the target of a call to match its grant, then runs the action with the same
  // input object. The real path the target named is kept here, keyed by that object, so the
  // action starts the command in the directory the grant covered and in no other.
  const authorized = new WeakMap<object, string>();
  const targetOf = (input: { readonly cwd: string }): string => {
    const real = cwdTarget(input.cwd);
    authorized.set(input, real);
    return fileTarget(real);
  };

  /** The sandbox of a run: the one given, or the first of the natural ones that can run here. */
  const sandboxOf = async (): Promise<Sandbox> => {
    if (options.sandbox !== undefined) return await requireSandbox(options.sandbox);
    for (const candidate of natural) if (await candidate.available()) return candidate;
    return await requireSandbox(natural[0] as Sandbox);
  };

  return plugin("proc", (api) => {
    api.declare(ProcFinished);
    const home = () => api.home();

    const finish = async (
      ctx: ActionContext,
      data: Omit<ProcFinishedData, keyof ProcResult>,
      result: ProcResult,
    ): Promise<ProcResult> => {
      const kept = fitted(data, result);
      await ctx.emit(ProcFinished, { ...data, ...kept });
      return kept;
    };

    api.action(
      action(procRun, {
        recovery: "do-not-repeat",
        // Held in a box that writes only its directory, with no network and no credentials.
        effect: "write",
        world: "local",
        target: (input) => targetOf(input),
        async run(input, ctx) {
          const cwd = directoryOf(input.cwd, authorized.get(input));
          const sandbox = await beforeStart(sandboxOf);
          // Cancelled while the sandbox was being found: nothing was started, and nothing will be.
          ctx.signal?.throwIfAborted();
          const spec: BoxSpec = boxSpec({
            cwd,
            write: [cwd],
            net: [],
            env: { ...baseEnv(), ...input.env },
            denyRead: [
              join(home(), OWNER_TOKEN_FILE),
              join(home(), HOST_KEY_FILE),
              api.secrets.dir,
              ...CREDENTIAL_PLACES.map((place) => join(homedir(), place)),
            ],
          });
          const capture = new OutputCapture({ artifacts: api.artifacts, secrets: [], limit, tailBytes });
          try {
            const child = await beforeStart(() => sandbox.launch(spec, input.cmd, { detached: true }));
            const ended = await supervise(child, capture, { timeout: input.timeout, killGraceMs, drainMs: DRAIN_MS, signal: ctx.signal });
            const box: BoxUsed = { sandbox: sandbox.name, write: [...spec.write], net: [...spec.net] };
            const result = await finish(ctx, { action: "proc.run", cwd, program: input.cmd[0] as string, box }, { ...ended, ...capture.finish() });
            return { ...result, box };
          } catch (error) {
            capture.discard();
            throw error;
          }
        },
      }),
    );

    api.action(
      action(procExec, {
        recovery: "do-not-repeat",
        // No box, a network and secrets: nothing says what the command reaches.
        effect: "irreversible",
        world: "external",
        target: (input) => targetOf(input),
        async run(input, ctx) {
          const cwd = directoryOf(input.cwd, authorized.get(input));
          // Every secret is resolved before anything starts: one that cannot be given stops the call.
          const values: string[] = [];
          const env: Record<string, string> = { ...baseEnv() };
          const given = (name: string): string => {
            const value = api.secrets.resolve(name);
            values.push(value);
            return value;
          };
          for (const [name, value] of Object.entries(input.env ?? {})) {
            env[name] = typeof value === "string" ? value : given(value.secret);
          }
          for (const name of input.secrets ?? []) env[name] = given(name);
          const capture = new OutputCapture({ artifacts: api.artifacts, secrets: values, limit, tailBytes });
          try {
            ctx.signal?.throwIfAborted();
            const child = launchPlain(input.cmd, cwd, env);
            const ended = await supervise(child, capture, { timeout: input.timeout, killGraceMs, drainMs: DRAIN_MS, signal: ctx.signal });
            return await finish(ctx, { action: "proc.exec", cwd, program: input.cmd[0] as string }, { ...ended, ...capture.finish() });
          } catch (error) {
            capture.discard();
            throw error;
          }
        },
      }),
    );
  });
}
