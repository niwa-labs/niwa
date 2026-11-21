// A plugin file: a host loads it with `niwa.use(...)`; run on its own it does nothing.
//
// A handler reacts after something happened. An intercept runs before an action.
// There are two kinds: `adjust` may change the input, `guard` may deny it.
//
// The order is fixed: the requested input is validated, all
// adjusts run, the adjusted input is validated again, then all guards run on that final input.
// Nothing a guard approved can be changed afterwards.

import { deny } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { executor, taskCreate } from "@niwa-labs/tasks";
import { sessionStart } from "@niwa-labs/sessions";
import { sendTelegram } from "./03-action.ts";

// Stand-ins: not part of niwa. Where the lessons of a harness come from, and what counts as night.
function lessonsFor(harness: string): string {
  return `Lessons learned on ${harness}: run the tests before you report.`;
}
function isNight(): boolean {
  const hour = new Date().getHours();
  return hour >= 23 || hour < 7;
}

export default plugin("policies", (api) => {
  // Choosing who does the work: reading goes to a cheap model
  // unless the caller already chose.
  api.adjust(taskCreate, (task) => {
    if (task.kind === "read" && !task.responsible) {
      return { ...task, responsible: executor("mcode-work") };
    }
  });

  // Lessons go into the prompt of every new session of that kind of work.
  // A caller may pass the prompt as plain text or as `{ sections }`; by the time an intercept
  // sees it, it has been validated into `{ sections }`, each with an id and a tier, so several
  // plugins can add their own without breaking each other's cache.
  api.adjust(sessionStart, (start) => ({
    ...start,
    prompt: {
      sections: [...start.prompt.sections, { id: "lessons", tier: "stable" as const, text: lessonsFor(start.harness) }],
    },
  }));

  // A refusal. It is recorded, with the reason.
  api.guard(sendTelegram, () => {
    if (isNight()) return deny("no messages at night");
  });
});

// Returning nothing lets the action pass unchanged.
