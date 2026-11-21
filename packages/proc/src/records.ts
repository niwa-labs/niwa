/**
 * The records entry of the proc module: the two actions that run a command, the record that says
 * how a command ended, and the schemas they share. It needs the contracts of core, the box schemas
 * of the sandbox and zod, so a script or another plugin can name the actions.
 *
 * - `proc.run` always runs in a box: it writes its working directory and what its box takes, it
 *   has no network and no credentials. The box is what makes its class honest, so the class is
 *   `write` in `local`.
 * - `proc.exec` runs without a box, so nothing limits what it reaches. It is `irreversible` in
 *   `external`, and a grant has to name it.
 *
 * Output is never a field of a record beyond a bounded tail: the whole output is an artifact of the
 * host the record points at. A secret an environment variable takes is a reference, `secret("name")`
 * from core; the host resolves the value where the command starts, and it is never written down.
 */

import { ArtifactRefSchema, SecretName, SecretRef, actionRef, record } from "@niwa-labs/core";
import { BoxAccessSchema, BoxManifestSchema } from "@niwa-labs/sandbox";
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

/** The most bytes of output a result may carry as its tail. */
export const MAX_TAIL_BYTES = 64 * 1024;

/** The longest working directory or program a call may name: what a path may be, so the record that names them stays small. */
const MAX_NAMED = 4096;

/** The name of an environment variable (the sandbox has its own, for its spec). */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

/** The program and its arguments, as they are run. Nothing interprets them: a shell is `["sh", "-c", "…"]`. */
const Cmd = z
  .array(z.string())
  .min(1)
  .refine((argv) => argv[0] !== undefined && argv[0].length > 0, "the program must not be empty")
  .refine((argv) => argv[0] === undefined || argv[0].length <= MAX_NAMED, `the program must not be longer than ${String(MAX_NAMED)} characters`);

const Cwd = z
  .string()
  .max(MAX_NAMED, `the working directory must not be longer than ${String(MAX_NAMED)} characters`)
  .regex(/^\//, "the working directory must be an absolute path");

const Timeout = z.number().int().min(1).max(MAX_TIMEOUT_MS);

/**
 * How a command ended: it exited on its own, it was stopped for running out of time, or it was
 * stopped because the call was cancelled.
 */
export const ProcOutcome = z.enum(["exited", "timed-out", "cancelled"]);
export type ProcOutcome = z.infer<typeof ProcOutcome>;

/**
 * What a command did. A command that exits with a failure is a result, not a failed action: the
 * caller reads `exit`.
 */
export const ProcResult = z.strictObject({
  outcome: ProcOutcome,
  /** The exit code; 128 and more is a signal. Null when the command was stopped, for its time or by a cancel. */
  exit: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** The end of the output, bounded. The rest is in `output`. */
  tail: z.string(),
  /** The output was longer than what is kept: the artifact holds its start and `tail` its end. */
  truncated: z.boolean(),
  /**
   * Reading the output was given up while something the command started, outside its process group,
   * still held the pipes open: what it wrote after that is in neither `output` nor `tail`.
   */
  outputCut: z.boolean(),
  /** The output, stdout and stderr in the order they came, as an artifact of the host. */
  output: ArtifactRefSchema,
});
export type ProcResult = z.infer<typeof ProcResult>;

export const procRun = actionRef("proc.run", {
  description:
    "Run a command in a box: it writes `cwd` and a temp directory inside it, it has no network and no credentials. " +
    "`cmd` is the program and its arguments, run as they are (a shell is [\"sh\", \"-c\", \"…\"]). " +
    "`timeout` is in milliseconds; a command that runs longer is stopped, with everything it started, as is one whose call is cancelled. " +
    "`env` is the whole environment besides PATH, HOME (the user's own) and a TMPDIR (also TMP and TEMP) inside `cwd` that exists for the run and is removed after it. " +
    "`box` adds to the host's default (`allow`, by default the toolchains: the PATH, Homebrew and the catalog's programs, readable) or replaces it (`only`): a profile by its name (`bun`, `git`, `npm`, `node`, `cargo`, `uv` and the host's), `\"toolchains\"`, or a path (`{ read }`, `{ write }`). " +
    "The places of every profile the run does not take, the user's keys and niwa's own secrets are closed to it. Going beyond the default needs the caller's `box.use@<profile>`, `box.read@<path>` or `box.write@<path>` rule. " +
    "A command that needs credentials or the network is for proc.exec. " +
    "The result has the exit code, the end of the output (`tail`) and the output as an artifact, which keeps its first 16 MiB: with `truncated` the artifact holds the start and `tail` the end. " +
    "A non-zero exit is a result, not an error. A command is stopped with its process group: one that left the group is not reached. " +
    "A grant names the real path of `cwd` (`proc.run@/work/repo`); a space or another character a rule cannot hold is written as % and its hex code (`My%20Project`). " +
    "Class: write, local.",
  input: z.strictObject({
    cmd: Cmd,
    cwd: Cwd,
    timeout: Timeout,
    env: z.record(EnvName, z.string()).optional(),
    box: BoxAccessSchema.optional(),
  }),
  output: ProcResult.extend({ box: BoxManifestSchema }),
});

export const procExec = actionRef("proc.exec", {
  description:
    "Run a command with no box: nothing limits what it writes or reaches. Irreversible and external, so a grant names it. " +
    "`cmd` is the program and its arguments, run as they are; put no secret in it. " +
    "`timeout` is in milliseconds; a command that runs longer is stopped, with everything it started. " +
    "`env` values are text or a secret reference, `secret(\"name\")`; `secrets` lists secrets given to the command as variables of their own names. " +
    "The values are resolved where the command starts and are never written down; known secret values are removed from the output. " +
    "`net` says the command is meant to reach the network: it is for the owner who is asked, nothing enforces it. " +
    "The result has the exit code, the end of the output (`tail`) and the output as an artifact, which keeps its first 16 MiB: with `truncated` the artifact holds the start and `tail` the end. " +
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

/** What a rule of the box answers when it is called: the caller holds it. */
const Held = z.strictObject({ held: z.literal(true) });

export const boxUse = actionRef("box.use", {
  description:
    "A rule, not a tool: `box.use@<profile>` in a grant lets a box take that profile beyond the host's default (`proc.run`, `session.start`). " +
    "Calling it answers that the caller holds the rule for `profile`; a call the grant does not cover is refused. Class: read, local.",
  input: z.strictObject({ profile: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "a profile name") }),
  output: Held,
});

export const boxRead = actionRef("box.read", {
  description:
    "A rule, not a tool: `box.read@<path>` in a grant lets a box read that place beyond the host's default; a path a rule cannot hold is written with % and its hex code. " +
    "Calling it answers that the caller holds the rule for `path` (absolute, its real path is taken); a call the grant does not cover is refused. Class: read, local.",
  input: z.strictObject({ path: Cwd }),
  output: Held,
});

export const boxWrite = actionRef("box.write", {
  description:
    "A rule, not a tool: `box.write@<path>` in a grant lets a box write (and read) that place beyond the host's default. " +
    "Calling it answers that the caller holds the rule for `path` (absolute, its real path is taken); a call the grant does not cover is refused. Class: read, local.",
  input: z.strictObject({ path: Cwd }),
  output: Held,
});

export const boxNet = actionRef("box.net", {
  description:
    "A rule, not a tool: `box.net@<host>` in a grant lets a session's box reach that host beyond what its installation and the host's default give (a `proc.run` reaches none). " +
    "Calling it answers that the caller holds the rule for `host`; a call the grant does not cover is refused. Class: read, local.",
  input: z.strictObject({ host: z.string().regex(/^[^\s*@:{}/%]+$/, "a host") }),
  output: Held,
});

/** A command ended. Written by both actions, once the output is stored. */
export const ProcFinished = record(
  "proc.finished",
  ProcResult.extend({
    action: z.enum(["proc.run", "proc.exec"]),
    cwd: z.string(),
    /** The program, without its arguments: they may say more than a journal should keep. */
    program: z.string(),
    /** The manifest of the box of a `proc.run`; absent for `proc.exec`. */
    box: BoxManifestSchema.optional(),
  }),
);
export type ProcFinishedData = z.infer<typeof ProcFinished.schema>;

/** Every record type of the proc module. */
export const PROC_TYPES = [ProcFinished] as const;
