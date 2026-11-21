/**
 * Tool calls and checklists in the common model.
 *
 * Every harness names its tools in its own words (`Bash`, `exec_command`, `bash`). A kind
 * translates each call into a category and the target the call points at, so a consumer of the
 * common model never has to know a harness's tool names. The same goes for the checklist an agent
 * keeps of its work (`TodoWrite`, `update_plan`, an ACP plan): each kind reads its own and gives a
 * `Checklist`.
 */

import { z } from "zod";

/**
 * What a tool call does, the same for every harness.
 *
 * - `shell`: runs a command;
 * - `read`: reads a file or an image;
 * - `edit`: writes, edits or patches files;
 * - `search`: looks for files or for text in them;
 * - `web`: fetches or searches the web;
 * - `plan`: updates the agent's own checklist or plan;
 * - `subagent`: hands work to another agent;
 * - `mcp`: a tool of an MCP server;
 * - `other`: anything else.
 */
export const ToolCategorySchema = z.enum(["shell", "read", "edit", "search", "web", "plan", "subagent", "mcp", "other"]);
export type ToolCategory = z.output<typeof ToolCategorySchema>;

/** The state of one item of a checklist. */
export const ChecklistStateSchema = z.enum(["pending", "active", "done"]);
export type ChecklistState = z.output<typeof ChecklistStateSchema>;

export const ChecklistItemSchema = z.object({
  text: z.string(),
  state: ChecklistStateSchema,
});
export type ChecklistItem = z.output<typeof ChecklistItemSchema>;

/** The checklist an agent keeps of its work, whole, as it stood after an update. */
export const ChecklistSchema = z.object({
  items: z.array(ChecklistItemSchema),
});
export type Checklist = z.output<typeof ChecklistSchema>;

/** How far a checklist is: the items that are done, of all of them. */
export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
}

export function checklistProgress(checklist: Checklist): ChecklistProgress {
  return { done: checklist.items.filter((item) => item.state === "done").length, total: checklist.items.length };
}

/** What a kind says of a call of one of its tools. */
export interface ToolShape {
  readonly category: ToolCategory;
  /** The path, command, pattern, address or task the call is about, when its input names one. */
  readonly target?: string;
}

/**
 * The first string among `keys` of an input, trimmed to one line: the target a kind takes from
 * the input of a tool whose shape it knows.
 */
export function targetOf(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  for (const key of keys) {
    const value = Object.getOwnPropertyDescriptor(input, key)?.value;
    if (typeof value === "string" && value.trim().length > 0) return value.replace(/\s+/g, " ").trim();
    if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length > 0) {
      return value.join(" ").replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

/** How a kind describes one of its own tools: its category, and the input keys that name its target. */
export interface ToolEntry {
  readonly category: ToolCategory;
  readonly target?: readonly string[];
}

/** A kind's own tools, by the names the kind gives them. */
export type ToolTable = Readonly<Record<string, ToolEntry>>;

/**
 * The shape of a call by a kind's table: a tool the table does not name is `mcp` when the kind
 * says the name is one of an MCP server's, else `other`.
 */
export function shapeOf(
  table: ToolTable,
  name: string,
  input: unknown,
  isMcp: (name: string) => boolean = (tool) => tool.startsWith("mcp__"),
): ToolShape {
  const entry = Object.hasOwn(table, name) ? table[name] : undefined;
  if (entry === undefined) return { category: isMcp(name) ? "mcp" : "other" };
  const target = entry.target === undefined ? undefined : targetOf(input, entry.target);
  return target === undefined ? { category: entry.category } : { category: entry.category, target };
}
