/** ZCode's own tools, as the common model describes them. */

import { z } from "zod";

import { shapeOf } from "@niwa-labs/harness";
import type { Checklist, ToolShape, ToolTable } from "@niwa-labs/harness";

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

/** The input of ZCode's `TodoWrite` (its `TodoItemSchema`): the whole list, each item with its state. */
const TodoWriteInput = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
});

const TODO_STATES = { pending: "pending", in_progress: "active", completed: "done" } as const;

/** The checklist a call leaves, when it is a `TodoWrite` whose input ZCode would accept. */
export function zcodeChecklist(name: string, input: unknown): Checklist | undefined {
  if (name !== "TodoWrite") return undefined;
  const parsed = TodoWriteInput.safeParse(input);
  if (!parsed.success) return undefined;
  return { items: parsed.data.todos.map((todo) => ({ text: todo.content, state: TODO_STATES[todo.status] })) };
}
