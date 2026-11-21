import type { LaunchCapabilities } from "@niwa-labs/harness";

/**
 * What a Claude Code session takes at launch: a model, set on the session after it is created,
 * an effort, the `--effort` flag of the program, and a working mode, set after it is created.
 */
export const CLAUDE_CODE_LAUNCH: LaunchCapabilities = {
  model: true,
  effort: ["low", "medium", "high", "xhigh", "max"],
  modes: ["ask", "auto", "full"],
};
