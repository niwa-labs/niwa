/** What Claude Code needs inside a box, shared by its ACP and SDK harnesses. */

import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";

import { homePath } from "@niwa-labs/sandbox";
import type { HarnessNeeds } from "@niwa-labs/sandbox";

/** The directory Claude Code keeps its files in when nothing says otherwise. */
const DEFAULT_HOME = homePath(".claude");

/** The variable that tells Claude Code where its directory is. */
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/**
 * Its own directory and the endpoint of its model: the directory of the installation the instance
 * is bound to (`~/.claude` by default). Only directories: nono takes a file by another flag, so a
 * file such as `~/.claude.json` is for the grant's spec to name.
 */
export function claudeNeeds(home: string | undefined): HarnessNeeds {
  return { write: [home ?? DEFAULT_HOME], net: ["api.anthropic.com"] };
}

/**
 * The environment that binds a Claude Code process to the installation the instance reads: the
 * process writes its sessions where the reading side looks for them. The default directory is the
 * one the program uses when nothing is said, so nothing is said for it, and the owner's own
 * environment stands.
 */
export function claudeHomeEnv(home: string | undefined): Record<string, string> {
  return home === undefined || home === DEFAULT_HOME ? {} : { [CONFIG_DIR_ENV]: home };
}

/**
 * The built-in tools an allow-list switches off: every name the SDK lists that is not allowed.
 * The allow-list itself reaches Claude Code through niwa's adapter entry; the same tools switched
 * off as well keep them off should a build of the adapter give its own set after all. The SDK says
 * its list is not complete, which is why the allow-list, not this, is what holds the session.
 */
export function claudeToolsOff(allow: readonly string[]): string[] {
  return BUILTIN_TOOL_NAMES.filter((name) => !allow.includes(name));
}
