// The host program for the scenario "plugin state".
//
// The plugin declares five record types and two state values:
//
//   counter  a number, raised by two different handlers
//   batch    a list, filled by Fill and emptied by Take
//
//   Add  { n }      the handler "add"  raises the counter by n
//   Bump { n }      the handler "bump" raises the same counter by n
//   Fill { items }  the handler "fill" puts items into the batch
//   Take { tag }    the handler "take" takes the batch and then blocks in a step
//   Seen { tag, items }  what the handler of Take writes down: the batch it took
//
// The two handlers of the counter wait on a gate before they update, so all
// their invocations are in flight at the same time when the gate opens: the
// updates must not lose each other.
//
// The handler of Take takes the batch and then blocks in the gated step. The
// test kills the host there, so the batch was taken but the invocation never
// finished. On restart the invocation resumes: the take replays from the
// recorded read and returns the same batch, and the batch is not taken twice.
//
// The home directory comes from argv[2]. The test imports this file for the
// record types, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler that raises the counter by n. */
export const Add = record("state.add", z.object({ n: z.number() }), { open: true });

/** Wakes the other handler, which raises the same counter by n. */
export const Bump = record("state.bump", z.object({ n: z.number() }), { open: true });

/** Puts items into the batch. */
export const Fill = record("state.fill", z.object({ items: z.array(z.string()) }), { open: true });

/** Wakes the handler that takes the batch. */
export const Take = record("state.take", z.object({ tag: z.string() }), { open: true });

/** What the handler of Take writes down: the batch it took. */
export const Seen = record("state.seen", z.object({ tag: z.string(), items: z.array(z.string()) }));

/** The plugin of this scenario. It needs the home: the stubs count there. */
export function makePlugin(home: string) {
  // The step the two handlers of the counter wait on. It parks them on the gate
  // "g2" until the test opens it, so every one of them is in flight at once.
  const tick = stubAction("tick", {
    home,
    input: z.object({ n: z.number() }),
    output: z.number(),
    recovery: "repeat",
    gate: "g2",
    result: (input) => input.n,
  });

  // The step the handler of Take parks in. The test kills the host while it
  // waits, so the invocation is unfinished when the host comes back.
  const hold = stubAction("hold", {
    home,
    input: z.object({ tag: z.string() }),
    output: z.object({ tag: z.string() }),
    recovery: "repeat",
    gate: "g",
    result: (input) => ({ tag: input.tag }),
  });

  return plugin("state", (api) => {
    api.declare(Add, Bump, Fill, Take, Seen);
    api.action(tick);
    api.action(hold);

    const counter = api.state("counter", z.number(), 0);
    const batch = api.state("batch", z.array(z.string()), []);

    api.on(Add, async (data, step) => {
      await step(tick, { n: data.n });
      counter.update((value) => value + data.n);
    });

    api.on(Bump, async (data, step) => {
      await step(tick, { n: data.n });
      counter.update((value) => value + data.n);
    });

    api.on(Fill, (data) => {
      batch.update((items) => [...items, ...data.items]);
    });

    api.on(Take, async (data, step) => {
      const items = batch.take();
      await step(hold, { tag: data.tag });
      await step.emit(Seen, { tag: data.tag, items });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun state-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin(home));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
