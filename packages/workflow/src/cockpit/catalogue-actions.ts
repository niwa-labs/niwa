import { z } from "zod";
import type { ActionRefLike } from "@niwa-labs/cockpit-sdk";
import type * as host from "../actions.ts";
import type { workflowStats } from "../stats.ts";

// Browser calls use the name on the wire. Take both wire types from the real
// host reference without bundling its filesystem and journal implementations.
function reference<T extends ActionRefLike<unknown, unknown>>(
  name: string,
): T extends ActionRefLike<infer I, infer O, infer In> ? ActionRefLike<I, O, In> : never;
function reference(name: string) {
  return { name, input: { "~standard": {} }, output: { "~standard": {} } };
}

const problem = z.object({ file: z.string(), line: z.number(), column: z.number(), message: z.string() });
const version = z.object({
  version: z.string(),
  description: z.string(),
  file: z.string(),
  broken: z.string().optional(),
  candidate: z.boolean().optional(),
  superseded: z.boolean().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown().optional(),
  phases: z.array(z.object({ title: z.string(), detail: z.string().optional() })).optional(),
  uses: z.array(z.string()),
  calls: z.array(z.unknown()),
  emits: z.array(z.unknown()).optional(),
  on: z.array(z.unknown()).optional(),
});
export const catalogue = {
  list: reference<typeof host.workflowList>("workflow.list"),
  get: {
    name: "workflow.get",
    input: z.object({ id: z.string() }),
    output: z.object({
      id: z.string(),
      description: z.string(),
      builtin: z.unknown().optional(),
      installations: z.array(z.string()),
      versions: z.array(version),
    }),
  },
  check: {
    name: "workflow.check",
    input: z.object({ file: z.string() }),
    output: z.object({
      ok: z.boolean(),
      description: z.string().optional(),
      file: z.string(),
      errors: z.array(problem),
      warnings: z.array(problem).optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      emits: z.array(z.unknown()).optional(),
    }),
  },
  register: reference<typeof host.workflowRegister>("workflow.register"),
  start: {
    name: "workflow.start",
    input: z.object({
      id: z.string().optional(),
      file: z.string().optional(),
      directory: z.string().optional(),
      label: z.string().optional(),
      args: z.unknown().optional(),
    }),
    output: z.object({ run: z.string() }),
  },
  install: {
    name: "workflow.install",
    input: z.object({ id: z.string(), description: z.string() }),
    output: z.object({ id: z.string() }),
  },
  installation: {
    name: "workflow.installation.get",
    input: z.object({ id: z.string() }),
    output: z.object({ description: z.string(), on: z.array(z.unknown()), builtin: z.unknown().optional() }),
  },
  uninstall: reference<typeof host.workflowUninstall>("workflow.uninstall"),
  stats: reference<typeof workflowStats>("workflow.stats"),
  revise: {
    name: "workflow.revise",
    input: z.object({ run: z.string(), file: z.string() }),
    output: z.object({ revision: z.unknown() }),
  },
  pause: { name: "workflow.pause", input: z.object({ run: z.string() }), output: z.unknown() },
  resume: {
    name: "workflow.resume",
    input: z.object({ run: z.string(), choice: z.enum(["retry", "skip"]) }),
    output: z.unknown(),
  },
  continue: { name: "workflow.continue", input: z.object({ run: z.string(), pause: z.string() }), output: z.unknown() },
};

export const catalogueEvents = { types: ["workflow.*", "request.*", "niwa.invocation.state", "niwa.invocation.resolved", "niwa.step.*", "session.turn.*", "session.started", "session.ended", "timer.sleep.requested", "timer.fired"] };
export const workflowPath = (id: string) => "/workflows/" + encodeURIComponent(id);
