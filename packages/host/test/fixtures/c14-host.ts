// The host program for check C14 (shadow run).
//
// One plugin, one record type that wakes it, one handler. The handler calls the action "say" with
// the title, reads and changes its state, and writes the message down as a record.
//
// Versions of the plugin, with the same name so the host can hold them apart:
//
//   original    says the title, writes "done: <title>"
//   reworded    says the same, writes "finished: <title>": only the record it writes differs
//   padded      calls "say" with a key the schema strips: the final input is the recorded one
//   extra       also calls "notify", which was never called before and has no simulator
//   simulated   the same, but "notify" declares a simulator
//
// "say" has an adjust that appends "!" to the text.
//
// The actions count their calls, so a shadow run that called one would be visible.
//
// The home directory comes from argv[2]. The test imports this file for the record types, so the
// host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { PluginApi } from "@niwa-labs/plugin";
import { counter, stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** Wakes the handler. */
export const Task = record("c14.task", z.object({ title: z.string() }), { open: true });

/** What the handler wrote down: the message it said. */
export const Said = record("c14.said", z.object({ text: z.string() }));

export type Version = "original" | "reworded" | "padded" | "extra" | "simulated";

/** The plugin, in the version the test asks for. */
export function makePlugin(home: string, version: Version) {
  const say = stubAction("say", {
    home,
    input: z.object({ text: z.string() }),
    output: z.object({ said: z.string() }),
    recovery: "repeat",
    result: (input) => ({ said: input.text }),
  });

  const notified = counter(home, "notify");
  const notify = action("notify", {
    description: "Tell somebody something.",
    input: z.object({ text: z.string() }),
    output: z.object({ told: z.string() }),
    recovery: "repeat",
    run: (input) => {
      notified.hit();
      return { told: input.text };
    },
    ...(version === "simulated"
      ? { simulate: (input: { text: string }) => ({ told: `simulated: ${input.text}` }) }
      : {}),
  });

  const setup = (api: PluginApi) => {
    api.declare(Task, Said);
    api.action(say);
    api.action(notify);
    // An intercept: what "say" runs with is not what the handler asked for. The journal records
    // the final input, so that is what a shadow run has to compare.
    api.adjust(say, (input) => ({ text: `${input.text}!` }));

    // A shadow run changes this too, and that must reach neither the journal nor the host.
    const sent = api.state("sent", z.array(z.string()), []);
    api.action(
      action("peek", {
        description: "The messages the plugin has sent.",
        input: z.object({}),
        output: z.array(z.string()),
        recovery: "repeat",
        run: () => sent.get(),
      }),
    );

    api.on(Task, async (data, step) => {
      // The final input is what is compared: "loud" is stripped by the schema of "say".
      const said = version === "padded" ? { text: data.title, loud: true } : { text: data.title };
      await step(say, said);
      if (version === "extra" || version === "simulated") await step(notify, { text: data.title });
      const text = `${version === "reworded" ? "finished" : "done"}: ${data.title}`;
      sent.update((messages) => [...messages, text]);
      await step.emit(Said, { text });
    });
  };

  return plugin("c14", setup, { version });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun c14-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  // The versions are installed: the host pins every version it is given, so the shadow run
  // has the code of each of them to run. The last one installed handles the new records, so the
  // "original" is installed last and the recorded run is the one the check compares with.
  for (const version of ["reworded", "padded", "extra", "simulated"] as const) {
    niwa.use(makePlugin(home, version));
  }
  niwa.use(makePlugin(home, "original"));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
