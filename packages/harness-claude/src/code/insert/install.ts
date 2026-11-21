/**
 * install.ts — write the Claude Code plugin that carries the insert.
 *
 * Claude Code loads a plugin from a directory that holds:
 *
 * ```
 * <dir>/niwa-insert/.claude-plugin/plugin.json   the name and the description of the plugin
 * <dir>/niwa-insert/hooks/hooks.json              the events it answers, and the commands that answer them
 * ```
 *
 * The commands run `hook.ts` of this directory where it is: nothing is copied and nothing is
 * rewritten. The script tells niwa what happened by running `niwa insert report`, so it imports
 * no client of the host. The home of the host, and the program that runs niwa's CLI when it is
 * not `niwa` on the PATH, are in the command.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NIWA_CLI_ENV } from "@niwa-labs/harness";

import { INSERT_HARNESS_ENV } from "./constants.ts";

/** The name of the plugin, as Claude Code knows it. */
export const PLUGIN_NAME = "niwa-insert";

/** The name of the directory the plugin is written into. */
export const PLUGIN_DIR_NAME = "niwa-insert";

/** What the plugin writes. */
export interface InstallOptions {
  /**
   * The home of the niwa host the hooks connect to.
   *
   * Default: the `NIWA_HOME` of the environment. Without it the hooks report nothing, and the
   * harness goes on working.
   */
  readonly home?: string;
  /** The bun that runs the hook script. Default: "bun". */
  readonly bun?: string;
  /**
   * The program that runs niwa's CLI, which the hook reports through (`niwa insert report`).
   *
   * Default: none is written, so the hook uses the `NIWA_CLI` of its environment, else `niwa`
   * from the PATH.
   */
  readonly cli?: string;
  /**
   * The id of the harness instance the plugin is installed for, which the sessions its hooks
   * report belong to. Default: none is written, and the hooks report for `claude-code`.
   */
  readonly harness?: string;
}

/**
 * The plugin manifest: the name and the description of the plugin.
 *
 * @pure
 */
export function pluginJson(): string {
  return `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      description:
        "Reports to niwa what Claude Code did inside itself: a nested session was spawned, the context was compacted, the owner opened a session by hand, or a tool asks for permission.",
    },
    null,
    2,
  )}\n`;
}

/**
 * The hooks: the events the insert answers, and the command that answers each.
 *
 * @pure
 */
export function hooksJson(bun = "bun", home?: string, cli?: string, harness?: string): string {
  const prefix =
    (home === undefined ? "" : `NIWA_HOME=${shellQuote(home)} `) +
    (cli === undefined ? "" : `${NIWA_CLI_ENV}=${shellQuote(cli)} `) +
    (harness === undefined ? "" : `${INSERT_HARNESS_ENV}=${shellQuote(harness)} `);
  const command = `${prefix}${shellQuote(bun)} ${shellQuote(hookPath())}`;
  const handler = { type: "command", command, timeout: 10 };
  return `${JSON.stringify(
    {
      description:
        "Tells niwa what happened inside Claude Code: a session opened by hand, a nested session, a compaction, a permission question.",
      hooks: {
        SessionStart: [{ hooks: [handler] }],
        SubagentStart: [{ hooks: [handler] }],
        PreCompact: [{ hooks: [handler] }],
        PermissionRequest: [{ hooks: [handler] }],
      },
    },
    null,
    2,
  )}\n`;
}

/** A word for sh, safe against spaces, `$` and quotes. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The script the hooks run: the one next to this file. */
export function hookPath(): string {
  return join(import.meta.dir, "hook.ts");
}

/**
 * Write the plugin into a directory.
 *
 * The files are the manifest and the hooks. The directory the plugin was written into is returned,
 * so the caller can put it on the `--plugin-dir` list.
 */
export async function installClaudeCodeInsert(
  dir: string,
  options: InstallOptions = {},
): Promise<string> {
  const root = join(dir, PLUGIN_DIR_NAME);
  const hooksDir = join(root, "hooks");
  await mkdir(hooksDir, { recursive: true });
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  const home = options.home ?? process.env.NIWA_HOME;
  await writeFile(join(root, ".claude-plugin", "plugin.json"), pluginJson(), "utf8");
  await writeFile(join(hooksDir, "hooks.json"), hooksJson(options.bun ?? "bun", home, options.cli, options.harness), "utf8");
  return root;
}
