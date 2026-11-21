// A client: it needs a live host serving `~/.niwa` (see 01-my-harness.ts) with the tasks module
// and the harness `codex` installed.
//
// A task is a contract: what to do, who asked, who is responsible, where to report,
// how it ended. Assign it and you are free.
//
// `taskCreate` and `taskResult` are typed actions of the tasks module. `niwa` is the host
// or a client; there is no `niwa.tasks`.

import { connect } from "@niwa-labs/client";
import { owner } from "@niwa-labs/core";
import { executor, taskCreate, taskResult } from "@niwa-labs/tasks";

const niwa = await connect({ home: "~/.niwa" });

const task = await niwa.call(taskCreate, {
  kind: "change",                     // an open label: what sort of work this is
  description: "Split argument parsing", // a few words a list shows
  text: "Move argument parsing into its own module.",
  askedBy: owner,                     // who asks
  responsible: executor("codex"),     // one address; here, an agent in that harness
  reportTo: owner,                    // where updates and the result go
});

// The task is already running in the background. Nothing here waits.
console.log(task.id);

// When you do want the result: this works whether the task finished a second ago
// or will finish next week.
const done = await niwa.call(taskResult, { task: task.id });
console.log(done.outcome.status, done.outcome);

// How the work gets done is the business of the responsible party, not of the task.
// A strong model simply does it. A different way of working (a second session
// kept beside a weak executor to keep it on course, a review before acceptance,
// several attempts in a race) is a strategy: a plugin that accepts the task as the
// responsible party. None is shipped: a composition writes the ones it needs.
