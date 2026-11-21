/**
 * What recomputing or stopping part of a plan affects, worked out from the plan itself so the
 * owner sees it before confirming.
 *
 * Recomputing from a step keeps every result before it and runs that step and everything after
 * it again. A step with an outside effect that already happened is among them: nothing here knows
 * whether the host will repeat that effect, so the explanation warns that it may, and a caller that
 * does know passes its own explanation to the plan. Stopping a phase or a step stops what runs inside it; within the plan, the steps
 * after it that have not started will not start.
 */

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
  /** The steps that will run again, those that already acted outside included. */
  rerun: number;
  /** The steps before the target whose results are kept. */
  kept: number;
  /** Of those, the steps that already acted outside the run and may act again. */
  effectsRepeated: number;
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

const RAN: ReadonlySet<WorkState> = new Set(["done", "failed", "stopped", "reused", "running", "waiting"]);

export function recomputeImpact(phases: readonly PlanPhase[], target: PlanTarget): RecomputeImpact {
  const flat = flatten(phases);
  const start = startOf(flat, target);
  if (start < 0) return { rerun: 0, kept: 0, effectsRepeated: 0 };
  let rerun = 0;
  let effectsRepeated = 0;
  for (const f of flat.slice(start)) {
    if (f.step.state === "skipped") continue;
    rerun += 1;
    if (f.step.effect === true && RAN.has(f.step.state) && f.step.state !== "failed") effectsRepeated += 1;
  }
  const kept = flat.slice(0, start).filter((f) => f.step.state !== "skipped").length;
  return { rerun, kept, effectsRepeated };
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
  const impact = recomputeImpact(phases, target);
  const parts = [`Recompute from “${targetTitle(phases, target)}”: ${steps(impact.rerun)} run again`];
  if (impact.kept > 0) parts.push(`${impact.kept} earlier kept`);
  let text = parts.join(", ") + ".";
  if (impact.effectsRepeated > 0) {
    text += ` ${impact.effectsRepeated === 1 ? "1 step that already acted outside may" : `${impact.effectsRepeated} steps that already acted outside may`} act again.`;
  }
  return text;
}

export function describeStop(phases: readonly PlanPhase[], target: PlanTarget): string {
  const impact = stopImpact(phases, target);
  let text = `Stop “${targetTitle(phases, target)}”`;
  text += impact.stopping > 0 ? `: ${steps(impact.stopping)} running stop` : "";
  if (impact.notStarting > 0) text += `${impact.stopping > 0 ? "," : ":"} ${steps(impact.notStarting)} will not start`;
  return text + ".";
}
