/**
 * The workflow actions as the cockpit calls them: name and the part of each schema the pages read.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. These are the
 * fields the pages use; what the host answers with beyond them is ignored, and a field the host stopped
 * sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const RunState = z.enum(["running", "paused", "finished"]);

export const RunEntry = z.object({
  run: z.string(),
  name: z.string(),
  state: RunState,
  directory: z.string().optional(),
  requestedAt: z.string(),
  workflow: z.string().optional(),
  phases: z.array(z.object({ title: z.string(), detail: z.string().optional(), state: z.enum(["done", "current", "ahead"]) })).optional(),
  waiting: z.string().optional(),
  manualPause: z.boolean().optional(),
  about: z.string(),
  requests: z.number(),
});
export type RunEntry = z.infer<typeof RunEntry>;

export const runsAction = {
  name: "workflow.runs",
  input: z.object({ state: RunState.optional(), limit: z.number().int().positive().optional() }),
  output: z.object({ entries: z.array(RunEntry) }),
} as const;

const StepStatus = z.enum(["running", "paused", "completed", "failed", "unknown", "skipped", "cancelled"]);

export const Step = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  action: z.string(),
  prompt: z.string().optional(),
  waitEvent: z.string().optional(),
  dueAt: z.string().optional(),
  timerName: z.string().optional(),
  historical: z.boolean().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: StepStatus,
  session: z.string().optional(),
  phase: z.string().optional(),
  /** The path of the branch the step is in, when it is in one. */
  branch: z.string().optional(),
  /** The call acts outside the run: once done, a recompute takes it instead of making it again. */
  effect: z.boolean().optional(),
  /** A later start of the run took the answer of this step instead of making the call again. */
  reused: z.boolean().optional(),
});
export type Step = z.infer<typeof Step>;

const PhaseState = z.enum(["done", "current", "ahead"]);

export const Inspection = z.object({
  observedAt: z.string().optional(),
  run: z.string(),
  status: z.object({
    run: z.string(),
    state: RunState,
    outcome: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("done"), result: z.unknown().optional() }),
        z.object({ status: z.literal("failed"), error: z.object({ message: z.string() }) }),
        z.object({ status: z.literal("cancelled") }),
      ])
      .optional(),
    reason: z.string().optional(),
    manualPause: z.object({ id: z.string(), state: z.string() }).optional(),
    choices: z.array(z.string()).optional(),
    requests: z.array(z.string()),
    waiting: z.string().optional(),
  }),
  origin: z.object({
    file: z.string(),
    sourceSeq: z.number().optional(),
    workflow: z.string().optional(),
    version: z.string().optional(),
    args: z.unknown().optional(),
    label: z.string().optional(),
    directory: z.string().optional(),
    requestedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  }),
  phases: z.array(z.object({ title: z.string(), detail: z.string().optional(), state: PhaseState, steps: z.array(Step) })),
  steps: z.array(Step),
  sessions: z.array(z.object({
    id: z.string(),
    ref: z.string(),
    parentSession: z.string().optional(),
    startedAt: z.string(),
  })),
});
export type Inspection = z.infer<typeof Inspection>;

export const inspectAction = {
  name: "workflow.inspect",
  input: z.object({ run: z.string() }),
  output: Inspection,
} as const;

export const resumeAction = {
  name: "workflow.resume",
  /** `from`: the step key, or the title of a phase, to run again from; absent, the run is started again from the top. */
  input: z.object({ run: z.string(), from: z.string().min(1).optional() }),
  output: z.object({ run: z.string() }),
} as const;

export const stopAction = {
  name: "workflow.stop",
  /** `at`: the key of the step or branch to stop; absent, the whole run. */
  input: z.object({ run: z.string(), at: z.string().min(1).optional() }),
  output: z.object({ run: z.string() }),
} as const;

export const cancelAction = {
  name: "workflow.cancel",
  input: z.object({ run: z.string() }),
  output: z.object({ run: z.string() }),
} as const;
