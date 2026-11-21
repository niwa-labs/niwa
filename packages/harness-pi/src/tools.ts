/** pi's own tools, as the common model describes them. */

import { shapeOf } from "@niwa-labs/harness";
import type { ToolShape, ToolTable } from "@niwa-labs/harness";

/** The built-in tools of pi; a tool an extension adds is `other`. */
export const PI_TOOLS: ToolTable = {
  bash: { category: "shell", target: ["command"] },
  read: { category: "read", target: ["path"] },
  edit: { category: "edit", target: ["path"] },
  write: { category: "edit", target: ["path"] },
  grep: { category: "search", target: ["pattern"] },
  find: { category: "search", target: ["pattern"] },
  ls: { category: "search", target: ["path"] },
};

/** A call of a pi tool, in the common model's words. pi names a tool of an MCP server `mcp__<server>__<tool>`. */
export function piToolShape(name: string, input: unknown): ToolShape {
  return shapeOf(PI_TOOLS, name, input);
}
