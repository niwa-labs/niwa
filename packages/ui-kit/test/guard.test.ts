import { describe, expect, test } from "bun:test";

import { firesOnUnmount, guardReducer, holdProgress, IDLE, nextDeadline, type GuardEvent, type GuardState } from "../src/index.ts";

const timing = { armMs: 4000, holdMs: 700, undoMs: 3000 };

function run(events: GuardEvent[], from: GuardState = IDLE): GuardState {
  return events.reduce((state, event) => guardReducer(state, event, timing), from);
}

describe("guard: two presses", () => {
  test("the first press arms and the second confirms into the undo window", () => {
    const armed = run([{ type: "press", now: 0 }]);
    expect(armed).toEqual({ phase: "armed", until: 4000 });
    expect(run([{ type: "press", now: 1000 }], armed)).toEqual({ phase: "pending", until: 4000 });
  });

  test("an arming expires and the next press arms again instead of confirming", () => {
    const armed = run([{ type: "press", now: 0 }]);
    expect(run([{ type: "tick", now: 3999 }], armed)).toEqual(armed);
    expect(run([{ type: "tick", now: 4000 }], armed)).toEqual(IDLE);
    // A press that lands after the deadline but before the tick does not confirm.
    expect(run([{ type: "press", now: 5000 }], armed)).toEqual({ phase: "armed", until: 9000 });
  });

  test("the action fires only when the undo window closes", () => {
    const pending = run([
      { type: "press", now: 0 },
      { type: "press", now: 100 },
    ]);
    expect(run([{ type: "tick", now: 3099 }], pending).phase).toBe("pending");
    const fired = run([{ type: "tick", now: 3100 }], pending);
    expect(fired).toEqual({ phase: "fired" });
    expect(run([{ type: "reset" }], fired)).toEqual(IDLE);
  });

  test("undo, Escape or blur before the window closes sends nothing", () => {
    const armed = run([{ type: "press", now: 0 }]);
    expect(run([{ type: "cancel" }], armed)).toEqual(IDLE);
    const pending = run([{ type: "press", now: 10 }], armed);
    expect(run([{ type: "cancel" }, { type: "tick", now: 99_999 }], pending)).toEqual(IDLE);
  });

  test("a fired action is not cancelled after the fact", () => {
    expect(run([{ type: "cancel" }], { phase: "fired" })).toEqual({ phase: "fired" });
  });
});

describe("guard: holding", () => {
  test("a press held long enough confirms without a second press", () => {
    const holding = run([{ type: "holdStart", now: 0 }]);
    expect(holding).toEqual({ phase: "holding", since: 0, armedUntil: null });
    expect(run([{ type: "holdEnd", now: 700 }], holding)).toEqual({ phase: "pending", until: 3700 });
  });

  test("the hold completes on a tick while the pointer is still down; the release changes nothing", () => {
    const pending = run([
      { type: "holdStart", now: 0 },
      { type: "tick", now: 700 },
    ]);
    expect(pending).toEqual({ phase: "pending", until: 3700 });
    expect(run([{ type: "holdEnd", now: 900 }], pending)).toEqual(pending);
  });

  test("a short press is an ordinary press: it arms, and on an armed control it confirms", () => {
    const armed = run([
      { type: "holdStart", now: 0 },
      { type: "holdEnd", now: 120 },
    ]);
    expect(armed).toEqual({ phase: "armed", until: 4120 });
    const confirmed = run(
      [
        { type: "holdStart", now: 1000 },
        { type: "holdEnd", now: 1100 },
      ],
      armed,
    );
    expect(confirmed).toEqual({ phase: "pending", until: 4100 });
  });

  test("leaving the control while holding goes back to where the hold started", () => {
    expect(run([{ type: "holdStart", now: 0 }, { type: "holdCancel", now: 300 }])).toEqual(IDLE);
    const armed = run([{ type: "press", now: 0 }]);
    expect(run([{ type: "holdStart", now: 100 }, { type: "holdCancel", now: 300 }], armed)).toEqual(armed);
    // The arming it came back to may have expired meanwhile.
    expect(run([{ type: "holdStart", now: 100 }, { type: "holdCancel", now: 4500 }], armed)).toEqual(IDLE);
  });

  test("progress grows with the hold and is zero otherwise", () => {
    const holding = run([{ type: "holdStart", now: 0 }]);
    expect(holdProgress(holding, 350, timing)).toBeCloseTo(0.5);
    expect(holdProgress(holding, 5000, timing)).toBe(1);
    expect(holdProgress(IDLE, 350, timing)).toBe(0);
  });
});

describe("guard: deadlines and unmounting", () => {
  test("the next deadline is the one the current phase waits for", () => {
    expect(nextDeadline(IDLE, timing)).toBeNull();
    expect(nextDeadline({ phase: "armed", until: 10 }, timing)).toBe(10);
    expect(nextDeadline({ phase: "holding", since: 5, armedUntil: null }, timing)).toBe(705);
    expect(nextDeadline({ phase: "pending", until: 42 }, timing)).toBe(42);
    expect(nextDeadline({ phase: "fired" }, timing)).toBeNull();
  });

  test("a confirmed action fires when its control goes away; an unconfirmed one does not", () => {
    expect(firesOnUnmount({ phase: "pending", until: 1 })).toBe(true);
    expect(firesOnUnmount({ phase: "fired" })).toBe(true);
    expect(firesOnUnmount({ phase: "armed", until: 1 })).toBe(false);
    expect(firesOnUnmount({ phase: "holding", since: 0, armedUntil: null })).toBe(false);
    expect(firesOnUnmount(IDLE)).toBe(false);
  });
});
