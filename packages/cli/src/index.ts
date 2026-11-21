/**
 * index.ts — the commands of the CLI, generated from the list of actions.
 *
 * The list of actions is the single source for three things: the MCP tools an agent sees, the
 * commands of the CLI, and niwa's self-description. This module
 * keeps no list of its own: the commands are built from what `describe()` says, every time the
 * CLI runs.
 *
 * So a plugin that declares a new action has a command at once, with no change here.
 *
 * The command of an action is its own name:
 *
 *     niwa telegram.send --chat 42 --text "hello"
 *     niwa telegram.send --json '{"chat": 42, "text": "hello"}'
 *
 * The fields and their types come from the action's input schema.
 *
 * The caller is bound by the transport, never by an argument: the CLI connects with its own id,
 * and the host names the caller from the connection.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  connect,
  livingHolderPid,
  DescriptionOutput,
  RecordList,
  RecordsOutput,
  STATUS_ACTION,
  STOP_ACTION,
  StatusOutput,
  TracedRecordsOutput,
  withWorkingDirectory,
} from "@niwa-labs/client";
import type { ActionDescription, Seq, Token } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";
import { LOG_USAGE, LogUsage, log } from "./log.ts";
import { SKILL_USAGE } from "./skill/command.ts";
import {
  fieldsOf,
  recordLine,
  renderDescription,
  renderRecords,
  renderStatus,
  renderTrace,
  renderValue,
  type Format,
} from "./render.ts";

export { INSERT_REPORT, INSERT_USAGE, runInsert } from "./insert.ts";
export { log } from "./log.ts";
export { logLine } from "./render.ts";
export { installedText, skillText } from "./skill/install.ts";
export { SKILL_USAGE, runSkill } from "./skill/command.ts";
export type { SkillContext, SkillKind, SkillRoots } from "./skill/command.ts";

/** What one run of the CLI did. */
export interface CliResult {
  /** The text to print: what a person reads, or what a machine reads under `--json`. */
  readonly output: string;
  /** The exit code: zero when the command did what it was asked. */
  readonly code: number;
  /** The code of the error the host refused with, when it refused. */
  readonly errorCode?: string;
}

/**
 * The commands the CLI answers itself: the ones that are about the CLI, not about the host.
 *
 * Every other command is an action the host declares, and the observation actions of the core
 * are actions like any other: `niwa records.read`, `niwa trace` and `niwa causes` are commands
 * because the host declares them, not because the CLI knows them.
 *
 * `log` is the one that is about the CLI: it is `niwa.records.search` shown the way a person reads a log,
 * and followed by reading again.
 */
const BUILTIN = ["serve", "help", "log"] as const;

/** One builtin command. */
export type Builtin = (typeof BUILTIN)[number];

/** The arguments of one run of the CLI. */
export interface CliArgs {
  /** The home of the host: from `--home`, from `NIWA_HOME`, or `~/.niwa`. */
  readonly home: string;
  /** The command: an action name, or a builtin. */
  readonly command: string;
  /** The rest of the command line: the fields of the action, or the options of the builtin. */
  readonly args: string[];
  /** True when the machine form was asked for. */
  readonly json: boolean;
  /** Who the CLI is: `NIWA_ID` when the command runs in a session, else the owner's own token. */
  readonly token?: Token;
}

/**
 * The home of the host: `--home`, else `NIWA_HOME`, else `~/.niwa`.
 *
 * The order is the one a person expects: what was said, then the environment, then the place
 * niwa keeps its home by default.
 */
export function homeOf(argv: string[], env: Record<string, string | undefined>): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--home") {
      const value = argv[index + 1];
      if (value !== undefined) return value;
    }
    if (argument?.startsWith("--home=")) {
      return argument.slice("--home=".length);
    }
  }
  const fromEnv = env["NIWA_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".niwa");
}

/**
 * The input of an action, from the command line.
 *
 * `--field value` is read in the type the schema gives the field (number, integer, boolean,
 * array, object; a string otherwise), and every flag names the field of the same name, so an action
 * with a field called `input` takes `--input`. `--json '{...}'` gives the whole input at once;
 * fields named after it win over it. (`--json -` reads the JSON from stdin: see `withStdinJson`.)
 */
export function inputOf(action: ActionDescription, args: string[]): Record<string, unknown> {
  const properties = (action.input as { properties?: Record<string, unknown> }).properties;
  const input: Record<string, unknown> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      const text = args[index + 1];
      if (text === undefined) throw new CliError("--json needs the JSON as its next argument");
      const parsed = parseJson(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("--json must hold an object");
      }
      Object.assign(input, parsed);
      index += 1;
      continue;
    }
    if (argument === undefined || !argument.startsWith("--")) {
      throw new CliError(`unexpected argument "${String(argument)}"`);
    }
    const written = argument.slice(2);
    // `--timeout-ms` is the field `timeoutMs`: the dashed form is the one a command line reads in.
    const name = properties !== undefined && !Object.hasOwn(properties, written) ? camelCase(written) : written;
    if (properties !== undefined && !Object.hasOwn(properties, name)) {
      const hint = written === "input" ? " (the whole input as JSON is --json)" : "";
      throw new CliError(
        `${action.name} has no field "${written}"${hint}; its fields are: ${Object.keys(properties).join(", ")}`,
      );
    }
    const value = args[index + 1];
    // A flag (a boolean field) with no value after it is true: `--wait`.
    if (typesOf(properties?.[name]).includes("boolean") && (value === undefined || value.startsWith("--"))) {
      Object.defineProperty(input, name, { value: true, enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (value === undefined) throw new CliError(`--${name} needs a value`);
    index += 1;
    Object.defineProperty(input, name, {
      value: typedValue(properties?.[name], value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return input;
}

/** The arguments with `--json -` replaced by the JSON read from stdin. */
export async function withStdinJson(args: string[], readStdin: () => Promise<string>): Promise<string[]> {
  const at = args.findIndex((argument, index) => argument === "--json" && args[index + 1] === "-");
  if (at < 0) return args;
  const copy = [...args];
  copy[at + 1] = await readStdin();
  return copy;
}

/** `timeout-ms` as `timeoutMs`. */
function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** The JSON of the command line, or a CliError that says what was wrong. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`"${text}" is not valid JSON`);
  }
}

/** The types a field may have, from its schema: `type`, or the branches of `anyOf`/`oneOf`. */
function typesOf(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const holder = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (typeof holder.type === "string") return [holder.type];
  if (Array.isArray(holder.type)) return holder.type.filter((t): t is string => typeof t === "string");
  const branches = [holder.anyOf, holder.oneOf].flatMap((b) => (Array.isArray(b) ? b : []));
  return branches.flatMap(typesOf);
}

/** A value read from the command line, in the type the schema says. */
function typedValue(schema: unknown, text: string): unknown {
  const types = typesOf(schema);
  if (types.includes("string")) return text;
  // A field of any type takes JSON when the text is JSON (an object, a list, a number), else the text.
  if (types.length === 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (types.includes("integer") || types.includes("number")) {
    const parsed = Number(text);
    const whole = types.includes("integer") && !types.includes("number");
    if (text.trim() === "" || !Number.isFinite(parsed) || (whole && !Number.isInteger(parsed))) {
      throw new CliError(`"${text}" is not ${whole ? "an integer" : "a number"}`);
    }
    return parsed;
  }
  if (types.includes("boolean")) {
    if (text === "true") return true;
    if (text === "false") return false;
    throw new CliError(`"${text}" is not a boolean (true or false)`);
  }
  if (types.includes("null") && text === "null") return null;
  return parseJson(text);
}

/** The name the CLI gives itself. Who it is comes from its token, not from this. */
const CLI_CLIENT_ID = "cli";

/** A failure of the CLI itself: the command line was wrong, or the host was not there. */
export class CliError extends Error {
  override name = "CliError";
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * Run one command of the CLI.
 *
 * The host is asked what it is, and the command is chosen from that answer: an action name is
 * an action, anything else is a builtin. Nothing here knows the names of the actions.
 *
 * `out` is where the command writes what it prints while it runs: the log prints its records
 * as they come, and the other commands answer at once.
 */
export async function run(args: CliArgs, out: (text: string) => void): Promise<CliResult> {
  const format: Format = args.json ? "json" : "text";
  let api: NiwaApi;
  try {
    api = await connect({ home: args.home, id: CLI_CLIENT_ID, ...(args.token === undefined ? {} : { token: args.token }) });
  } catch (error) {
    if (!isHostDown(error)) throw error;
    return { output: `no host is serving ${args.home} (start it with "niwa serve <composition>")`, code: HOST_DOWN };
  }
  try {
    if (isBuiltin(args.command)) {
      return await runBuiltin(api, args, out);
    }
    const description = await api.describe();
    const wanted = COMMAND_ALIASES[args.command] ?? args.command;
    const action = description.actions.find((entry) => entry.name === wanted);
    if (action === undefined) {
      throw new CliError(
        `there is no action "${args.command}" and no such command. ` +
          `Run "niwa help" to see what there is.`,
      );
    }
    const result = await runAction(api, action, args, format);
    if (action.name !== STOP_ACTION) return result;
    // The host answers before it closes: the command ends when the journal is free again.
    if (!(await untilDown(args))) {
      return { output: `the host did not stop within ${String(STOP_WAIT_MS / 1000)} s`, code: STOP_TIMEOUT };
    }
    return format === "json" ? result : { output: "stopped", code: 0 };
  } catch (error) {
    if (error instanceof CliError) {
      return { output: error.message, code: 1, errorCode: error.code };
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    return { output: message, code: 1, errorCode: code };
  } finally {
    await api.close().catch(() => undefined);
  }
}

/** The short commands of the actions a person types most. */
const COMMAND_ALIASES: Record<string, string> = { status: STATUS_ACTION, stop: STOP_ACTION };

/** How long `niwa stop` waits for the host to give the journal back. */
const STOP_WAIT_MS = 30_000;

/** The exit code of a `niwa stop` whose host did not stop in time. */
export const STOP_TIMEOUT = 4;

/** Wait until the host that was asked to stop has let go of the journal; false when it did not in time. */
async function untilDown(args: CliArgs): Promise<boolean> {
  const deadline = Date.now() + STOP_WAIT_MS;
  while (livingHolderPid(args.home) !== undefined) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(100);
  }
  return true;
}

/** The exit code of a command that found no host: apart from 1, a command the host refused. */
export const HOST_DOWN = 3;

/** Did the connection fail because nothing listens at the home: no socket, or one nobody holds? */
function isHostDown(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** True for the names the CLI itself answers. */
function isBuiltin(command: string): command is Builtin {
  return (BUILTIN as readonly string[]).includes(command);
}

/**
 * Run one action of the host as a command.
 *
 * The fields come from the action's schema, so the CLI knows nothing about the action. What the
 * action answers with is printed as it is, unless the answer is a list of records: those are
 * printed the way a person reads records.
 */
async function runAction(
  api: NiwaApi,
  action: ActionDescription,
  args: CliArgs,
  format: Format,
): Promise<CliResult> {
  const input = withWorkingDirectory(action.input, inputOf(action, await withStdinJson(args.args, () => Bun.stdin.text())));
  const result = await api.call(action.name, input);
  return { output: renderAnswer(result, format), code: 0 };
}

/**
 * What an action answered with, as it is printed.
 *
 * A list of records is printed the way a person reads records; a list of traced records is
 * printed with the depth each was found at. A description is printed as the list of actions and
 * record types it is. Anything else is printed as the value it is, so the machine form is the
 * value itself.
 */
export function renderAnswer(value: unknown, format: Format): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  const description = DescriptionOutput.safeParse(value);
  if (description.success) return renderDescription(description.data);
  const status = StatusOutput.safeParse(value);
  if (status.success) return renderStatus(status.data);
  const read = RecordsOutput.safeParse(value);
  if (read.success) return `${renderRecords(read.data.records)}\nnext: ${String(read.data.next)}`;
  const trace = TracedRecordsOutput.safeParse(value);
  if (trace.success) return renderTrace(trace.data);
  const records = RecordList.safeParse(value);
  if (records.success) return renderRecords(records.data);
  return renderValue(value, format);
}

/** Run one of the built-in commands. */
async function runBuiltin(
  api: NiwaApi,
  args: CliArgs,
  out: (text: string) => void,
): Promise<CliResult> {
  switch (args.command) {
    case "help": {
      return { output: await usage(api), code: 0 };
    }
    case "log": {
      try {
        await log(api, args.args, args.json, process.stdout.columns ?? 160, out);
      } catch (error) {
        if (error instanceof LogUsage) throw new CliError(error.message);
        throw error;
      }
      return { output: "", code: 0 };
    }
    default:
      throw new CliError(`there is no command "${args.command}"`);
  }
}

/**
 * What the CLI says when it is asked what it can do.
 *
 * The commands are the actions the host declares, so the list is read from the host: the CLI
 * keeps no list of its own. Without a host there is no list to show, and the usage says so.
 */
export async function usage(api?: NiwaApi): Promise<string> {
  const description = api === undefined ? undefined : await api.describe();
  const commands =
    description === undefined
      ? [
          `  ${LOG_USAGE}`,
          `  ${SKILL_USAGE}`,
          "  niwa help                       what niwa is: its actions and its record types",
        ]
      : [
          ...description.actions.map((action) => `  ${commandLine(action)}`),
          "  niwa status                      whether the host is up, and what its plugins hold",
          "  niwa stop                        stop the host gracefully",
          "  niwa web [--port N]              the web cockpit of the host: prints its address and login link",
          "  niwa mcp                         the MCP server of the host, over stdio",
          "  niwa serve [-d] <composition.ts> run a host from a file that exports plugins; -d in the background",
          `  ${LOG_USAGE}`,
          `  ${SKILL_USAGE}`,
          "  niwa help                       what niwa is: its actions and its record types",
        ];
  return [
    "usage: niwa [--home <dir>] <command> [--field value ...]",
    "",
    description === undefined
      ? "No host answers at this home, so its actions are not listed. The commands niwa has of its own:"
      : "The commands are the actions the host declares:",
    "",
    ...commands,
    "",
    "The home of the host: --home, else NIWA_HOME, else ~/.niwa.",
    "--json, before the command, asks for the machine form.",
    "--field value gives one field of the action; after the command, --json '{...}' (or --json - for stdin)",
    "gives the whole input as JSON.",
    "workflow.start runs a script now; workflow.install subscribes one: niwa then starts a run for every matching record.",
  ].join("\n");
}

/** The usage for a run with no command: the host's own list when a host answers, else the part niwa knows. */
export async function usageAt(home: string, token?: Token): Promise<string> {
  try {
    const api = await connect({ home, id: CLI_CLIENT_ID, ...(token === undefined ? {} : { token }) });
    try {
      return await usage(api);
    } finally {
      await api.close().catch(() => undefined);
    }
  } catch {
    return usage();
  }
}

/**
 * One command, as a person reads it: the action, and the fields it takes.
 *
 * The fields come from the action's own schema, so the line is true whatever the action is.
 */
function commandLine(action: ActionDescription): string {
  const fields = fieldsOf(action.input);
  const shown = fields.length === 0 ? "" : ` --${fields.join(" --")}`;
  return `${action.name}${shown}`;
}

