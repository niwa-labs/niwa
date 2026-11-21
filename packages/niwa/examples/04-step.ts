// A plugin file: a host loads it with `niwa.use(...)`; run on its own it does nothing. Its step
// asks a session of the harness `mcode-work`, so that host needs MiniMax Code installed.
//
// A step is a recorded boundary inside an invocation: the intent is recorded,
// the call is made, the outcome is recorded.
//
// An invocation is this handler woken by one record. It is durable.

import { plugin } from "@niwa-labs/plugin";
import { sessionAsk } from "@niwa-labs/sessions";
import { TaskDone } from "@niwa-labs/tasks";
import { z } from "zod";

import { sendTelegram } from "./03-action.ts";

// The shape of the answer. The session is given it as a JSON schema, and the value that comes
// back is `unknown` until it is parsed with the same schema.
const Short = z.object({ text: z.string() });

export default plugin("notify", (api) => {
  api.on(TaskDone, async (done, step) => {
    // A task can end without a result: only a result is worth shortening.
    if (done.outcome.status !== "result") return;

    // Step 1. `await step(...)` returns the value; `sessionAsk` is a typed reference,
    // so the input and the `{ value }` it returns are checked. The value passed the schema the
    // session was given, but its type is `unknown`: parse it before reading its fields.
    const asked = await step(sessionAsk, {
      session: "mcode-work s_01",
      prompt: `Shorten this result to three lines:\n${String(done.outcome.result)}`,
      schema: z.toJSONSchema(Short),
    });
    const short = Short.parse(asked.value);

    // Step 2.
    await step(sendTelegram, { text: short.text });
  });

  // Code that wants to decide for itself asks for the outcome instead.
  api.on(TaskDone, { id: "notify-carefully" }, async (done, step) => {
    const sent = await step.outcome(sendTelegram, { text: done.task });

    if (sent.status === "unknown") {
      // The call was cut off. The message may or may not have been delivered.
    }
    // sent.status is "completed" | "denied" | "failed" | "unknown"
  });
});

// The process dies between the steps:
//   after restart the invocation runs again, step 1 returns its recorded value,
//   step 2 runs.
//
// The process dies in the middle of step 2:
//   sendTelegram says "do-not-repeat", so the step ends as "unknown".
//   With plain `await step(...)` the invocation is paused with that outcome and
//   becomes a request: retry, skip or cancel. Nothing is retried blindly.
//
// A step has a key inside its invocation: by default the order of the call.
// Give an explicit key where order can change:
//
//   await step(sendTelegram, { text }, { key: `notify:${task.id}` });
//
// The same key with a different input is a mismatch and pauses the invocation.
// It never silently sends a second message.
//
// Code between steps must be reproducible. The clock and random numbers
// are read through steps too.
