/** The plan of a run as the kit's plan component takes it, from what `workflow.inspect` answers. */

import type { PhasePlanPhase, PhasePlanStep, WorkState } from "@niwa-labs/ui-kit";

import type { Inspection, Step } from "./actions.ts";

const STEP_STATE: Readonly<Record<Step["status"], WorkState>> = {
  running: "running",
  paused: "waiting",
  completed: "done",
  failed: "failed",
  unknown: "pending",
  skipped: "skipped",
  cancelled: "stopped",
};

export function stepState(step: Step): WorkState {
  return STEP_STATE[step.status];
}

/** How long a step took, in milliseconds; undefined while it has not ended. */
export function stepDuration(step: Step): number | undefined {
  if (step.endedAt === undefined) return undefined;
  const took = Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return Number.isFinite(took) && took >= 0 ? took : undefined;
}

/** The state of a declared phase: a current phase takes on how the run ended or why it waits. */
function phaseState(phase: Inspection["phases"][number], status: Inspection["status"]): WorkState {
  if (phase.state === "done") return "done";
  if (phase.state === "ahead") return "pending";
  if (status.state === "paused") return "waiting";
  if (status.outcome?.status === "failed") return "failed";
  if (status.outcome?.status === "cancelled") return "stopped";
  return "running";
}

/** The state of the run's own phase, for a script that declares none. */
function runState(status: Inspection["status"]): WorkState {
  if (status.state === "paused") return "waiting";
  if (status.state === "running") return "running";
  return status.outcome?.status === "failed" ? "failed" : status.outcome?.status === "cancelled" ? "stopped" : "done";
}

export const STEPS_PHASE = "Steps";

/**
 * The phases of the plan. Steps that named no phase are the last phase, "Steps"; a script that declares no phases has that one
 * phase alone, so the run still has a row to hold its controls.
 */
export function planOf(inspection: Inspection, toStep: (step: Step) => PhasePlanStep): PhasePlanPhase[] {
  const phases = inspection.phases.map(
    (phase, index): PhasePlanPhase => ({
      id: `phase-${String(index)}`,
      title: phase.title,
      state: phaseState(phase, inspection.status),
      steps: phase.steps.map(toStep),
    }),
  );
  if (inspection.steps.length > 0 || phases.length === 0) {
    phases.push({
      id: "steps",
      title: phases.length === 0 ? "Run" : STEPS_PHASE,
      state: phases.length === 0 ? runState(inspection.status) : inspection.steps.some((step) => step.status === "running") ? "running" : "done",
      steps: inspection.steps.map(toStep),
    });
  }
  return phases;
}
