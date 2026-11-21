/**
 * The state of anything that runs: a run, a phase, a step, a session, a request. One small ring
 * shows it everywhere, so the same state reads the same on every page.
 */

import type { ComponentProps } from "react";

import { cn } from "../lib/cn.ts";

export type WorkState =
  /** Not started yet. */
  | "pending"
  | "running"
  /** Stopped until someone answers: the owner, another agent, a timer. */
  | "waiting"
  | "done"
  | "failed"
  /** Stopped by someone before it finished. */
  | "stopped"
  /** Will not run: a condition or the plan left it out. */
  | "skipped"
  /** Not run again: its result was kept from an earlier pass. */
  | "reused";

export const WORK_STATE_LABEL: Readonly<Record<WorkState, string>> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Skipped",
  reused: "Reused",
};

/** Whether the work can still change by itself. */
export function isSettled(state: WorkState): boolean {
  return state === "done" || state === "failed" || state === "stopped" || state === "skipped" || state === "reused";
}

const RING: Readonly<Record<WorkState, string>> = {
  pending: "border-state-idle border-dashed",
  running: "border-state-running border-t-transparent animate-spin",
  waiting: "border-state-waiting bg-state-waiting/30",
  done: "border-state-done bg-state-done",
  failed: "border-state-failed bg-state-failed",
  stopped: "border-state-idle bg-state-idle",
  skipped: "border-state-idle opacity-50",
  reused: "border-state-done",
};

export type StateRingProps = Omit<ComponentProps<"span">, "children"> & {
  state: WorkState;
  /** Text read by a screen reader and shown as the native tooltip; the state's name by default. */
  label?: string | undefined;
};

export function StateRing({ state, label, className, ...props }: StateRingProps) {
  const text = label ?? WORK_STATE_LABEL[state];
  return (
    <span
      data-slot="state-ring"
      data-state={state}
      role="img"
      aria-label={text}
      title={text}
      className={cn("inline-block size-3 shrink-0 rounded-full border-2", RING[state], className)}
      {...props}
    />
  );
}
