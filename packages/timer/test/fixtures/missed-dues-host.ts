// The host program for the missed-dues scenario of the timer.
//
// A timer fires. With the host down at the due time, what happens after start is exactly what
// the timer's declared rule says, once.
//
// The host installs two plugins:
//
//   "timers" — the scheduler: it writes the firings
//   "ticks"  — a handler of the trigger of the timer: it counts the firings it is woken by
//
// The timer itself comes from the command line, so the test can say how long the period is and
// what the rule about the missed dues is:
//
//   argv[2] the home
//   argv[3] the id of the timer
//   argv[4] the period, in milliseconds
//   argv[5] the rule about the missed dues: "once" or "skip"
//
// The handler of the trigger is what shows that a trigger is usable in `niwa.on`: it is woken
// by the firings of its own timer and by no others.
//
// The home directory comes from argv[2]. The test imports this file for the timer it declares,
// so the host only starts when the file is run directly.

import { plugin } from "@niwa-labs/plugin";
import type { MissedRule } from "@niwa-labs/plugin";
import { counter, createNiwa } from "@niwa-labs/testing";

import { timerFired, timers } from "../../src/index.ts";

/** The id of the timer the host runs. It is the same in every process of the scenario. */
export const TIMER_ID = "tick";

/** The period of the timer, in milliseconds: short, so the scenario does not take long. */
export const EVERY_MS = 500;

/**
 * The plugin of the scenario: it counts the firings of the timer.
 *
 * The counter lives in the home, so the count survives the death of the process that wrote it.
 */
function makePlugin(home: string, id: string) {
  return plugin("ticks", (api) => {
    api.on(timerFired(id), () => {
      counter(home, `fired:${id}`).hit();
    });
  });
}

/** The plugin of the scheduler, with the timer the command line asks for. */
function makeTimers(id: string, every: number, missed: MissedRule) {
  return timers([{ id, every, missed }]);
}

if (import.meta.main) {
  const home = process.argv[2];
  const id = process.argv[3] ?? TIMER_ID;
  const every = Number(process.argv[4] ?? EVERY_MS);
  const missed = (process.argv[5] ?? "once") as MissedRule;
  if (!home) {
    console.error("usage: bun missed-dues-host.ts <home> <timer-id> <every-ms> <missed>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makeTimers(id, every, missed));
  niwa.use(makePlugin(home, id));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
