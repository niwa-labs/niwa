// The host program for the scenario "intercept order".
//
// "An adjust changes the input; a guard sees the changed
// input, not the requested one. A denial is recorded with its reason and with both
// inputs, and the action does not run. On a retry the guard is asked again."
//
// The plugin declares one record type, Start, and one action, "intercept-order.send". The
// action writes every call into a file and returns its input, so the check can see
// which calls reached the outside and with what.
//
// Two intercepts are registered on the action:
//
//   - an adjust that puts "adjusted" where the request said "requested";
//   - a guard that refuses the text "forbidden", the first time it is asked.
//
// The guard writes down every time it is asked, and what it saw, so the check can
// see that the guard was asked again on a retry and that it saw the adjusted input
// and not the requested one.
//
// The home directory comes from argv[2]. The test imports this file for the record
// type and the action, so the host only starts when the file is run directly.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { action, deny, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";

/** The record the test writes: it wakes the handler. */
export const Start = record("intercept-order.start", z.object({}), { open: true });

/** The text the guard refuses. */
export const FORBIDDEN = "forbidden";

/** What the request asked for, and what the adjust put there instead. */
export const REQUESTED = "requested";
export const ADJUSTED = "adjusted";

/** The file the guard writes what it saw into. */
export const GUARD_LOG = "guards.log";

/** The file the action writes every call into. */
export const CALL_LOG = "calls.log";

/** The action of this scenario: it writes every call into a file and returns its input. */
export const Send = action("intercept-order.send", {
  description: "Sends something, if the guard allows it.",
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  recovery: "repeat",
  run: (input, ctx) => {
    appendFileSync(join(home(), CALL_LOG), `${input.text}:${ctx.operationId}\n`);
    return { text: input.text };
  },
});

/** The home this program was started with. */
function home(): string {
  return process.argv[2] as string;
}

/** The plugin of this scenario. */
export function makePlugin() {
  // The guard refuses the forbidden text only the first time it is asked: the retry
  // asks it again, and this time it allows the call. So the check sees both that
  // the guard was asked again and that the new attempt went through.
  let refused = 0;

  return plugin("intercept-order", (api) => {
    api.declare(Start);
    api.action(Send);

    // The adjust: it changes the input the action is called with.
    api.adjust(Send, (input) => ({
      text: input.text === REQUESTED ? ADJUSTED : input.text,
    }));

    // The guard: it sees the changed input, and it refuses one text.
    api.guard(Send, (input, ctx) => {
      appendFileSync(join(home(), GUARD_LOG), `${input.text}:${ctx.caller.kind}\n`);
      if (input.text !== FORBIDDEN) return;
      refused += 1;
      if (refused === 1) return deny("not tonight");
    });

    // The handler: it calls the action with a text the request asks for, and then
    // with the text the guard refuses.
    api.on(Start, async (_data, step) => {
      await step(Send, { text: REQUESTED }, { key: "allowed" });
      await step(Send, { text: FORBIDDEN }, { key: "refused" });
    });
  });
}

if (import.meta.main) {
  const homeArg = process.argv[2];
  if (!homeArg) {
    console.error("usage: bun intercept-order-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home: homeArg });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
