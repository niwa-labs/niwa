/** What Claude Code needs inside a box, shared by its ACP and SDK harnesses. */

import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";

import { homePath } from "@niwa-labs/sandbox";
import type { HarnessNeeds } from "@niwa-labs/sandbox";

/**
 * Its own directory and the endpoint of its model. Only directories: nono takes a file by another
 * flag, so a file such as `~/.claude.json` is for the grant's spec to name.
 */
export const CLAUDE_NEEDS: HarnessNeeds = {
  write: [homePath(".claude")],
  net: ["api.anthropic.com"],
};

/**
 * The built-in tools an allow-list switches off: every name the SDK lists that is not allowed.
 * The allow-list itself reaches Claude Code through niwa's adapter entry; the same tools switched
 * off as well keep them off should a build of the adapter give its own set after all. The SDK says
 * its list is not complete, which is why the allow-list, not this, is what holds the session.
 */
export function claudeToolsOff(allow: readonly string[]): string[] {
  return BUILTIN_TOOL_NAMES.filter((name) => !allow.includes(name));
}
