// Live: a workflow that calls agents.
//
// A workflow script makes two agent calls in parallel and one in a pipeline, on the real mcode
// installation. What the scenario expects of niwa:
//
//   1. the run finishes;
//   2. the step keys are distinct: the two calls of the parallel are told apart, and the call
//      of the pipeline has a key of its own;
//   3. the trace joins the run to its steps and to the sessions: one chain.
//
// The second run of the scenario is the other half: a script that fails after the agent calls
// pauses the run with a request, and the owner fixes the script and retries. The retry must not
// ask the agents again: the journal shows the same number of sends to the sessions.
//
// The assertions are on the journal: records, trace and invocation states.
//
// The test is skipped unless NIWA_LIVE=1 and the "mcode" binary is on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { ActionName as NiwaActionName, StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner, runFinishes } from "@niwa-labs/testing";
import { z } from "zod";
import { join } from "node:path";
import { workflow, workflowResume, workflowStart, workflowWait } from "@niwa-labs/workflow";
import { HARNESS, agentHost, dataOf, until as untilRecord } from "./fixtures/agent-host.ts";

const HOST_SCRIPT = new URL("./fixtures/workflow-agents-host.ts", import.meta.url).pathname;

/** The action that starts a run. */
const WORKFLOW_START: NiwaActionName = actionName("workflow.start");

/** The action that waits for a run to finish or pause. */
const WORKFLOW_WAIT: NiwaActionName = actionName("workflow.wait");

/** The action that resolves a paused invocation. */
const RESOLVE: NiwaActionName = actionName("niwa.invocation.resolve");

/** The action that lists what waits. */
const REQUEST_OPEN: NiwaActionName = actionName("request.open");

/** How long a run may take before the test gives up on it. */
const RUN_DEADLINE_MS = 900_000;

/** The prefix the sessions of the harness carry. */
const HARNESS_PREFIX = "mcode-test";

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
  return value === undefined ? (() => { throw new Error(`the ${what} is not there`); })() : value;
}

/** The data of a "workflow.run.finished" record. */
const RunFinishedData = z.object({ run: z.string(), outcome: z.object({ status: z.string(), result: z.unknown().optional() }) });

/** The data of a step intent: the action and the input of the step. */
const StepIntentData = z.object({
  invocation: z.string(),
  key: z.string(),
  action: z.string(),
  input: z.unknown(),
});

/** The data of a step outcome. */
const StepOutcomeData = z.object({
  invocation: z.string(),
  key: z.string(),
  outcome: z.object({ status: z.string() }),
});

/** The data of an invocation state. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
  key: z.string().optional(),
});

/** What "request.open" answers. */
const OpenOutput = z.object({
  requests: z.array(
    z.union([
      z.object({ kind: z.literal("paused"), invocation: z.string(), choices: z.array(z.string()) }),
      z.object({ id: z.string() }).passthrough(),
    ]),
  ),
});

/** Wait until the condition holds; the failure says what was waited for. */
async function until(
  fn: () => boolean | Promise<boolean>,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const untilAt = Date.now() + deadlineMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= untilAt) throw new Error(`${what} did not happen within ${String(deadlineMs)} ms`);
    await Bun.sleep(250);
  }
}

/** The journal as one readable block. */
function journalOf(records: readonly StoredRecord[]): string {
  return records
    .map((record) => `#${String(record.seq)} ${typeOf(record)} ${JSON.stringify(record.data).slice(0, 300)}`)
    .join("\n");
}

test.skipIf(!(live && Bun.which("mcode")))(
  "a workflow that calls agents: the run finishes, the step keys are distinct, and the trace joins the run, the steps and the sessions",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      const startedAt = Date.now();
      const started = z
        .object({ run: z.string(), finished: z.boolean() })
        .parse(await api.call(WORKFLOW_START, { file: new URL("./fixtures/workflow-agents-script.js", import.meta.url).pathname }));
      expect(started.run).not.toBe("");

      // 1. The run finishes: a pause fails the test at once, with its reason.
      await runFinishes(api, started.run, RUN_DEADLINE_MS);
      const elapsedMs = Date.now() - startedAt;

      const records = await api.records.read();
      const finished = must(recordsOf(records, "workflow.run.finished")[0], "record of the finished run");
      const runFinished = RunFinishedData.parse(finished.data);
      expect(runFinished.run).toBe(started.run);

      // 2. The step keys are distinct: the two calls of the parallel are told apart.
      const intents = recordsOf(records, "niwa.step.intent").map((record) =>
        StepIntentData.parse(record.data),
      );
      const agentSteps = intents.filter((entry) => entry.action.startsWith("session.start."));
      const keys = agentSteps.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
      // Three calls: two in the parallel and one in the pipeline.
      expect(agentSteps.length).toBeGreaterThanOrEqual(3);

      // The calls of the parallel carry the labels the script gave them.
      const labelled = agentSteps.filter((entry) => {
        const input = entry.input as { label?: string } | undefined;
        return input?.label !== undefined;
      });
      const labels = labelled.map((entry) => (entry.input as { label: string }).label).sort();
      expect(labels).toEqual(["work:alpha", "work:bravo", "work:charlie"]);

      // Every call ended: none of them is still in flight.
      const outcomes = recordsOf(records, "niwa.step.outcome").map((record) =>
        StepOutcomeData.parse(record.data),
      );
      for (const step of agentSteps) {
        const ended = outcomes.find((entry) => entry.key === step.key);
        expect(ended?.outcome.status).toBe("completed");
      }

      // Three sessions were started: one per call.
      const startedSessions = recordsOf(records, "session.started")
        .map((record) => (record.data as { session: string }).session)
        .filter((session) => session.startsWith(`${HARNESS_PREFIX} `));
      expect(startedSessions).toHaveLength(3);
      expect(new Set(startedSessions).size).toBe(3);

      // 3. The trace joins the run to its steps and to the sessions: one chain. The trace of
      //    the request that started the run reaches the steps it made and the sessions it
      //    called, and every record of it is on one root.
      const runRequested = must(
        recordsOf(records, "workflow.run.requested")[0],
        "record of the request that started the run",
      );
      const traced = await api.trace(runRequested.id);
      const tracedTypes = traced.map((record) => typeOf(record));
      expect(tracedTypes).toContain("niwa.step.intent");
      expect(tracedTypes).toContain("session.started");
      expect(tracedTypes).toContain("workflow.run.finished");
      const roots = new Set(traced.map((record) => String(record.root)));
      expect(roots.size).toBe(1);
      expect(String(must(traced[0], "the record the trace started from").root)).toBe(
        String(runRequested.id),
      );

      console.log(`live timings: the run finished in ${String(elapsedMs)} ms`);
      console.log(`result: ${JSON.stringify(runFinished.outcome.result)}`);
    } finally {
      await api?.close().catch(() => undefined);
      // A clean stop: the host disposes its harness children, which run in process groups of
      // their own and would outlive a SIGKILL of the host.
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  RUN_DEADLINE_MS + 300_000,
);

test.skipIf(!(live && Bun.which("mcode")))(
  "a script that fails after the agent calls: the run pauses, and the retry finishes without asking the agents again",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      // The script fails after its agent calls, unless the flag file exists.
      const flag = `${home.path}/fixed`;
      const script = `${home.path}/workflow-agents-broken.js`;
      await Bun.write(
        script,
        [
          'export default workflow({ uses: ["session.start.mcode-test"], output: z.json() }, async () => {',
          '  const first = await ask({ harness: "mcode-test", label: "work:alpha" }, \'Answer with exactly this JSON: {"answer":"alpha"}\');',
          '  const second = await ask({ harness: "mcode-test", label: "work:bravo" }, \'Answer with exactly this JSON: {"answer":"bravo"}\');',
          `  if (!(await Bun.file(${JSON.stringify(flag)}).exists())) throw new Error("the script is broken");`,
          "  return { first, second };",
          '});',
          "",
        ].join("\n"),
      );

      const started = z
        .object({ run: z.string(), finished: z.boolean() })
        .parse(await api.call(WORKFLOW_START, { file: script }));

      // The run pauses: the failure of the script is a decision the owner makes.
      const waited = z
        .object({ state: z.string(), reason: z.string().optional() })
        .parse(await api.call(WORKFLOW_WAIT, { run: started.run, timeoutMs: RUN_DEADLINE_MS }));
      expect(waited.state).toBe("paused");
      expect(waited.reason).toContain("the script is broken");
      const pausedRecords = await api.records.read();

      // The pause is a request the owner sees.
      const open = OpenOutput.parse(await api.call(REQUEST_OPEN, {}));
      const openPauses = open.requests.filter((entry) => entry.kind === "paused");
      expect(openPauses).toHaveLength(1);
      expect(openPauses[0]?.choices).toEqual(["retry", "cancel"]);

      // How many sessions were started before the pause: the two calls of the script.
      const sessionsBefore = recordsOf(pausedRecords, "session.started").length;
      expect(sessionsBefore).toBe(2);

      // The script is fixed and the owner retries: the run finishes.
      await Bun.write(flag, "1");
      await api.call(RESOLVE, { invocation: openPauses[0]?.invocation, choice: "retry" });

      await runFinishes(api, started.run, RUN_DEADLINE_MS);
      const after = await api.records.read();

      // The retry did not ask the agents again: the same number of sessions, and the same
      // number of sends to the sessions.
      const sessionsAfter = recordsOf(after, "session.started").length;
      if (sessionsAfter !== sessionsBefore) {
        console.log(`sessions before ${String(sessionsBefore)}, after ${String(sessionsAfter)}`);
        console.log(`journal:\n${journalOf(after)}`);
      }
      expect(sessionsAfter).toBe(sessionsBefore);

      // The sends to the sessions: the question of each session was asked once, and no more.
      // The workflow asks a session with "session.ask", so that is what the journal shows.
      const asks = recordsOf(after, "niwa.step.intent").filter(
        (record) => (record.data as { action?: string }).action === "session.ask",
      );
      expect(asks.length).toBe(sessionsBefore);

      // The run finished with the result of the script.
      const finished = must(recordsOf(after, "workflow.run.finished")[0], "record of the finished run");
      expect(RunFinishedData.parse(finished.data).run).toBe(started.run);

      // The pause is gone: nothing waits any more.
      const openAfter = OpenOutput.parse(await api.call(REQUEST_OPEN, {}));
      expect(openAfter.requests.filter((entry) => entry.kind === "paused")).toHaveLength(0);

      console.log(`second run: the retry finished without asking the agents again (${String(sessionsAfter)} sessions)`);
    } finally {
      await api?.close().catch(() => undefined);
      // A clean stop: the host disposes its harness children, which run in process groups of
      // their own and would outlive a SIGKILL of the host.
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  RUN_DEADLINE_MS * 2 + 300_000,
);

test("agent(name).tell writes to the named mailbox once across a workflow replay", async () => {
  const agent = { name: "rin", harness: HARNESS, prompt: "Coordinate the project." };
  const host = await agentHost({ agents: [agent] }, { after: [workflow()] });
  try {
    const file = join(host.home, "tell.js");
    await Bun.write(file, 'export default workflow({ uses: ["agent.tell"], output: z.json() }, async () => agent("rin").tell("Review the plan.", { label: "report" }));');
    const { run } = await host.host.call(workflowStart, { file, wait: true, timeoutMs: 5_000 });
    expect((await host.host.call(workflowWait, { run, timeoutMs: 5_000 })).outcome).toMatchObject({ status: "done", result: { message: expect.any(String) } });
    const records = await untilRecord(host.records, "agent.turn.delivered");
    expect(dataOf(records, "agent.turn.queued")).toMatchObject([{ agent: "rin", author: { kind: "client", id: `run:${run}` }, text: "Review the plan." }]);
    await host.host.call(workflowResume, { run });
    await host.host.call(workflowWait, { run, timeoutMs: 5_000 });
    expect(dataOf(await host.records(), "agent.turn.queued")).toHaveLength(1);
    expect(host.control.starts).toHaveLength(1);
  } finally {
    await host.close();
  }
}, 30_000);
