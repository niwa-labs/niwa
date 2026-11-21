// A plugin file: a host loads it with `niwa.use(...)`; run on its own it does nothing.
//
// A whole plugin in one file. Connected with `niwa.use(nightDigest)`, where `niwa` is the host.
//
// Inside the plugin the parameter is called `api`: it is the plugin API, a different object
// from the host. `api` declares, listens, registers and keeps state; the host installs plugins
// and serves.
// Unloading it removes what it registered; the records it wrote remain.

import { plugin } from "@niwa-labs/plugin";
import { timer } from "@niwa-labs/timer";
import { TaskDone } from "@niwa-labs/tasks";
import { z } from "zod";
import { sendTelegram } from "./03-action.ts";

export default plugin("night-digest", (api) => {
  // State that belongs to this plugin. Only this plugin writes it.
  // Every change is a record in the journal, so who changed it and why is visible.
  const done = api.state("done-today", z.array(z.string()), []);

  // A change is one named operation, not a read followed later by a write,
  // so two handlers cannot lose each other's updates.
  api.on(TaskDone, (task) => {
    done.update((list) => [...list, task.task]);
  });

  // `timer.daily("21:00")` is a trigger, not a record type. It is the type
  // "timer.fired" narrowed to one timer's firings. Do not pass it to `api.declare`:
  // the host refuses a trigger. The `timers` plugin declares "timer.fired" and
  // runs the schedule, so the host installs `timers([timer.daily("21:00")])`
  // (see 01-my-harness.ts). Here the plugin only handles the trigger with `api.on`.
  api.on(timer.daily("21:00"), async (_, step) => {
    // Take the batch and clear the list in one operation.
    // A task finishing right now lands in tomorrow's batch, not in a hole.
    // After a crash and restart, `take` returns the same batch again.
    const batch = done.take();
    if (batch.length === 0) return;

    await step(sendTelegram, { text: `Closed today:\n${batch.join("\n")}` });
  });
});
