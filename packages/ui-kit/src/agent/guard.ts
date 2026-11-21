/**
 * Soft protection for an action that cannot be taken back, such as recomputing or stopping work.
 *
 * Nothing opens over the page. The control asks in place: the first press arms it and says what
 * will be affected, a second press (or holding the first one) confirms it. A confirmed action is
 * not sent at once: for a short while it can still be undone, and only when that window closes is
 * the action fired. Host actions cannot be revoked once sent, so undo means "not sent yet".
 *
 * The machine is a pure reducer over explicit times; the hook that drives it owns the clock.
 */

export type GuardTiming = {
  /** How long an armed control waits for the second press before it disarms. */
  armMs: number;
  /** How long a press must be held to confirm without a second press. */
  holdMs: number;
  /** How long a confirmed action can still be undone before it is fired. */
  undoMs: number;
};

export const DEFAULT_GUARD_TIMING: GuardTiming = { armMs: 4000, holdMs: 700, undoMs: 3000 };

export type GuardState =
  | { phase: "idle" }
  /** Pressed once; waiting for the second press until `until`. */
  | { phase: "armed"; until: number }
  /** The pointer is down since `since`; `armedUntil` remembers an arming the hold started from. */
  | { phase: "holding"; since: number; armedUntil: number | null }
  /** Confirmed; fired at `until` unless undone. */
  | { phase: "pending"; until: number }
  /** The undo window closed: the action is to be fired now, once. */
  | { phase: "fired" };

export type GuardEvent =
  /** A click, a keyboard activation, or a short press: arms, or confirms an armed control. */
  | { type: "press"; now: number }
  | { type: "holdStart"; now: number }
  /** The pointer is released over the control. */
  | { type: "holdEnd"; now: number }
  /** The pointer left the control or the press was taken over by scrolling. */
  | { type: "holdCancel"; now: number }
  /** Time passed: expire an arming, complete a hold, close the undo window. */
  | { type: "tick"; now: number }
  /** Escape, focus leaving the control, the undo button: back to idle without firing. */
  | { type: "cancel" }
  /** The fired action was handed over. */
  | { type: "reset" };

export const IDLE: GuardState = { phase: "idle" };

function confirm(now: number, timing: GuardTiming): GuardState {
  return { phase: "pending", until: now + timing.undoMs };
}

function press(state: GuardState, now: number, timing: GuardTiming): GuardState {
  if (state.phase === "idle") return { phase: "armed", until: now + timing.armMs };
  if (state.phase === "armed") return now < state.until ? confirm(now, timing) : { phase: "armed", until: now + timing.armMs };
  return state;
}

/** The phase a hold returns to when it ends without confirming. */
function beforeHold(state: Extract<GuardState, { phase: "holding" }>, now: number): GuardState {
  return state.armedUntil !== null && now < state.armedUntil ? { phase: "armed", until: state.armedUntil } : IDLE;
}

export function guardReducer(state: GuardState, event: GuardEvent, timing: GuardTiming = DEFAULT_GUARD_TIMING): GuardState {
  switch (event.type) {
    case "press":
      return press(state, event.now, timing);
    case "holdStart":
      if (state.phase === "idle") return { phase: "holding", since: event.now, armedUntil: null };
      if (state.phase === "armed") return { phase: "holding", since: event.now, armedUntil: state.until };
      return state;
    case "holdEnd":
      if (state.phase !== "holding") return state;
      if (event.now - state.since >= timing.holdMs) return confirm(event.now, timing);
      // A short press is a press: it arms an idle control and confirms an armed one.
      return press(beforeHold(state, event.now), event.now, timing);
    case "holdCancel":
      return state.phase === "holding" ? beforeHold(state, event.now) : state;
    case "tick":
      if (state.phase === "armed" && event.now >= state.until) return IDLE;
      if (state.phase === "holding" && event.now - state.since >= timing.holdMs) return confirm(event.now, timing);
      if (state.phase === "pending" && event.now >= state.until) return { phase: "fired" };
      return state;
    case "cancel":
      return state.phase === "fired" ? state : IDLE;
    case "reset":
      return state.phase === "fired" ? IDLE : state;
  }
}

/** When the reducer next needs a tick, or null when nothing is waiting on time. */
export function nextDeadline(state: GuardState, timing: GuardTiming = DEFAULT_GUARD_TIMING): number | null {
  switch (state.phase) {
    case "armed":
    case "pending":
      return state.until;
    case "holding":
      return state.since + timing.holdMs;
    default:
      return null;
  }
}

/**
 * Whether a control that goes away must still fire its action.
 *
 * A confirmed action is the owner's decision; the undo window is a courtesy while the control is
 * on screen. A row that scrolls out of a virtual list, or a page the owner leaves, fires what was
 * confirmed. An armed or held control that goes away was never confirmed and fires nothing.
 */
export function firesOnUnmount(state: GuardState): boolean {
  return state.phase === "pending" || state.phase === "fired";
}

/** How far a hold has come, from 0 to 1, for a progress ring. */
export function holdProgress(state: GuardState, now: number, timing: GuardTiming = DEFAULT_GUARD_TIMING): number {
  if (state.phase !== "holding") return 0;
  return Math.min(1, Math.max(0, (now - state.since) / timing.holdMs));
}
