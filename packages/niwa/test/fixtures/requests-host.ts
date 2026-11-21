// The host program for the requests test of a kill: the executor asks, the work sleeps, the
// question is in the list of open requests, and an answer continues the work.
//
// The plugin declares Start, which wakes the handler, and Answered, which the handler writes
// once the answer has arrived. The home comes from argv[2]; the test imports this file for the
// record types and the binding, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record, owner } from "@niwa-labs/core";
import type { CallerBinding } from "@niwa-labs/plugin";
import {
  Deadline,
  RequestCancelled,
  RequestExpired,
  requestAsk,
  question,
  requests,
} from "@niwa-labs/requests";
import { z } from "zod";

import { opt } from "@niwa-labs/testing";

/** Wakes the handler. */
export const Start = record(
  "requests.start",
  z.object({ release: z.string(), deadline: Deadline.optional(), gate: z.boolean().optional() }),
  { open: true },
);

/** Lets a handler that was told to hold go on, once the request has ended. */
export const Proceed = record("requests.proceed", z.object({ release: z.string() }), { open: true });

/** The work that continues once the answer has arrived. */
export const Answered = record(
  "requests.answered",
  z.object({ release: z.string(), branch: z.enum(["main", "next"]) }),
);

/** The work that ends because the request was cancelled or expired. */
export const Ended = record(
  "requests.ended",
  z.object({ release: z.string(), ended: z.enum(["cancelled", "expired"]) }),
);

export const ReleaseBranch = question("release.branch", {
  kind: "choice",
  title: "Which branch?",
  options: [opt("main"), opt("next")],
});

/** The label the owner's page connects with; the host adds the number of the connection. */
export const OWNER_CLIENT = "owner-ui";

/** The owner's client speaks as the owner; every other client speaks as itself. */
export const bind: CallerBinding = (caller) => {
  if (caller.kind !== "client") return undefined;
  return caller.id.startsWith(`${OWNER_CLIENT}#`) ? owner : { kind: "client", id: caller.id };
};

/**
 * The executor: asks which branch to release on, and waits.
 *
 * A request with a deadline ends when the time runs out; the error the ask throws is caught
 * here, and what happened is written down, so the test can see it.
 */
export function executor() {
  return plugin("requests-check", (api) => {
    api.declare(Start, Answered, Ended, Proceed);
    api.on(Start, async (data, step) => {
      const deadline = data.deadline;
      try {
        const { answer: raw } = await step(requestAsk, {
          to: owner,
          ...ReleaseBranch,
          input: { ...ReleaseBranch.input, detail: data.release },
          ...(deadline === undefined ? {} : { deadline }),
        });
        await step.emit(Answered, { release: data.release, branch: "ids" in raw && raw.ids[0] === "next" ? "next" : "main" });
      } catch (error) {
        // A held handler waits after the request ended, so the test can restart the host between
        // the end of the request and the end of the handler: the ask is then replayed.
        const hold = async (): Promise<void> => {
          if (data.gate === true) await step.wait(Proceed, (proceed) => proceed.release === data.release);
        };
        if (error instanceof RequestCancelled) {
          await hold();
          await step.emit(Ended, { release: data.release, ended: "cancelled" });
          return;
        }
        if (error instanceof RequestExpired) {
          await hold();
          await step.emit(Ended, { release: data.release, ended: "expired" });
          return;
        }
        throw error;
      }
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (home === undefined) {
    console.error("usage: bun requests-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(requests({ bind }));
  niwa.use(executor());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
