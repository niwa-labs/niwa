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

import { HOST_KEY_FILE, OWNER_TOKEN_FILE, action } from "@niwa-labs/core";
import type { ActionContext } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { boxSpec, nono, requireSandbox, srt } from "@niwa-labs/sandbox";
import type { BoxSpec, Sandbox } from "@niwa-labs/sandbox";

import { OutputCapture } from "./artifact.ts";
import { ProcRefusal } from "./refusal.ts";
import { ProcFinished, fileTarget, procExec, procRun } from "./records.ts";
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
  /** The bytes of the end of the output a result carries. Default: 4 KiB. */
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

/** The proc module. */
export function proc(options: ProcOptions = {}): Plugin {
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
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
    ): Promise<void> => {
      await ctx.emit(ProcFinished, { ...data, ...result });
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
          const sandbox = await sandboxOf();
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
            const child = await sandbox.launch(spec, input.cmd, { detached: true });
            const ended = await supervise(child, capture, { timeout: input.timeout, killGraceMs, drainMs: DRAIN_MS });
            const result: ProcResult = { ...ended, ...capture.finish() };
            const box: BoxUsed = { sandbox: sandbox.name, write: [...spec.write], net: [...spec.net] };
            await finish(ctx, { action: "proc.run", cwd, program: input.cmd[0] as string, box }, result);
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
            const child = launchPlain(input.cmd, cwd, env);
            const ended = await supervise(child, capture, { timeout: input.timeout, killGraceMs, drainMs: DRAIN_MS });
            const result: ProcResult = { ...ended, ...capture.finish() };
            await finish(ctx, { action: "proc.exec", cwd, program: input.cmd[0] as string }, result);
            return result;
          } catch (error) {
            capture.discard();
            throw error;
          }
        },
      }),
    );
  });
}
