// The host program for the scenario "a long wait blocks nothing".
//
// "One invocation waits on a request. Write ten more matching
// records. All ten are handled while the first still waits."
//
// The plugin declares three record types and two handlers:
//
//   on Ask { n }   — wait for Answer { n } and nothing else
//   on Job { n }   — call the action "job", which is counted
//
// The wait is a step of its own, so the Ask invocation suspends: the journal shows
// its state as "waiting" and the host is free for everything else. The ten Job
// records are therefore handled while the Ask invocation is still waiting, and the
// answer that arrives later satisfies the wait and ends the invocation as done.
//
// The home directory comes from argv[2]. The test imports this file for the record
// types, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler that waits. */
export const Ask = record("long-wait.ask", z.object({ n: z.number() }), { open: true });

/** What the waiting handler waits for. */
export const Answer = record("long-wait.answer", z.object({ n: z.number() }), { open: true });

/** Wakes the handler that works while the other one waits. */
export const Job = record("long-wait.job", z.object({ n: z.number() }), { open: true });

/** The plugin of this scenario. It needs the home: the stub counts there. */
export function makePlugin(home: string) {
  // The work itself. Every call is counted, so the test can tell "ten jobs handled"
  // from "ten job records written".
  const job = stubAction("job", {
    home,
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    effect: "write",
    result: (input) => input,
  });

  return plugin("long-wait", (api) => {
    api.declare(Ask, Answer, Job);
    api.action(job);

    // The long wait: the invocation suspends here and waits for its answer. Each question waits for
    // its own answer, so the subscription runs them all at once.
    api.on(Ask, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      await step.wait(Answer, { filter: { n: data.n } });
    });

    // The work that goes on while the other invocation waits.
    api.on(Job, async (data, step) => {
      await step(job, { n: data.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun long-wait-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
