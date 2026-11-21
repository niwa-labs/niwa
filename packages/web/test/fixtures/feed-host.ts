// The host program for the web feed test.
//
// The plugin declares one record type, Start, and one action, "feed.work". A guard refuses the
// action the first time it is called, so the invocation pauses and waits for the owner to decide.
//
// The refusal is deliberate and repeatable: the action writes what it was asked to do into a file
// in the home, so the test can see whether the step ran again after the owner answered, and how
// many times it ran.
//
// The home directory comes from argv[2].

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { action, deny, record } from "@niwa-labs/core";
import { createNiwa, plugin } from "@niwa-labs/testing";
import { z } from "zod";

/** The record the test writes: it wakes the handler. */
export const Start = record("feed.start", z.object({ n: z.number() }), { open: true });

/** The file the action writes every call into. */
export const CALL_LOG = "calls.log";

/** The file that says the guard has already refused once. */
export const REFUSED_MARKER = "refused.flag";

/** The home this program was started with. */
function home(): string {
  return process.argv[2] as string;
}

/** How many calls the action has had. */
export function callCount(homePath: string): number {
  const path = join(homePath, CALL_LOG);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

/** The action of this host: it writes every call into a file and returns its input. */
export const Work = action("feed.work", {
  description: "Does the work of the host.",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  recovery: "repeat",
  effect: "write",
  run: (input) => {
    appendFileSync(join(home(), CALL_LOG), `${input.n}\n`);
    return { n: input.n };
  },
});

/** The plugin of this host. */
export function makePlugin() {
  return plugin("feed", (api) => {
    api.declare(Start);
    api.action(Work);
    // The first call is refused: the invocation pauses. The owner answers it from the page, and
    // the invocation runs again with the choice in hand — and then the call is allowed.
    api.guard(Work, () => {
      const marker = join(home(), REFUSED_MARKER);
      if (existsSync(marker)) return undefined;
      writeFileSync(marker, "refused\n");
      return deny("the work needs the owner to say yes");
    });
    api.on(Start, async (data, step) => {
      await step(Work, { n: data.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun feed-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
