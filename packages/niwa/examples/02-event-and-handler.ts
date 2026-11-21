// A plugin file: a host loads it with `niwa.use(...)`; run on its own it does nothing.
//
// A record type is a value you import, not a string. A typo is a compile error.
// A declared type is not yet known to the host: the plugin declares it with
// `api.declare(...)`, and only then may it be written.
//
// `api` is the plugin API: what a plugin is given while it is loaded. It is not the host
// object (`niwa`, from `createNiwa`) and not the client object (`niwa`, from `connect`).
// A plugin declares, listens and registers through `api`; a script that only reads and calls
// uses the host or a client.

import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { owner } from "@niwa-labs/core";
import { executor, taskCreate } from "@niwa-labs/tasks";
import { z } from "zod";

const BuildFailure = z.object({
  repo: z.string(),
  branch: z.string(),
  log: z.string(),
});
export const BuildFailed = record("ci.build-failed", BuildFailure);

// Stand-in: not part of niwa. Whatever watches your CI (a webhook, a poller) calls back with a
// failure. This one never fails a build.
function watchBuilds(onFailure: (failure: z.output<typeof BuildFailure>) => void): void {
  void onFailure;
}

export default plugin("ci", (api) => {
  // The type is declared to the host first. Without this, writing a record of
  // it is rejected: the host does not know the type.
  api.declare(BuildFailed);

  // A plugin that watches the build writes the fact.
  watchBuilds((failure) => {
    void api.emit(BuildFailed, failure);
  });

  // Anyone else reacts to it. A handler runs after the record is written.
  // `taskCreate` is the typed reference of the tasks module: the step checks the input
  // against its schema, and the result is typed.
  api.on(BuildFailed, async (failed, step) => {
    await step(taskCreate, {
      kind: "fix",
      description: "Fix the failed build",
      text: `The build of ${failed.repo}/${failed.branch} failed. Find out why and fix it.`,
      askedBy: owner,
      responsible: executor("codex"),
      reportTo: owner,
    });
  });
});

// A script that emits does not get the handler's result from `emit`. `emit`
// returns when the record is committed. The handler runs after that, so the
// journal read right away holds the record and not yet what the handler wrote.
// For durability: the fact is on disk first, the work follows and survives a crash.
// A script that wants the outcome waits for the record the handler writes:
//
//   import { TaskCreated } from "@niwa-labs/tasks";
//   const failed = await niwa.emit(BuildFailed, { repo, branch, log });
//   for await (const rec of niwa.records.since(failed.seq, { type: TaskCreated })) {
//     console.log("the handler created", rec.data);
//     break;                 // `since` never ends by itself: stop it when you have the answer
//   }
//
// To wait for the handler to end, follow `niwa.invocation.state` records instead and
// stop at the state "done" or "paused".

// The task created here remembers, without any code of ours,
// that this record caused it and what external input started the chain.
