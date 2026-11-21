/** MiniMax Code's own tools, as the common model describes them. */

import { shapeOf } from "@niwa-labs/harness";
import type { ToolShape, ToolTable } from "@niwa-labs/harness";

/** The built-in tools of MiniMax Code (`agent-core` `builtin-defs`). */
export const MCODE_TOOLS: ToolTable = {
  bash: { category: "shell", target: ["command"] },
  read: { category: "read", target: ["path"] },
  write: { category: "edit", target: ["path"] },
  edit: { category: "edit", target: ["path"] },
  grep: { category: "search", target: ["pattern"] },
  glob: { category: "search", target: ["pattern"] },
  todowrite: { category: "plan" },
  task: { category: "subagent", target: ["description"] },
};

/** A call of a MiniMax Code tool, in the common model's words. */
export function mcodeToolShape(name: string, input: unknown): ToolShape {
  return shapeOf(MCODE_TOOLS, name, input);
}
