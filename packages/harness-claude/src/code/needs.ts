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
 * The built-in tools a tool allowance switches off: every name the SDK lists that is not allowed.
 * The ACP adapter sets its own `tools` after the options it is given, so an allowlist cannot reach
 * Claude Code through it; the denylist can. The SDK says its list is not complete, so a tool it
 * does not list stays as Claude Code has it.
 */
export function claudeToolsOff(allow: readonly string[]): string[] {
  return BUILTIN_TOOL_NAMES.filter((name) => !allow.includes(name));
}
