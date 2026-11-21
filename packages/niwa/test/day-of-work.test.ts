// A day's work.
//
// A workflow script sends five tiny studies to agents in two harnesses (MiniMax Code on
// M3.1, Claude Code on haiku), in parallel. One study is given a wrong instruction on
// purpose; the script checks the results, finds the answer that holds no three lines, and
// sends that study again with the right instruction. Then a merge agent gets the five
// results and returns one list.
//
// Nobody intervenes: the run finishes on its own.
//
// The run is a real one: a host process on a temporary home, the workflow module of that
// host, and real MiniMax Code and Claude Code sessions behind it.
//
// The test is skipped unless NIWA_LIVE=1 and the "mcode" and "claude" binaries are on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner, runFinishes } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = new URL("./fixtures/day-host.ts", import.meta.url).pathname;

/** The script of the day. */
const SCRIPT = new URL("./fixtures/day.workflow.js", import.meta.url).pathname;

/** The harnesses the studies run in. */
const MCODE_HARNESS = "mcode-test";
const CLAUDE_HARNESS = "claude-test";

/** The topics of the day's studies. */
const TOPICS = ["tides", "sourdough", "rainbows", "toucans", "volcanoes"];

/** The topic whose study is given the wrong instruction. */
const WRONG_TOPIC = "rainbows";

/** How long the whole run may take before the test gives up on it. */
const RUN_DEADLINE_MS = 900_000;

/** What "workflow.start" answers. */
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

/** The data of a "workflow.run.finished" record: how the run ended. */
const RunFinished = z.object({
  run: z.string(),
  outcome: z.object({ status: z.enum(["done", "failed", "cancelled"]), result: z.unknown().optional() }),
});

/** The result the script returned: the topics of the day and the merged list. */
const DayResult = z.object({ topics: z.array(z.string()), merged: z.string() });

/** The data of a "niwa.step.intent" record: the call a step made. */
const StepIntent = z.object({
  key: z.string(),
  action: z.string(),
  input: z.unknown(),
});

/** The data of a "niwa.step.outcome" record: what the call answered. */
const StepOutcome = z.object({
  key: z.string(),
  outcome: z.object({
    status: z.string(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
});

/** The type of a record, as a plain string. */
function typeOf(record: StoredRecord): string {
  return String(record.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((record) => typeOf(record) === type);
}

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/**
 * Wait until the run ends, and give the journal as it is then.
 *
 * A run that pauses waits for a decision that nobody gives, so the wait ends there too: the
 * failure says what the run was waiting for, and what the call that failed answered.
 */
async function untilRunEnds(
  api: Awaited<ReturnType<typeof connect>>,
  run: string,
  deadlineMs: number,
): Promise<StoredRecord[]> {
  const records = () => api.records.read();
  try {
    await runFinishes(api, run, deadlineMs);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${failuresOf(await records())}`);
  }
  return records();
}

/** The calls of the run that failed, and what they said. */
function failuresOf(records: readonly StoredRecord[]): string {
  const lines = recordsOf(records, "niwa.step.outcome").flatMap((record) => {
    const outcome = StepOutcome.safeParse(record.data);
    if (!outcome.success || outcome.data.outcome.status !== "failed") return [];
    const error = outcome.data.outcome.error ?? "";
    return [`  the call "${outcome.data.key}" failed: ${error}`];
  });
  return lines.length === 0 ? "  no call failed" : lines.join("\n");
}

test.skipIf(!(live && Bun.which("mcode") && Bun.which("claude")))(
  "a day's work: five studies in two harnesses, one corrected, one merged, and nobody intervenes",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      // The run starts: the script runs on its own, from the top.
      const startedAt = Date.now();
      const started = RunOutput.parse(
        await api.call(actionName("workflow.start"), { file: SCRIPT, label: "day" }),
      );
      expect(started.run).not.toBe("");

      // The run finishes by itself: nobody answers a request, nothing is retried.
      const records = await untilRunEnds(api, started.run, RUN_DEADLINE_MS);
      const elapsedMs = Date.now() - startedAt;

      const finished = RunFinished.parse(
        must(recordsOf(records, "workflow.run.finished")[0], "the finished run").data,
      );
      expect(finished.run).toBe(started.run);
      expect(finished.outcome.status).toBe("done");

      // The journal tells the whole story: the calls of the run are steps of its invocation.
      const intents = recordsOf(records, "niwa.step.intent").map((record) =>
        StepIntent.parse(record.data),
      );
      const outcomes = recordsOf(records, "niwa.step.outcome").map((record) =>
        StepOutcome.parse(record.data),
      );

      // Five studies went out, in parallel, in two harnesses. The keys of the calls are the
      // labels of the script, kept as "label:study:<topic>", and the nested steps of a call hold a dot, and the hold of its grant a `~`.
      const studyCalls = intents.filter((intent) => /^label:study:[^:.~]+$/.test(intent.key));
      expect(studyCalls).toHaveLength(5);
      const harnessesOfStudies = new Set(
        studyCalls.map((intent) => (intent.input as { harness?: string }).harness),
      );
      expect(harnessesOfStudies).toEqual(new Set([MCODE_HARNESS, CLAUDE_HARNESS]));

      // One of them was corrected: the study was sent again, under a key of its own.
      const correctionCalls = intents.filter((intent) => intent.key === `label:study:${WRONG_TOPIC}:fixed`);
      expect(correctionCalls).toHaveLength(1);

      // And the merge happened once, at the end.
      const mergeCalls = intents.filter((intent) => intent.key === "label:merge:day");
      expect(mergeCalls).toHaveLength(1);

      // The five studies, the correction and the merge all finished.
      const finishedKeys = new Set(
        outcomes.filter((outcome) => outcome.outcome.status === "completed").map((outcome) => outcome.key),
      );
      for (const intent of [...studyCalls, ...correctionCalls, ...mergeCalls]) {
        expect(finishedKeys.has(intent.key)).toBe(true);
      }

      // The run did not pause: nobody had to answer anything.
      expect(recordsOf(records, "workflow.run.paused")).toHaveLength(0);

      // The merged result mentions every topic of the day.
      const day = DayResult.parse(finished.outcome.result);
      expect(day.topics).toEqual(TOPICS);
      for (const topic of TOPICS) {
        expect(day.merged.toLowerCase()).toContain(topic.toLowerCase());
      }

      console.log(
        `live timings: run ${String(elapsedMs)} ms, ` +
          `study calls ${String(studyCalls.length)}, correction ${String(correctionCalls.length)}, ` +
          `merge ${String(mergeCalls.length)}, sessions started ${String(recordsOf(records, "session.started").length)}`,
      );
      console.log(`merged result: ${day.merged.slice(0, 800)}`);
    } finally {
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  RUN_DEADLINE_MS + 120_000,
);
