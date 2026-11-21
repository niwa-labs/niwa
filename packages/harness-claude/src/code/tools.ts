/** Claude Code's own tools, as the common model describes them. */

import { z } from "zod";

import { shapeOf } from "@niwa-labs/harness";
import type { Checklist, ToolShape, ToolTable } from "@niwa-labs/harness";

const PATH = ["file_path", "notebook_path", "path"] as const;

/** The built-in tools of Claude Code, and the server tools of the API it runs on. */
export const CLAUDE_TOOLS: ToolTable = {
  Bash: { category: "shell", target: ["command"] },
  BashOutput: { category: "shell", target: ["bash_id"] },
  KillShell: { category: "shell", target: ["shell_id"] },
  KillBash: { category: "shell", target: ["shell_id"] },
  Read: { category: "read", target: PATH },
  NotebookRead: { category: "read", target: PATH },
  Write: { category: "edit", target: PATH },
  Edit: { category: "edit", target: PATH },
  MultiEdit: { category: "edit", target: PATH },
  NotebookEdit: { category: "edit", target: PATH },
  Grep: { category: "search", target: ["pattern"] },
  Glob: { category: "search", target: ["pattern"] },
  LS: { category: "search", target: ["path"] },
  ToolSearch: { category: "search", target: ["query"] },
  WebFetch: { category: "web", target: ["url"] },
  WebSearch: { category: "web", target: ["query"] },
  web_search: { category: "web", target: ["query"] },
  web_fetch: { category: "web", target: ["url"] },
  TodoWrite: { category: "plan" },
  ExitPlanMode: { category: "plan" },
  Task: { category: "subagent", target: ["description"] },
  Agent: { category: "subagent", target: ["description"] },
};

/** A call of a Claude Code tool, in the common model's words. */
export function claudeToolShape(name: string, input: unknown): ToolShape {
  return shapeOf(CLAUDE_TOOLS, name, input);
}

/** The input of Claude Code's `TodoWrite`: the whole list, each item with its state. */
const TodoWriteInput = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});

const TODO_STATES = { pending: "pending", in_progress: "active", completed: "done" } as const;

/** The checklist a call leaves, when it is a `TodoWrite` whose input Claude Code would accept. */
export function claudeChecklist(name: string, input: unknown): Checklist | undefined {
  if (name !== "TodoWrite") return undefined;
  const parsed = TodoWriteInput.safeParse(input);
  if (!parsed.success) return undefined;
  return { items: parsed.data.todos.map((todo) => ({ text: todo.content, state: TODO_STATES[todo.status] })) };
}
