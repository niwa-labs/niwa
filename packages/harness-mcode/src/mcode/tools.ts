/** MiniMax Code's own tools, as the common model describes them. */

import { z } from "zod";

import { shapeOf } from "@niwa-labs/harness";
import type { Checklist, ChecklistState, ToolShape, ToolTable } from "@niwa-labs/harness";

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

/**
 * The input of MiniMax Code's `todowrite`. Its states are strings (`pending`, `in_progress`,
 * `completed`, `cancelled`), as in the tool it copies.
 */
const TodoWriteInput = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.string() })),
});

const TODO_STATES: Readonly<Record<string, ChecklistState | null>> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  // A cancelled item is no longer part of the work.
  cancelled: null,
};

/**
 * The checklist a call leaves, when it is a `todowrite` the common model can read: an item in a
 * state it does not know makes the whole list unreadable, never a guess.
 */
export function mcodeChecklist(name: string, input: unknown): Checklist | undefined {
  if (name !== "todowrite") return undefined;
  const parsed = TodoWriteInput.safeParse(input);
  if (!parsed.success) return undefined;
  const items: Checklist["items"] = [];
  for (const todo of parsed.data.todos) {
    const state = Object.hasOwn(TODO_STATES, todo.status) ? TODO_STATES[todo.status] : undefined;
    if (state === undefined) return undefined;
    if (state !== null) items.push({ text: todo.content, state });
  }
  return { items };
}
