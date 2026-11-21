/**
 * `niwa agent attach [<agent>]`: attach the native session this command runs in to an agent.
 *
 * The agent of a native session runs the command from its own shell, so the harness and the session are
 * read from the environment the harness gives its tools. ZCode is asked first: it sets the variables of
 * Claude Code as well as its own. mcode names no session in the environment: the command takes
 * `--session <id>`, or the latest mcode session of the directory once it is confirmed. A command that can
 * tell no session is refused, saying what it looked for.
 *
 * The CLI runs as the owner here (a native session is not a session niwa started), so the attachment is
 * the owner's act. The answer is the agent's briefing.
 */

import { actionName } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

/** The usage of the command. */
export const AGENT_USAGE = "niwa agent attach [<agent>] [--session <id>] [--kind <kind>] [--harness <name>] [--yes]";

/** The variables a harness names its session by, in the order they are asked. */
const SESSION_VARIABLES = [
  { variable: "ZCODE_SESSION_ID", kind: "zcode" },
  { variable: "CODEX_THREAD_ID", kind: "codex" },
  { variable: "PI_SESSION_ID", kind: "pi" },
  { variable: "CLAUDE_CODE_SESSION_ID", kind: "claude-code" },
] as const;

/** The session a command runs in, as its environment names it. */
export interface CallerSession {
  /** The kind of harness. */
  readonly kind: string;
  /** The harness's own id of the session. */
  readonly native: string;
  /** The variable it was read from. */
  readonly from: string;
  /** The process of the harness, when the environment names it. */
  readonly pid?: number;
}

/** The session the environment names, or nothing when it names none. */
export function callerSession(env: Readonly<Record<string, string | undefined>>): CallerSession | undefined {
  for (const { variable, kind } of SESSION_VARIABLES) {
    const native = env[variable]?.trim();
    if (native === undefined || native === "") continue;
    const pid = kind === "claude-code" ? Number(env.CLAUDE_PID) : Number.NaN;
    return { kind, native, from: variable, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
  }
  return undefined;
}

/** What the command reads besides its arguments. */
export interface AgentCommandContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/** What the command did: the text to print, or the reason it was refused. */
export type AgentCommandResult = { readonly ok: true; readonly answer: { briefing: string } & Record<string, unknown> } | { readonly ok: false; readonly reason: string };

interface Parsed {
  agent?: string;
  session?: string;
  kind?: string;
  harness?: string;
  yes: boolean;
}

function parse(args: readonly string[]): Parsed | string {
  const parsed: Parsed = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--yes") parsed.yes = true;
    else if (argument === "--session" || argument === "--kind" || argument === "--harness") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${argument} needs a value`;
      if (argument === "--session") parsed.session = value;
      else if (argument === "--kind") parsed.kind = value;
      else parsed.harness = value;
      index += 1;
    } else if (argument.startsWith("--")) return `unknown option ${argument}`;
    else if (parsed.agent === undefined) parsed.agent = argument;
    else return `one agent at most, not "${parsed.agent}" and "${argument}"`;
  }
  return parsed;
}

/** The kind of harness whose sessions name no id in the environment, and are found by their directory. */
const MCODE = "mcode";

/** The latest mcode session of a directory, as the host lists it. */
async function latestMcode(api: NiwaApi, cwd: string): Promise<{ native: string; title?: string } | undefined> {
  const { items } = (await api.call(actionName("harness.list"), {})) as { items: { name: string; kind: string }[] };
  for (const item of items.filter((one) => one.kind === MCODE)) {
    const { sessions } = (await api.call(actionName("session.list"), { harness: item.name, cwd, limit: 1 })) as { sessions: { ref: string; title?: string }[] };
    const [latest] = sessions;
    if (latest !== undefined) return { native: latest.ref.slice(latest.ref.indexOf(" ") + 1), ...(latest.title === undefined ? {} : { title: latest.title }) };
  }
  return undefined;
}

/** Run `niwa agent <subcommand>`. */
export async function runAgentCommand(api: NiwaApi, args: readonly string[], context: AgentCommandContext): Promise<AgentCommandResult> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "attach") return { ok: false, reason: `usage: ${AGENT_USAGE}` };
  const parsed = parse(rest);
  if (typeof parsed === "string") return { ok: false, reason: `${parsed}\nusage: ${AGENT_USAGE}` };

  const found = callerSession(context.env);
  let session: { kind: string; native: string; pid?: number };
  if (parsed.session !== undefined) {
    session = { kind: parsed.kind ?? found?.kind ?? MCODE, native: parsed.session };
  } else if (found !== undefined) {
    session = { kind: parsed.kind ?? found.kind, native: found.native, ...(found.pid === undefined ? {} : { pid: found.pid }) };
  } else {
    const latest = await latestMcode(api, context.cwd);
    if (latest === undefined) {
      return {
        ok: false,
        reason: [
          "this command cannot tell which session it runs in:",
          `none of ${SESSION_VARIABLES.map((one) => one.variable).join(", ")} is set, and no mcode session works in ${context.cwd}.`,
          "Run it from the native session, or name the session with --session <id> (and its harness with --kind <kind>).",
        ].join(" "),
      };
    }
    if (!parsed.yes) {
      return {
        ok: false,
        reason: `mcode names no session to its tools; the latest mcode session in ${context.cwd} is mcode ${latest.native}${latest.title === undefined ? "" : ` (${latest.title})`}. Attach it with --yes, or name another with --session <id>.`,
      };
    }
    session = { kind: MCODE, native: latest.native };
  }

  const answer = (await api.call(actionName("agent.attach"), {
    ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    // The installation, when the host has several of the kind: the kind alone is refused then.
    ...(parsed.harness === undefined ? { kind: session.kind } : { harness: parsed.harness }),
    native: session.native,
    cwd: context.cwd,
    ...(session.pid === undefined ? {} : { pid: session.pid }),
  })) as { briefing: string } & Record<string, unknown>;
  return { ok: true, answer };
}
