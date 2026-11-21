// Workflow revision: a call fails and the run pauses with a request. The script is edited and resumed
// as a revision. Unchanged calls reuse their results, the changed call runs, and a changed input
// under an old key is shown rather than silently rerun.
//
// The scenario runs against a real host process (test/fixtures/revision-host.ts):
//
//   1. the script makes one call that finishes and one that fails: the run pauses with a request
//      that offers retry, skip and cancel
//   2. the script is edited: the first call is unchanged, the second has another prompt under
//      the same key
//   3. the revision says what is reused, what runs again, and what is shown
//   4. the call that was shown is not run again
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/revision-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/revision-script.js", import.meta.url));
const EDITED_SCRIPT = fileURLToPath(new URL("./fixtures/revision-script-edited.js", import.meta.url));
const FIXED_SCRIPT = fileURLToPath(new URL("./fixtures/revision-script-fixed.js", import.meta.url));

/** What the workflow actions answer. */
const RunOutput = z.object({
  run: z.string(),
  finished: z.boolean(),
  result: z.unknown().optional(),
});

/** The report of a revision. */
const Revision = z.object({
  reused: z.array(
    z.object({ key: z.string(), action: z.string(), input: z.unknown(), outcome: z.unknown() }),
  ),
  rerun: z.array(
    z.object({
      key: z.string(),
      action: z.string(),
      input: z.unknown(),
      reason: z.enum(["new key", "unfinished"]),
    }),
  ),
  shown: z.array(
    z.object({
      key: z.string(),
      recordedAction: z.string(),
      recordedInput: z.unknown(),
      action: z.string(),
      input: z.unknown(),
    }),
  ),
});

/** What the revision action answers. */
const ReviseOutput = RunOutput.extend({ revision: Revision });

/** What the resume action answers. */
const ResumeOutput = RunOutput.extend({ revision: Revision.optional() });

/** The state of an invocation, as the journal holds it. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

/** The paused invocations of the run. */
function pausedOf(records: StoredRecord[]): Array<z.infer<typeof InvocationState>> {
  const paused: Array<z.infer<typeof InvocationState>> = [];
  for (const record of records) {
    if (record.type !== "niwa.invocation.state") continue;
    const data = InvocationState.safeParse(record.data);
    if (!data.success) continue;
    if (data.data.state !== "paused") continue;
    paused.push(data.data);
  }
  return paused;
}

/** The pause of a workflow run, as the journal holds it. */
const RunPaused = z.object({
  run: z.string(),
  reason: z.string(),
  key: z.string().optional(),
  choices: z.array(z.string()).optional(),
  shown: z
    .array(
      z.object({
        key: z.string(),
        recordedAction: z.string(),
        recordedInput: z.unknown(),
        action: z.string(),
        input: z.unknown(),
      }),
    )
    .optional(),
});

/** The pauses of the workflow runs. */
function runPausesOf(records: StoredRecord[]): Array<z.infer<typeof RunPaused>> {
  const pauses: Array<z.infer<typeof RunPaused>> = [];
  for (const record of records) {
    if (record.type !== "workflow.run.paused") continue;
    const data = RunPaused.safeParse(record.data);
    if (data.success) pauses.push(data.data);
  }
  return pauses;
}

test("Workflow revision: unchanged calls are reused, and a changed input under an old key is shown", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);

    const watcher = await connectAsOwner(homePath);
    const records: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of watcher.records.since(0 as never)) {
        records.push(record);
      }
    })().catch(() => undefined);

    // 1. The script runs: the first call finishes, the second fails and the run pauses.
    const started = RunOutput.parse(
      await client.call("workflow.start" as never, { file: SCRIPT } as never),
    );

    await eventually(
      () => pausedOf(records).length > 0,
      20_000,
      "the run should have paused",
    );

    // The pause is a request: it offers the choices of the core.
    const paused = pausedOf(records)[0];
    expect(paused?.choices).toEqual(["retry", "skip", "cancel"]);

    // The first call finished; the second failed.
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // 2. The script is edited: the first call is the same, the second has another prompt under
    //    the same key.
    const edited = `${homePath}/revision-edited.js`;
    await Bun.write(edited, await Bun.file(EDITED_SCRIPT).text());

    // 3. The revision says what it found.
    const revised = ReviseOutput.parse(
      await client.call("workflow.revise" as never, { run: started.run, file: edited } as never),
    );

    // The unchanged call is reused: its key, its input and its recorded result.
    const reused = revised.revision.reused.find((entry) => entry.key === "label:work:first");
    expect(reused).toBeDefined();
    expect((reused?.input as { prompt?: string } | undefined)?.prompt).toBe("Study the core.");
    expect(reused?.outcome).toBeDefined();

    // The changed input under the old key is shown: it is not rerun.
    const shown = revised.revision.shown.find((entry) => entry.key === "label:work:second");
    expect(shown).toBeDefined();
    expect((shown?.recordedInput as { prompt?: string } | undefined)?.prompt).toBe(
      "This one will fail.",
    );
    expect((shown?.input as { prompt?: string } | undefined)?.prompt).toBe(
      "This one will fail, differently.",
    );

    // Nothing was rerun by the revision.
    expect(revised.revision.rerun.length).toBe(0);

    // 4. The call that was shown was not run again, and no new run was started.
    expect(counter(homePath, "revision.agent").count()).toBe(2);
    expect(records.filter((record) => record.type === "workflow.run.started").length).toBe(1);

    // 5. The script is fixed with a new key for the failing call: the first call is reused, the
    //    new key runs, and the run ends with a complete result.
    const fixed = `${homePath}/revision-fixed.js`;
    await Bun.write(fixed, await Bun.file(FIXED_SCRIPT).text());
    const rerevised = ReviseOutput.parse(
      await client.call("workflow.revise" as never, { run: started.run, file: fixed } as never),
    );
    expect(rerevised.revision.reused.map((entry) => entry.key)).toEqual(["label:work:first"]);
    expect(rerevised.revision.rerun.map((entry) => entry.key)).toEqual(["label:work:second-fixed"]);
    expect(rerevised.revision.shown).toEqual([]);

    await eventually(
      () => records.some((record) => record.type === "workflow.run.finished"),
      30_000,
      "the revised run should have finished",
    );
    const finished = records.find((record) => record.type === "workflow.run.finished");
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      first: { answer: "answered: Study the core." },
      second: { answer: "answered: This one will work." },
    });
    // The first call was answered from the journal, not repeated: only the new call ran.
    expect(counter(homePath, "revision.agent").count()).toBe(3);

    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("Workflow resume: an edited script is a revision, and the changed key is shown", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);

    const watcher = await connectAsOwner(homePath);
    const records: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of watcher.records.since(0 as never)) {
        records.push(record);
      }
    })().catch(() => undefined);

    // 1. The script runs from a file of its own, so the file can be edited in place.
    const script = `${homePath}/revision-resumed.js`;
    await Bun.write(script, await Bun.file(SCRIPT).text());
    const started = RunOutput.parse(
      await client.call("workflow.start" as never, { file: script } as never),
    );

    await eventually(
      () => pausedOf(records).length > 0,
      20_000,
      "the run should have paused",
    );
    // The first call finished; the second failed.
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // 2. The script is edited in place: the second call has another prompt under the same key.
    await Bun.write(script, await Bun.file(EDITED_SCRIPT).text());

    // 3. The run is resumed, not revised: the resume finds the edit and shows the changed key.
    const resumed = ResumeOutput.parse(
      await client.call("workflow.resume" as never, { run: started.run } as never),
    );

    const shown = resumed.revision?.shown.find((entry) => entry.key === "label:work:second");
    expect(shown).toBeDefined();
    expect((shown?.recordedInput as { prompt?: string } | undefined)?.prompt).toBe(
      "This one will fail.",
    );
    expect((shown?.input as { prompt?: string } | undefined)?.prompt).toBe(
      "This one will fail, differently.",
    );

    // The unchanged call is reused, and nothing runs again.
    expect(resumed.revision?.rerun.length).toBe(0);
    expect(counter(homePath, "revision.agent").count()).toBe(2);

    // 4. The run pauses on the shown key, and no second run was started.
    await eventually(
      () => runPausesOf(records).some((pause) => pause.key === "label:work:second"),
      20_000,
      "the run should have paused on the shown key",
    );
    const pause = runPausesOf(records).find((entry) => entry.key === "label:work:second");
    expect(pause?.shown?.map((entry) => entry.key)).toEqual(["label:work:second"]);
    expect(records.filter((record) => record.type === "workflow.run.started").length).toBe(1);

    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
