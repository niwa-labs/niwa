/**
 * The plan of a run: its phases, the steps in each, and how far it has got. Settled phases and
 * steps carry a small recompute control, running ones a stop control; both ask in place before
 * they act (see `guarded-action.tsx`).
 */

import { RotateCcwIcon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../lib/cn.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { GuardButton, GuardNotice, useGuardedAction } from "./guarded-action.tsx";
import type { GuardTiming } from "./guard.ts";
import {
  describeRecompute,
  describeStop,
  type PlanPhase as PlanPhaseShape,
  type PlanStep as PlanStepShape,
  type PlanTarget,
} from "./plan-impact.ts";
import { isSettled, StateRing, type WorkState } from "./state.tsx";

export type PhasePlanStep = PlanStepShape & {
  /** Short facts on the right of the row: a duration, a cost, "reused from v3". */
  meta?: ReactNode;
  /** Shown under the step, e.g. its last output line or a link to its session. */
  detail?: ReactNode;
};

export type PhasePlanPhase = PlanPhaseShape<PhasePlanStep> & { meta?: ReactNode };

export type PhasePlanProps = {
  phases: readonly PhasePlanPhase[];
  /** Recompute from a phase or a step. Without it no recompute control is shown. */
  onRecompute?: ((target: PlanTarget) => void) | undefined;
  /** Stop a phase or a step. Without it no stop control is shown. */
  onStop?: ((target: PlanTarget) => void) | undefined;
  /** Whether a target may be recomputed; every settled target by default. */
  canRecompute?: ((target: PlanTarget) => boolean) | undefined;
  /** Whether a target may be stopped; every running or waiting target by default. */
  canStop?: ((target: PlanTarget) => boolean) | undefined;
  /** The explanation shown before a recompute; worked out from the plan by default. */
  explainRecompute?: ((target: PlanTarget) => ReactNode) | undefined;
  /** The explanation shown before a stop; worked out from the plan by default. */
  explainStop?: ((target: PlanTarget) => ReactNode) | undefined;
  timing?: Partial<GuardTiming> | undefined;
  className?: string | undefined;
};

function isActive(state: WorkState): boolean {
  return state === "running" || state === "waiting";
}

type Controls = Pick<
  PhasePlanProps,
  "onRecompute" | "onStop" | "canRecompute" | "canStop" | "explainRecompute" | "explainStop" | "timing"
> & { phases: readonly PhasePlanPhase[] };

function RowControls({ target, state, controls, children }: { target: PlanTarget; state: WorkState; controls: Controls; children: ReactNode }) {
  const { onRecompute, onStop } = controls;
  const recomputable =
    onRecompute !== undefined && isSettled(state) && state !== "skipped" && (controls.canRecompute?.(target) ?? true);
  const stoppable = onStop !== undefined && isActive(state) && (controls.canStop?.(target) ?? true);

  const recompute = useGuardedAction({ onConfirm: () => onRecompute?.(target), timing: controls.timing, disabled: !recomputable });
  const stop = useGuardedAction({ onConfirm: () => onStop?.(target), timing: controls.timing, disabled: !stoppable });
  const engaged = recompute.state.phase !== "idle" || stop.state.phase !== "idle";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="group/plan-row flex min-w-0 items-center gap-2">
        {children}
        <div
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5 transition-opacity",
            engaged ? "opacity-100" : "opacity-60 group-hover/plan-row:opacity-100 focus-within:opacity-100",
          )}
        >
          {recomputable || recompute.state.phase !== "idle" ? (
            <GuardButton guard={recompute} icon={<RotateCcwIcon />} label="Recompute from here" />
          ) : null}
          {stoppable || stop.state.phase !== "idle" ? (
            <GuardButton guard={stop} icon={<SquareIcon />} label="Stop" tone="destructive" />
          ) : null}
        </div>
      </div>
      <GuardNotice
        guard={recompute}
        pending="Recomputing"
        consequence={controls.explainRecompute?.(target) ?? describeRecompute(controls.phases, target)}
      />
      <GuardNotice
        guard={stop}
        pending="Stopping"
        tone="destructive"
        consequence={controls.explainStop?.(target) ?? describeStop(controls.phases, target)}
      />
    </div>
  );
}

function StepRow({ phase, step, controls }: { phase: string; step: PhasePlanStep; controls: Controls }) {
  return (
    <li data-slot="plan-step" data-state={step.state} className="flex min-w-0 flex-col gap-1">
      <RowControls target={{ phase, step: step.id }} state={step.state} controls={controls}>
        <StateRing state={step.state} className="size-2.5" />
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            step.state === "running" && "text-foreground",
            (step.state === "pending" || step.state === "skipped") && "text-muted-foreground",
            step.state === "failed" && "text-destructive",
          )}
        >
          {step.title}
        </span>
        {step.meta === undefined ? null : <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{step.meta}</span>}
      </RowControls>
      {step.detail === undefined ? null : <div className="ml-4.5 min-w-0 text-xs text-muted-foreground">{step.detail}</div>}
    </li>
  );
}

function PhaseRow({ phase, controls }: { phase: PhasePlanPhase; controls: Controls }) {
  const done = phase.steps.filter((s) => s.state === "done" || s.state === "reused").length;
  // Open while the phase is not settled, and when it failed; whoever opened or closed it decides from then on.
  const [chosen, choose] = useState<boolean | undefined>(undefined);
  return (
    <Collapsible
      data-slot="plan-phase"
      data-state={phase.state}
      open={chosen ?? (!isSettled(phase.state) || phase.state === "failed")}
      onOpenChange={choose}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <RowControls target={{ phase: phase.id }} state={phase.state} controls={controls}>
        <StateRing state={phase.state} />
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 rounded-md text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="truncate">{phase.title}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {done}/{phase.steps.length}
          </span>
        </CollapsibleTrigger>
        {phase.meta === undefined ? null : <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{phase.meta}</span>}
      </RowControls>
      <CollapsibleContent>
        <ol className="ml-1.5 flex min-w-0 flex-col gap-1.5 border-l pl-3">
          {phase.steps.map((step) => (
            <StepRow key={step.id} phase={phase.id} step={step} controls={controls} />
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PhasePlan({ phases, className, ...rest }: PhasePlanProps) {
  const controls: Controls = { ...rest, phases };
  return (
    <ol data-slot="phase-plan" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {phases.map((phase) => (
        <li key={phase.id}>
          <PhaseRow phase={phase} controls={controls} />
        </li>
      ))}
    </ol>
  );
}
