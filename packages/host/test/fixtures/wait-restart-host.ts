// The host program for the scenario "waiting survives a restart".
//
// The plugin declares two record types: Start { q } wakes the handler, and
// Answer { q, text } is what the handler waits for. Its handler has three steps:
//
//   await step(ask, { q })                        // the question: counted, and its outcome recorded
//   await step.wait(Answer, { filter: { q: q } })     // the wait: the invocation suspends
//   await step(after, { text: answer.text })      // what happens once the answer arrives
//
// The test kills the host while the invocation is waiting, so the answer never
// arrives in the first process. On restart the invocation resumes: the question
// replays from its recorded outcome (ask is not called again) and the wait is
// still open. The answer that arrives afterwards satisfies the wait, the second
// step runs, and the invocation ends as done.
//
// The home directory comes from argv[2]. The test imports this file for the
// record types, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler. */
export const Start = record("wait-restart.start", z.object({ q: z.string() }), { open: true });

/** What the handler waits for. */
export const Answer = record("wait-restart.answer", z.object({ q: z.string(), text: z.string() }), { open: true });

/** The plugin of this scenario. It needs the home: the stubs count there. */
export function makePlugin(home: string) {
  // The question. Every call is counted, so the test can tell "asked once" from
  // "asked again" across the crash.
  const ask = stubAction("ask", {
    home,
    input: z.object({ q: z.string() }),
    output: z.boolean(),
    recovery: "repeat",
    result: () => true,
  });

  // What happens after the answer arrives. Counted too.
  const after = stubAction("after", {
    home,
    input: z.object({ text: z.string() }),
    output: z.string(),
    recovery: "repeat",
    result: (input) => input.text,
  });

  return plugin("wait-restart", (api) => {
    api.declare(Start, Answer);
    api.action(ask);
    api.action(after);
    api.on(Start, async (data, step) => {
      await step(ask, { q: data.q });

      const { data: answer } = await step.wait(Answer, { filter: { q: data.q } });

      await step(after, { text: answer.text });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun wait-restart-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
