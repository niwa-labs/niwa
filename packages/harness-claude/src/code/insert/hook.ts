/**
 * hook.ts — the hook script inside Claude Code.
 *
 * Claude Code runs this with the event's JSON on stdin. The script reads it, works out what
 * happened, and tells niwa by running `niwa insert report` with the event on stdin.
 *
 * It is no client of the host: the command is. It never writes to the journal itself.
 *
 * The hooks file that `installClaudeCodeInsert` writes runs this file where it is, and puts the
 * home of the host in `NIWA_HOME` and, when it is given, the program that runs niwa's CLI in
 * `NIWA_CLI`. Both come from the command that runs it, so the plugin works wherever it is put.
 *
 * The events it answers:
 *
 * - `SessionStart` — a session began. When it was not started by niwa, the session is registered
 *   at once with its exact id: niwa-started sessions carry the marker in the environment, and
 *   those are niwa's own business.
 * - `SubagentStart` — a subagent was spawned inside a session: the child is linked to its parent.
 * - `PreCompact` — the harness is about to compact the context.
 * - `PermissionRequest` — a tool asks for permission.
 * - `SessionEnd` — the session ended: the owner left it or cleared it.
 *
 * The script always exits 0, within `DEADLINE_MS`: a hook never blocks or crashes the harness.
 * What it could not report goes to stderr.
 */

import { NIWA_SESSION_ENV, reportThroughCli } from "@niwa-labs/harness";
import { nativeIdOfSubagent } from "../paths.ts";
import { CLAUDE_CODE_HARNESS, INSERT_HARNESS_ENV } from "./constants.ts";

/** The event Claude Code fired. */
export interface HookInput {
  /** The name of the event. */
  readonly hook_event_name?: string;
  /** The id of the session the event happened in. */
  readonly session_id?: string;
  /** The working directory the session runs in. */
  readonly cwd?: string;
  /** How the session started: "startup", "resume", "clear", "compact", "fork". */
  readonly source?: string;
  /** The id of the subagent, for a spawn. */
  readonly agent_id?: string;
  /** The name of the subagent, for a spawn. */
  readonly agent_type?: string;
  /** The tool that asks, for a permission. */
  readonly tool_name?: string;
  /** What the tool wants to do. */
  readonly tool_input?: unknown;
  /** The id of the tool call, when the harness gives one. */
  readonly tool_use_id?: string;
  /** What triggered a compaction: "manual" or "auto". */
  readonly trigger?: string;
  /** Why a session ended: "clear", "logout", "prompt_input_exit", "other". */
  readonly reason?: string;
}

/** What the script reports to niwa. */
export type Report =
  | {
      readonly kind: "nested-spawned";
      readonly parent: { readonly harness: string; readonly native: string };
      readonly child: { readonly harness: string; readonly native: string };
      readonly role?: string;
    }
  | {
      readonly kind: "compacted";
      readonly session: { readonly harness: string; readonly native: string };
      readonly summary?: string;
    }
  | {
      readonly kind: "opened-by-hand";
      readonly session: { readonly harness: string; readonly native: string };
      readonly cwd?: string;
    }
  | {
      readonly kind: "permission-asked";
      readonly session: { readonly harness: string; readonly native: string };
      readonly requestId: string;
      readonly tool: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "session-ended";
      readonly session: { readonly harness: string; readonly native: string };
      readonly reason?: string;
    };

/**
 * The session of the harness, as niwa names it: of the instance the plugin was installed for,
 * else of `claude-code`.
 */
function sessionOf(env: NodeJS.ProcessEnv, native: string): { harness: string; native: string } {
  const instance = env[INSERT_HARNESS_ENV];
  return { harness: instance === undefined || instance === "" ? CLAUDE_CODE_HARNESS : instance, native };
}

/**
 * What the event means, in niwa's words.
 *
 * `null` — the event is not one the insert answers, or it does not carry what niwa needs.
 */
export function reportOf(input: HookInput, env: NodeJS.ProcessEnv): Report | null {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;

  switch (input.hook_event_name) {
    case "SessionStart": {
      // A session niwa started is niwa's own business: it knows the id and it started it.
      if (env[NIWA_SESSION_ENV] !== undefined) return null;
      // A session that was resumed or compacted is not opened by hand either: the owner did not
      // open it, the harness continued it.
      if (input.source === "resume" || input.source === "compact") return null;
      return {
        kind: "opened-by-hand",
        session: sessionOf(env, sessionId),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      };
    }
    case "SubagentStart": {
      const childId = input.agent_id;
      if (childId === undefined || childId.length === 0) return null;
      return {
        kind: "nested-spawned",
        parent: sessionOf(env, sessionId),
        // The reading side names a subagent by its log, so the child is named the same way.
        child: sessionOf(env, nativeIdOfSubagent(childId)),
        ...(input.agent_type === undefined ? {} : { role: input.agent_type }),
      };
    }
    case "PreCompact": {
      return { kind: "compacted", session: sessionOf(env, sessionId) };
    }
    case "PermissionRequest": {
      const tool = input.tool_name;
      if (tool === undefined || tool.length === 0) return null;
      const detail = detailOf(input.tool_input);
      return {
        kind: "permission-asked",
        session: sessionOf(env, sessionId),
        requestId: input.tool_use_id ?? `${sessionId}:${tool}`,
        tool,
        ...(detail === undefined ? {} : { detail }),
      };
    }
    case "SessionEnd": {
      return {
        kind: "session-ended",
        session: sessionOf(env, sessionId),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
    }
    default:
      return null;
  }
}

/** What the tool wants to do, in the harness's own words. */
function detailOf(toolInput: unknown): string | undefined {
  if (toolInput === null || typeof toolInput !== "object") return undefined;
  const input = toolInput as Record<string, unknown>;
  for (const key of ["command", "description", "file_path", "path", "pattern", "url", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Tell niwa what happened.
 *
 * `false` — the report could not be delivered: the host was not running, or it refused the call.
 * The hook never fails the harness over it.
 */
export async function report(value: Report, home: string): Promise<boolean> {
  try {
    await reportThroughCli(value, { home });
    return true;
  } catch (error) {
    process.stderr.write(`niwa insert: could not report ${value.kind}: ${String(error)}\n`);
    return false;
  }
}

/** The longest the script may run; Claude Code's own timeout for the hook is longer. */
const DEADLINE_MS = 5_000;

/**
 * Read the event from stdin, work out what it means, and report it.
 *
 * Never throws and never outlives `DEADLINE_MS`: a missing home, bad input, a host that is down or
 * does not answer all end quietly.
 */
export async function main(): Promise<void> {
  const home = process.env.NIWA_HOME;
  if (home === undefined || home.length === 0) return;
  const work = (async () => {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const value = reportOf(input, process.env);
    if (value !== null) await report(value, home);
  })().catch((error) => {
    process.stderr.write(`niwa insert: ${String(error)}\n`);
  });
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, DEADLINE_MS))]);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
