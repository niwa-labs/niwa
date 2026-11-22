/**
 * The task actions as the cockpit calls them: name and the part of each schema the pages read.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const Address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }).loose();

export const TaskStatus = z.enum(["open", "done"]);

export const TaskItem = z.object({
  id: z.string(),
  description: z.string(),
  status: TaskStatus,
  kind: z.string(),
  responsible: Address,
});
export type TaskItem = z.infer<typeof TaskItem>;

export const listAction = {
  name: "task.list",
  input: z.object({ status: TaskStatus.optional() }),
  output: z.object({ items: z.array(TaskItem) }),
} as const;

export const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("result"), result: z.unknown() }),
  z.object({ status: z.literal("failure"), reason: z.string() }),
]);

export const TaskEntity = z.object({
  id: z.string(),
  kind: z.string(),
  description: z.string(),
  text: z.string(),
  askedBy: Address,
  responsible: Address,
  reportTo: Address,
  status: TaskStatus,
  outcome: Outcome.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});
export type TaskEntity = z.infer<typeof TaskEntity>;

export const getAction = {
  name: "task.get",
  input: z.object({ id: z.string() }),
  output: TaskEntity,
} as const;
