/** ZCode's own tools, as the common model describes them. */

import { shapeOf } from "@niwa-labs/harness";
import type { ToolShape, ToolTable } from "@niwa-labs/harness";

/** The built-in tools of ZCode (its `contracts` package names them). */
export const ZCODE_TOOLS: ToolTable = {
  Bash: { category: "shell", target: ["command"] },
  Read: { category: "read", target: ["file_path"] },
  ReadPdf: { category: "read", target: ["file_path"] },
  Write: { category: "edit", target: ["file_path"] },
  Edit: { category: "edit", target: ["file_path"] },
  ApplyPatch: { category: "edit" },
  Grep: { category: "search", target: ["pattern"] },
  Glob: { category: "search", target: ["pattern"] },
  ToolSearch: { category: "search", target: ["query"] },
  WebFetch: { category: "web", target: ["url"] },
  WebSearch: { category: "web", target: ["query"] },
  TodoWrite: { category: "plan" },
  TodoRead: { category: "plan" },
  Agent: { category: "subagent", target: ["description"] },
  Task: { category: "subagent", target: ["description"] },
};

/** A call of a ZCode tool, in the common model's words. */
export function zcodeToolShape(name: string, input: unknown): ToolShape {
  return shapeOf(ZCODE_TOOLS, name, input);
}
