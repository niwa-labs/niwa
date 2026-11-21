/**
 * The options block of the Claude kinds (`claude-code` and `claude-sdk`): what a session of Claude
 * Code takes at its start besides the model, the effort and the mode, under the name `claude`.
 */

import { z } from "zod";

import { kindOptions } from "@niwa-labs/harness";
import type { OptionBlocks } from "@niwa-labs/harness";

/** The options of a Claude Code session. */
export const ClaudeOptions = z.strictObject({
  /** False takes Claude Code's advisor tool away from the session; absent, the owner's own configuration stands. */
  advisor: z.boolean().optional(),
});
export type ClaudeOptions = z.infer<typeof ClaudeOptions>;

/** The block the Claude kinds declare: `claude`, checked by `ClaudeOptions`. */
export const CLAUDE_OPTIONS = kindOptions("claude", ClaudeOptions);

/** The `claude` block of a start, a resume or a question, when it carries one. */
export function claudeBlockOf(blocks: OptionBlocks | undefined): ClaudeOptions | undefined {
  const block = blocks?.[CLAUDE_OPTIONS.block];
  return block === undefined ? undefined : ClaudeOptions.parse(block);
}

/** The variable that takes Claude Code's advisor tool away; nothing else does (not `disallowedTools`). */
const ADVISOR_OFF_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

/** The environment a Claude Code process is given for these options: empty when the owner's own config stands. */
export function claudeEnv(options: ClaudeOptions | undefined): Record<string, string> {
  return options?.advisor === false ? { [ADVISOR_OFF_ENV]: "1" } : {};
}
