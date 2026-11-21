/** Codex's own tools, as the common model describes them. */

import { shapeOf } from "@niwa-labs/harness";
import type { ToolShape, ToolTable } from "@niwa-labs/harness";

/** The tools Codex gives its model. */
export const CODEX_TOOLS: ToolTable = {
  shell: { category: "shell", target: ["command", "cmd"] },
  local_shell: { category: "shell", target: ["command", "cmd"] },
  "container.exec": { category: "shell", target: ["command", "cmd"] },
  shell_command: { category: "shell", target: ["command", "cmd"] },
  exec_command: { category: "shell", target: ["cmd", "command"] },
  write_stdin: { category: "shell", target: ["session_id"] },
  apply_patch: { category: "edit" },
  view_image: { category: "read", target: ["path"] },
  web_search: { category: "web", target: ["query"] },
  update_plan: { category: "plan" },
  spawn_agent: { category: "subagent", target: ["message", "prompt"] },
  send_input: { category: "subagent", target: ["message"] },
  wait: { category: "subagent" },
  close_agent: { category: "subagent" },
};

/**
 * An MCP tool, as Codex names it to the model: the server and the tool joined by `__`, with or
 * without the `mcp__` prefix of newer builds.
 */
function isMcp(name: string): boolean {
  return name.includes("__");
}

/** The files an `apply_patch` touches, in the order its patch names them. */
export function patchedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path !== undefined && path.length > 0 && !files.includes(path)) files.push(path);
  }
  return files;
}

/** A call of a Codex tool, in the common model's words. A patch is about the first file it names. */
export function codexToolShape(name: string, input: unknown): ToolShape {
  const shape = shapeOf(CODEX_TOOLS, name, input, isMcp);
  if (name !== "apply_patch") return shape;
  const patch = typeof input === "string" ? input : typeof input === "object" && input !== null ? Object.getOwnPropertyDescriptor(input, "input")?.value : undefined;
  const first = typeof patch === "string" ? patchedFiles(patch)[0] : undefined;
  return first === undefined ? shape : { ...shape, target: first };
}
