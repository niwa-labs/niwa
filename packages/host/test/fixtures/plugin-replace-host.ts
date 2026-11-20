// The host program for the scenario "replacing a plugin".
//
// "With one invocation waiting, replace the plugin with a changed
// handler. The waiting invocation finishes on the old code. A new record is handled by the new
// code. Unload the plugin: its handlers no longer run and every record it wrote is still
// readable."
//
// The host runs plugin "p" in two versions with the same name and different code:
//
//   v1: on Start { n } — wait for Answer { n }, then step("v1-finish")
//   v2: on Start { n } — step("v2-run"), wait for Answer { n }, then step("v2-finish")
//
// The two versions are the same plugin name with changed code, so the host keeps both: an
// invocation admitted on v1 finishes on v1, and a record admitted later starts on v2: an
// invocation is pinned to the version of the plugin it started on.
//
// A second plugin, "fixture-control", registers two actions that the test calls through the
// public API:
//
//   "fixture.upgrade" — niwa.use(v2), the replacement of plugin "p"
//   "fixture.unload"  — niwa.unload("p")
//
// The control plugin also declares the two record types. That is deliberate: after the unload,
// plugin "p" is gone and its declarations are gone with it, and the test still has to be able to
// emit a Start record to show that no handler of "p" runs any more.
//
// The home directory comes from argv[2]. The test imports this file for the record types and the
// two control actions, so the host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { Plugin } from "@niwa-labs/plugin";
import { stubAction } from "@niwa-labs/testing";
import { z } from "zod";

/** The external input that wakes plugin "p". */
export const Start = record("plugin-replace.start", z.object({ n: z.number() }), { open: true });

/** The answer plugin "p" waits for. */
export const Answer = record("plugin-replace.answer", z.object({ n: z.number() }), { open: true });

/** The shape of the input of the two control actions. */
const NoInput = z.object({});

/** The shape of the output of the two control actions. */
const Ok = z.object({ ok: z.boolean() });

/** The host this program runs, and the two versions of plugin "p". */
let host: Host | undefined;
let pV1: Plugin | undefined;
let pV2: Plugin | undefined;

/** Replace plugin "p" with the changed version of the same plugin. */
export const upgrade = action("fixture.upgrade", {
  description: "Replace plugin p with its changed version.",
  input: NoInput,
  output: Ok,
  recovery: "repeat",
  run: async () => {
    if (host === undefined || pV2 === undefined) {
      throw new Error("fixture.upgrade: the host is not running");
    }
    host.use(pV2);
    return { ok: true };
  },
});

/** Unload plugin "p". Its registrations go; the records it wrote stay. */
export const unload = action("fixture.unload", {
  description: "Unload plugin p.",
  input: NoInput,
  output: Ok,
  recovery: "repeat",
  run: async () => {
    if (host === undefined || pV1 === undefined) {
      throw new Error("fixture.unload: the host is not running");
    }
    host.unload(pV1.name);
    return { ok: true };
  },
});

/**
 * The control plugin. It registers the two actions above, and it declares the two record types
 * so that they survive the unload of plugin "p".
 */
const control = plugin("fixture-control", (api) => {
  api.declare(Start, Answer);
  api.action(upgrade);
  api.action(unload);
});

/**
 * The two versions of plugin "p". Same name, changed code, so the host keeps both versions and
 * the work in flight is pinned to the one it started on.
 */
function buildPlugins(home: string): { v1: Plugin; v2: Plugin } {
  const v1Finish = stubAction("v1-finish", {
    home,
    input: z.object({ n: z.number() }),
    output: Ok,
    recovery: "repeat",
    result: () => ({ ok: true }),
  });

  const v2Run = stubAction("v2-run", {
    home,
    input: z.object({ n: z.number() }),
    output: Ok,
    recovery: "repeat",
    result: () => ({ ok: true }),
  });

  const v2Finish = stubAction("v2-finish", {
    home,
    input: z.object({ n: z.number() }),
    output: Ok,
    recovery: "repeat",
    result: () => ({ ok: true }),
  });

  // Version 1: wait for the answer, then finish.
  const v1 = plugin("p", (api) => {
    api.declare(Start, Answer);
    api.action(v1Finish);
    api.on(Start, async (data, step) => {
      await step.wait(Answer, (answer) => answer.n === data.n);
      await step(v1Finish, { n: data.n });
    });
  });

  // Version 2: run first, then wait for the answer, then finish.
  const v2 = plugin("p", (api) => {
    api.declare(Start, Answer);
    api.action(v2Run);
    api.action(v2Finish);
    api.on(Start, async (data, step) => {
      await step(v2Run, { n: data.n });
      await step.wait(Answer, (answer) => answer.n === data.n);
      await step(v2Finish, { n: data.n });
    });
  });

  return { v1, v2 };
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun plugin-replace-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  host = niwa;

  const plugins = buildPlugins(home);
  pV1 = plugins.v1;
  pV2 = plugins.v2;

  niwa.use(pV1);
  niwa.use(control);

  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
