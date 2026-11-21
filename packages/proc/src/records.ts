/**
 * The records entry of the proc module: the two actions that run a command, the record that says
 * how a command ended, and the schemas they share. It needs the contracts of core and zod only,
 * so a script or another plugin can name the actions without the sandbox behind them.
 *
 * - `proc.run` always runs in a box: it may write only in its working directory, it has no network
 *   and no credentials. The box is what makes its class honest, so the class is `write` in `local`.
 * - `proc.exec` runs without a box, so nothing limits what it reaches. It is `irreversible` in
 *   `external`, and a grant has to name it.
 *
 * Output is never a field of a record beyond a bounded tail: the whole output is an artifact of the
 * host the record points at. A secret an environment variable takes is a reference, `secret("name")`
 * from core; the host resolves the value where the command starts, and it is never written down.
 */

import { ArtifactRefSchema, SecretName, SecretRef, actionRef, record } from "@niwa-labs/core";
import { z } from "zod";

/**
 * An absolute path as the target of a call, the form a rule names: a segment of a target holds no
 * whitespace, `*`, `@`, `:` or brace, so each such character, and `%`, is written as `%` and its
 * hex code (the bytes of its UTF-8, for one that has more than one). A path of plain segments is
 * its own target, so a rule written for it stays valid; one with a space is named as
 * `/work/My%20Project`. `%` is encoded too, so two paths never share a target.
 */
export function fileTarget(path: string): string {
  const escaped = (char: string): string =>
    [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  return path.replace(/[\s*@:{}%]/g, escaped);
}

/** The most a command may be given to finish, in milliseconds: an hour. */
export const MAX_TIMEOUT_MS = 3_600_000;

/** The name of an environment variable (the sandbox has its own, for its spec). */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

/** The program and its arguments, as they are run. Nothing interprets them: a shell is `["sh", "-c", "…"]`. */
const Cmd = z
  .array(z.string())
  .min(1)
  .refine((argv) => argv[0] !== undefined && argv[0].length > 0, "the program must not be empty");

const Cwd = z.string().regex(/^\//, "the working directory must be an absolute path");

const Timeout = z.number().int().min(1).max(MAX_TIMEOUT_MS);

/** How a command ended: it exited on its own, or it was stopped for running out of time. */
export const ProcOutcome = z.enum(["exited", "timed-out"]);
export type ProcOutcome = z.infer<typeof ProcOutcome>;

/**
 * What a command did. A command that exits with a failure is a result, not a failed action: the
 * caller reads `exit`.
 */
export const ProcResult = z.strictObject({
  outcome: ProcOutcome,
  /** The exit code; 128 and more is a signal. Null when the command was stopped for its time. */
  exit: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** The end of the output, bounded. The rest is in `output`. */
  tail: z.string(),
  /** The output was longer than what is kept: the artifact holds its start. */
  truncated: z.boolean(),
  /** The output, stdout and stderr in the order they came, as an artifact of the host. */
  output: ArtifactRefSchema,
});
export type ProcResult = z.infer<typeof ProcResult>;

/** What a command ran in: the sandbox and what it let through. */
export const BoxUsed = z.strictObject({
  sandbox: z.string(),
  write: z.array(z.string()),
  net: z.array(z.string()),
});
export type BoxUsed = z.infer<typeof BoxUsed>;

export const procRun = actionRef("proc.run", {
  description:
    "Run a command in a box: it may write only in `cwd`, it has no network and no credentials. " +
    "`cmd` is the program and its arguments, run as they are (a shell is [\"sh\", \"-c\", \"…\"]). " +
    "`timeout` is in milliseconds; a command that runs longer is stopped, with everything it started. " +
    "`env` is the whole environment besides PATH and HOME. " +
    "The result has the exit code, the end of the output and the whole output as an artifact; a non-zero exit is a result, not an error. " +
    "A grant names the real path of `cwd` (`proc.run@/work/repo`); a space or another character a rule cannot hold is written as % and its hex code (`My%20Project`). " +
    "Class: write, local.",
  input: z.strictObject({
    cmd: Cmd,
    cwd: Cwd,
    timeout: Timeout,
    env: z.record(EnvName, z.string()).optional(),
  }),
  output: ProcResult.extend({ box: BoxUsed }),
});

export const procExec = actionRef("proc.exec", {
  description:
    "Run a command with no box: nothing limits what it writes or reaches. Irreversible and external, so a grant names it. " +
    "`cmd` is the program and its arguments, run as they are; put no secret in it. " +
    "`timeout` is in milliseconds; a command that runs longer is stopped, with everything it started. " +
    "`env` values are text or a secret reference, `secret(\"name\")`; `secrets` lists secrets given to the command as variables of their own names. " +
    "The values are resolved where the command starts and are never written down; known secret values are removed from the output. " +
    "`net` says the command is meant to reach the network: it is for the owner who is asked, nothing enforces it. " +
    "The result has the exit code, the end of the output and the whole output as an artifact. " +
    "A grant names the real path of `cwd` as `proc.exec@/work/repo`, with a space or another character a rule cannot hold written as % and its hex code. Class: irreversible, external.",
  input: z.strictObject({
    cmd: Cmd,
    cwd: Cwd,
    timeout: Timeout,
    env: z.record(EnvName, z.union([z.string(), SecretRef])).optional(),
    net: z.boolean().optional(),
    secrets: z.array(SecretName).optional(),
  }),
  output: ProcResult,
});

/** A command ended. Written by both actions, once the output is stored. */
export const ProcFinished = record(
  "proc.finished",
  ProcResult.extend({
    action: z.enum(["proc.run", "proc.exec"]),
    cwd: z.string(),
    /** The program, without its arguments: they may say more than a journal should keep. */
    program: z.string(),
    /** The box of a `proc.run`; absent for `proc.exec`. */
    box: BoxUsed.optional(),
  }),
);
export type ProcFinishedData = z.infer<typeof ProcFinished.schema>;

/** Every record type of the proc module. */
export const PROC_TYPES = [ProcFinished] as const;
