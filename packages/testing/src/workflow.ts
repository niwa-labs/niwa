// What the tests of the workflow package need besides the shared helpers: the stub plugin the
// script bridge is checked against, the id a request born in a record of a given name has, and the
// factories of the plugins a workflow reads, which a plugin may reach only through their records.

import { action, issueId, record, recordId } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import type { RequestId } from "@niwa-labs/requests/records";
import { z } from "zod";

import { counter, gate } from "./index.ts";

export { describe } from "@niwa-labs/host";
export { CLEANUP_TIMER, WorktreeRefusal, git } from "@niwa-labs/git";
export { messages } from "@niwa-labs/messages";
export { TaskDone, tasks } from "@niwa-labs/tasks";
export { timer, timerList, timers } from "@niwa-labs/timer";
export { workflow } from "@niwa-labs/workflow";

/** A record a script waits for. */
export const StubFinished = record("stub.finished", z.object({ id: z.string() }));

/** A record a script may emit: the types of a script are `wf.<name>.*`. */
export const WfNote = record("wf.demo.note", z.object({ text: z.string() }));

/** The stub plugin: `stub.bump`, `stub.create`, `stub.finish` and `stub.hold`. Counters and gates live in the home, so they survive a restart of the host. */
export function stub(home: string): Plugin {
  return plugin("stub", (api) => {
    api.declare(StubFinished);
    const bumped = api.state("count", z.number(), 0);
    api.action(
      action("stub.bump", {
        description: "Counts up the state of the plugin.",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: () => ({ count: bumped.update((count) => count + 1) }),
      }),
    );
    api.action(
      action("stub.create", {
        description: "Makes a thing; counts the calls.",
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.string() }),
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: ({ name }) => {
          counter(home, "w1.create").hit();
          return { id: `t-${name}` };
        },
      }),
    );
    api.action(
      action("stub.finish", {
        description: "Finishes a thing: writes the record a script waits for.",
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string() }),
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async ({ id }, ctx) => {
          await ctx.emit(StubFinished, { id });
          return { id };
        },
      }),
    );
    api.action(
      action("stub.hold", {
        description: "Answers when the test opens the gate of its name; counts the calls.",
        input: z.object({ name: z.string() }),
        output: z.object({ name: z.string() }),
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async ({ name }) => {
          counter(home, `w1.hold.${name}`).hit();
          await gate(home, `w1.hold.${name}`).wait();
          return { name };
        },
      }),
    );
  });
}

/** The id niwa would issue to a request born in a record named `name`; a test that writes `request.created` by hand gets the same id for the same name. */
export function requestIdOf(name: string): RequestId {
  return issueId("request", recordId(`test:${name}`), []);
}
