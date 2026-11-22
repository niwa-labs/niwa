/** opencode's own tools, as the common model describes them. */

import { shapeOf } from "@niwa-labs/harness";
import type { ToolShape, ToolTable } from "@niwa-labs/harness";

/**
 * The built-in tools of opencode v2. The names and their input keys are the ones opencode's tool
 * registry uses (`bash` runs a `command`, the file tools point at a `filePath`, ...); a tool the
 * table does not name — an MCP server's, a plugin's — is shaped by `shapeOf`'s own rules.
 */
export const OPENCODE_TOOLS: ToolTable = {
  bash: { category: "shell", target: ["command"] },
  read: { category: "read", target: ["filePath"] },
  list: { category: "read", target: ["directory", "path"] },
  write: { category: "edit", target: ["filePath"] },
  edit: { category: "edit", target: ["filePath"] },
  patch: { category: "edit" },
  glob: { category: "search", target: ["pattern"] },
  grep: { category: "search", target: ["pattern"] },
  webfetch: { category: "web", target: ["url"] },
  websearch: { category: "web", target: ["query"] },
  todowrite: { category: "plan" },
  todoread: { category: "plan" },
  task: { category: "subagent", target: ["description", "prompt"] },
  subagent: { category: "subagent", target: ["description", "prompt"] },
};

/** A call of an opencode tool, in the common model's words. */
export function opencodeToolShape(name: string, input: unknown): ToolShape {
  return shapeOf(OPENCODE_TOOLS, name, input);
}
