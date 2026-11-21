/** Consequences shown by the plan before the owner confirms a recompute or stop. */

import type { WorkState } from "./state.tsx";

export type PlanStep = {
  id: string;
  title: string;
  state: WorkState;
  /** The step acts outside the run (a push, a message, a payment); running it again may repeat the effect. */
  effect?: boolean | undefined;
};

export type PlanPhase<S extends PlanStep = PlanStep> = {
  id: string;
  title: string;
  state: WorkState;
  steps: readonly S[];
};

/** A phase, or one step inside it. */
export type PlanTarget = { phase: string; step?: string | undefined };

export type RecomputeImpact = {
  /** Recorded steps in the selected phase, or the selected step itself. */
  selected: number;
  /** Selected steps the plan marks as having an effect, regardless of their last outcome. */
  flagged: number;
};

export type StopImpact = {
  /** The steps that are running or waiting inside the target and will stop. */
  stopping: number;
  /** The steps after the target, or not yet started inside it, that will not start. */
  notStarting: number;
};

type Flat = { phase: string; step: PlanStep };

function flatten(phases: readonly PlanPhase[]): Flat[] {
  return phases.flatMap((phase) => phase.steps.map((step) => ({ phase: phase.id, step })));
}

/** The index of the first step of the target in the flat order, or -1 when the plan has no such target. */
function startOf(flat: readonly Flat[], target: PlanTarget): number {
  return flat.findIndex((f) => f.phase === target.phase && (target.step === undefined || f.step.id === target.step));
}

/** Whether `f` lies inside the target. */
function inside(f: Flat, target: PlanTarget): boolean {
  return f.phase === target.phase && (target.step === undefined || f.step.id === target.step);
}

/** Display order gives no information about which calls a workflow can reuse in another branch. */
export function recomputeImpact(phases: readonly PlanPhase[], target: PlanTarget): RecomputeImpact {
  const phase = phases.find((one) => one.id === target.phase);
  const selected = phase?.steps.filter((step) => target.step === undefined || step.id === target.step) ?? [];
  return { selected: selected.length, flagged: selected.filter((step) => step.effect).length };
}

export function stopImpact(phases: readonly PlanPhase[], target: PlanTarget): StopImpact {
  const flat = flatten(phases);
  const start = startOf(flat, target);
  if (start < 0) return { stopping: 0, notStarting: 0 };
  let stopping = 0;
  let notStarting = 0;
  for (const f of flat.slice(start)) {
    if (inside(f, target) && (f.step.state === "running" || f.step.state === "waiting")) stopping += 1;
    else if (f.step.state === "pending") notStarting += 1;
  }
  return { stopping, notStarting };
}

function steps(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

/** The name of a target as the owner sees it. */
export function targetTitle(phases: readonly PlanPhase[], target: PlanTarget): string {
  const phase = phases.find((p) => p.id === target.phase);
  if (phase === undefined) return target.step ?? target.phase;
  if (target.step === undefined) return phase.title;
  return phase.steps.find((s) => s.id === target.step)?.title ?? target.step;
}

export function describeRecompute(phases: readonly PlanPhase[], target: PlanTarget): string {
  const { selected, flagged } = recomputeImpact(phases, target);
  const title = targetTitle(phases, target);
  const selection = target.step === undefined ? `Recompute “${title}” (${steps(selected)} in this phase).` : `Recompute “${title}”.`;
  const effects = flagged > 0 ? ` ${steps(flagged)} in this selection ${flagged === 1 ? "is" : "are"} marked as having an effect.` : "";
  return `${selection}${effects} Previously sent messages or other external changes may be repeated.`;
}

export function describeStop(phases: readonly PlanPhase[], target: PlanTarget): string {
  const impact = stopImpact(phases, target);
  let text = `Stop “${targetTitle(phases, target)}”`;
  text += impact.stopping > 0 ? `: ${steps(impact.stopping)} running stop` : "";
  if (impact.notStarting > 0) text += `${impact.stopping > 0 ? "," : ":"} ${steps(impact.notStarting)} will not start`;
  return text + ".";
}
