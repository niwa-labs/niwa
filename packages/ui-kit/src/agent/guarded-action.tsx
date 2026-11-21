/**
 * A small icon control for an action that cannot be taken back, with soft protection in place:
 * the first press says what will be affected, a second press or a held press confirms, and a
 * confirmed action can be undone for a few seconds before it is fired. See `guard.ts`.
 */

import { UndoIcon } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import { cn } from "../lib/cn.ts";
import { buttonVariants } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import {
  DEFAULT_GUARD_TIMING,
  firesOnUnmount,
  guardReducer,
  IDLE,
  nextDeadline,
  type GuardState,
  type GuardTiming,
} from "./guard.ts";

export type GuardedActionOptions = {
  /** Called once, when the undo window of a confirmed press closes. */
  onConfirm: () => void;
  timing?: Partial<GuardTiming> | undefined;
  disabled?: boolean | undefined;
};

export type GuardedAction = {
  state: GuardState;
  /** The current time, refreshed while a countdown is shown. */
  now: number;
  timing: GuardTiming;
  /** Props for the button that arms and confirms. */
  buttonProps: {
    disabled: boolean | undefined;
    onPointerDown: (event: { button: number }) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onClick: (event: { detail: number }) => void;
    onKeyDown: (event: { key: string; repeat: boolean; preventDefault(): void }) => void;
    onBlur: () => void;
  };
  /** Back to idle without firing: the undo of a confirmed press. */
  cancel: () => void;
};

/** Drives the guard with the real clock. */
export function useGuardedAction({ onConfirm, timing: timingOverride, disabled }: GuardedActionOptions): GuardedAction {
  const timing: GuardTiming = { ...DEFAULT_GUARD_TIMING, ...timingOverride };
  const [state, dispatch] = useReducer(
    (current: GuardState, event: Parameters<typeof guardReducer>[1]) => guardReducer(current, event, timing),
    IDLE,
  );
  const [now, setNow] = useState(() => Date.now());

  const onConfirmRef = useRef(onConfirm);
  const stateRef = useRef(state);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
    stateRef.current = state;
  });

  // Wake up at the next deadline, and refresh the countdown while one is shown.
  const deadline = nextDeadline(state, timing);
  useEffect(() => {
    if (deadline === null) return;
    // A timer may fire a little early; the tick counts as the deadline so the phase always moves on.
    const wake = setTimeout(
      () => dispatch({ type: "tick", now: Math.max(Date.now(), deadline) }),
      Math.max(0, deadline - Date.now()),
    );
    const refresh = setInterval(() => setNow(Date.now()), 250);
    setNow(Date.now());
    return () => {
      clearTimeout(wake);
      clearInterval(refresh);
    };
  }, [deadline]);

  useEffect(() => {
    if (state.phase !== "fired") return;
    stateRef.current = IDLE;
    dispatch({ type: "reset" });
    onConfirmRef.current();
  }, [state]);

  // A confirmed action whose control goes away is still the owner's decision: fire it.
  useEffect(
    () => () => {
      if (!firesOnUnmount(stateRef.current)) return;
      // Hidden and shown again with its state kept, the control must not fire a second time.
      stateRef.current = IDLE;
      dispatch({ type: "cancel" });
      onConfirmRef.current();
    },
    [],
  );

  const isDisabled = disabled === true && state.phase !== "pending";
  return {
    state,
    now,
    timing,
    cancel: () => dispatch({ type: "cancel" }),
    buttonProps: {
      disabled: isDisabled,
      onPointerDown: (event) => {
        if (event.button === 0) dispatch({ type: "holdStart", now: Date.now() });
      },
      onPointerUp: () => dispatch({ type: "holdEnd", now: Date.now() }),
      onPointerLeave: () => dispatch({ type: "holdCancel", now: Date.now() }),
      onPointerCancel: () => dispatch({ type: "holdCancel", now: Date.now() }),
      // Pointer presses are handled above; a click with no pointer behind it is a keyboard or an
      // assistive technology activating the button.
      onClick: (event) => {
        if (event.detail === 0) dispatch({ type: "press", now: Date.now() });
      },
      onKeyDown: (event) => {
        if (event.key === "Escape") dispatch({ type: "cancel" });
        // A held Enter repeats clicks; it must not arm and confirm without a second press.
        else if (event.repeat) event.preventDefault();
      },
      onBlur: () => {
        if (stateRef.current.phase === "armed" || stateRef.current.phase === "holding") dispatch({ type: "cancel" });
      },
    },
  };
}

export type GuardButtonProps = {
  guard: GuardedAction;
  icon: ReactNode;
  /** What the action does, for the tooltip and screen readers: "Recompute from here". */
  label: string;
  tone?: "default" | "destructive" | undefined;
  className?: string | undefined;
};

/** The icon button of a guarded action, with a ring that fills while the press is held. */
export function GuardButton({ guard, icon, label, tone = "default", className }: GuardButtonProps) {
  const { state, timing } = guard;
  const active = state.phase !== "idle";
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={label}
        aria-pressed={active}
        data-slot="guard-button"
        data-phase={state.phase}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "relative text-muted-foreground",
          active && (tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"),
          className,
        )}
        {...guard.buttonProps}
      >
        {icon}
        <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute inset-0 size-full! -rotate-90">
          <circle
            cx="12"
            cy="12"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={state.phase === "holding" ? 0 : 1}
            style={{
              transition: state.phase === "holding" ? `stroke-dashoffset ${timing.holdMs}ms linear` : "none",
              opacity: state.phase === "holding" ? 1 : 0,
            }}
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export type GuardNoticeProps = {
  guard: GuardedAction;
  /** What will be affected, shown once the control is armed. */
  consequence: ReactNode;
  /** What is about to happen, shown during the undo window: "Recomputing", "Stopping". */
  pending: string;
  tone?: "default" | "destructive" | undefined;
  className?: string | undefined;
};

function secondsLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

/** The in-place explanation of an armed or confirmed guarded action; nothing while idle. */
export function GuardNotice({ guard, consequence, pending, tone = "default", className }: GuardNoticeProps) {
  const { state, now } = guard;
  if (state.phase === "idle" || state.phase === "fired") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="guard-notice"
      data-phase={state.phase}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 text-xs",
        tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
        className,
      )}
    >
      {state.phase === "pending" ? (
        <>
          <span>
            {pending} in {secondsLeft(state.until, now)}s
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline [&_svg]:size-3"
            onClick={guard.cancel}
          >
            <UndoIcon />
            Undo
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0">{consequence}</span>
          <span className="text-muted-foreground">
            {state.phase === "holding" ? "Keep holding…" : "Press again or hold to confirm · Esc to cancel"}
          </span>
        </>
      )}
    </div>
  );
}
