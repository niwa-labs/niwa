import type { ClaudeOptions } from "@niwa-labs/harness";

/** The variable that takes Claude Code's advisor tool away; nothing else does (not `disallowedTools`). */
const ADVISOR_OFF_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

/** The environment a Claude Code process is given for these options: empty when the owner's own config stands. */
export function claudeEnv(options: ClaudeOptions | undefined): Record<string, string> {
  return options?.advisor === false ? { [ADVISOR_OFF_ENV]: "1" } : {};
}
