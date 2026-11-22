import { expect, test } from "bun:test";
import { CORE_TYPES, recordId, seq } from "@niwa-labs/core";
import type { JournalReader, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { requestAsk } from "@niwa-labs/requests/records";
import { SessionStarted } from "@niwa-labs/sessions/records";

import { WorkflowInspection, inspectRun } from "../src/inspect.ts";
import { inspectAction } from "../src/cockpit/actions.ts";
import { WAIT_NAME } from "../src/bridge.ts";
import { PhaseEntered, RunFinished, RunId, RunRequested, RunStarted, StepPhase } from "../src/records.ts";
import { runEntry, statusOf } from "../src/status.ts";

function fixture() {
  const run = RunId.parse("run-58a60f");
  let invocation = "workflow/fixture";
  const records: StoredRecord[] = [];
  const journal: JournalReader = {
    get: (id) => records.find((row) => row.id === id),
    find: ({ type, field, equals, after = 0 }) => records.filter((row) =>
      row.type === type && row.seq > after && (field === undefined || (row.data as Record<string, unknown>)[field] === equals)),
    since: (from, types) => records.filter((row) => row.seq > from && (types === undefined || types.includes(row.type))),
    last: () => seq(records.length),
    query: () => { throw new Error("Unexpected query"); },
    tail: () => { throw new Error("Unexpected tail"); },
  };
  function add(type: RecordTypeName, data: Record<string, unknown>, identifier = String(records.length)) {
    const id = recordId(identifier);
    records.push({
      id, type, data: { invocation, ...data }, seq: seq(records.length + 1), cause: null, root: id,
      actor: { kind: "handler", handler: "workflow/run", invocation },
      at: 1_700_000_000_000 + records.length, schema: 1, stream: "main",
    } as StoredRecord);
  }
  const file = "example.js";
  const phases = [{ title: "agent" }, { title: "parallel wait" }];
  add(RunRequested.name, { run, file, args: {}, phases });
  add(RunStarted.name, { run, file, args: {}, phases });
  const agent = "p1.0.label:ask";
  const parallel = "p1.1.label:event";
  add(PhaseEntered.name, { run, branch: "p1.0", phase: "agent" });
  add(PhaseEntered.name, { run, branch: "p1.1", phase: "parallel wait" });
  add(StepPhase.name, { run, key: agent, phase: "agent" });
  add(StepPhase.name, { run, key: parallel, phase: "parallel wait" });
  function intent(key: string, action: string, input: unknown, attempt = 1) {
    const operationId = invocation + "/" + key + (attempt === 1 ? "" : "#" + attempt);
    const base = invocation + "/step/" + key + (attempt === 1 ? "" : "/attempt/" + attempt);
    add(CORE_TYPES.stepIntent, { key, action, input, operationId }, base + "/intent");
    return {
      session: (id: string) => add(SessionStarted.name, { run, id, session: "codex-sol native-" + id }, operationId + "/emit/1"),
      end: (status: string, value?: unknown) => add(CORE_TYPES.stepOutcome, { key, outcome: { status, value } }, base + "/outcome"),
    };
  }
  function startAgent(attempt: number, id: string) {
    const owner = intent(agent, "session.start.codex-sol", { prompt: "work" }, attempt);
    const namespace = agent + (attempt === 1 ? "" : "." + attempt);
    const launch = intent(namespace + ".step-1", "session.start", {});
    launch.session(id);
    launch.end("completed");
    return owner;
  }
  function restart() {
    invocation = "workflow/restart";
    add(RunRequested.name, { run, file, args: {}, phases });
    add(RunStarted.name, { run, file, args: {}, phases });
    add(PhaseEntered.name, { run, branch: "p1.0", phase: "agent" });
    add(StepPhase.name, { run, key: agent, phase: "agent" });
  }
  return { run, journal, add, intent, startAgent, agent, parallel, restart };
}

test("retry keeps both session attempts and ignores a still-open wait owned by the unknown attempt", () => {
  const { run, journal, add, intent, startAgent, agent, parallel } = fixture();
  const historical = startAgent(1, "s-a795ed");
  intent(agent + ".wait-1", WAIT_NAME, { type: "session.old" });
  historical.end("unknown");
  add(CORE_TYPES.invocationResolved, { key: agent, attempt: 0, choice: "retry" });
  expect(inspectRun(journal, run)?.status.waiting).toBeUndefined();

  const current = startAgent(2, "s-d550d1");
  const event = intent(parallel, WAIT_NAME, { type: "test.release" });
  add(CORE_TYPES.invocationState, { state: "waiting" });

  const inspect = () => WorkflowInspection.parse(inspectRun(journal, run));
  const active = inspect();
  expect(active.status.waiting).toBe("session codex-sol s-d550d1");
  expect(statusOf(journal, run).waiting).toBe(active.status.waiting);
  expect(runEntry(journal, run).waiting).toBe(active.status.waiting);
  expect(inspectAction.output.parse(active).phases[0]?.steps.map((step) => step.historical)).toEqual([true, undefined]);
  expect(active.sessions.map((session) => session.id)).toEqual(["s-a795ed", "s-d550d1"]);
  expect(active.phases[0]?.steps).toMatchObject([
    { status: "unknown", historical: true, session: "s-a795ed", branch: "p1.0", endedAt: expect.any(String) },
    { status: "running", session: "s-d550d1", branch: "p1.0" },
  ]);
  expect(active.phases[0]?.steps[0]?.id).not.toBe(active.phases[0]?.steps[1]?.id);
  expect(active.phases[1]?.steps).toMatchObject([{ status: "running", waitEvent: "test.release", branch: "p1.1" }]);

  current.end("completed");
  expect(inspect().status.waiting).toBe("wait test.release");
  event.end("completed");
  add(RunFinished.name, { run, outcome: { status: "done", result: null } });
  const finished = inspect();
  expect(finished.status.waiting).toBeUndefined();
  expect(finished.status.state).toBe("finished");
  expect(finished.phases.flatMap((phase) => phase.steps).map((step) => step.status)).toEqual(["unknown", "completed", "completed"]);
});

test("retry resolution retires an open attempt before the new intent and cancellation affects the current attempt", () => {
  const { run, journal, add, startAgent, agent } = fixture();
  startAgent(1, "s-a795ed");
  add(CORE_TYPES.invocationResolved, { key: agent, attempt: 0, choice: "retry" });
  expect(inspectRun(journal, run)?.phases[0]?.steps).toMatchObject([
    { status: "unknown", historical: true, session: "s-a795ed" },
  ]);
  expect(statusOf(journal, run).waiting).toBeUndefined();

  startAgent(2, "s-d550d1");
  add(RunFinished.name, { run, outcome: { status: "cancelled" } });
  const inspected = inspectRun(journal, run);
  expect(inspected?.status.waiting).toBeUndefined();
  expect(inspected?.phases[0]?.steps).toMatchObject([
    { status: "unknown", historical: true, session: "s-a795ed" },
    { status: "cancelled", endedAt: expect.any(String), session: "s-d550d1" },
  ]);
});

test("restarting a run keeps prior invocation rows and waits for the current invocation", () => {
  const { run, journal, startAgent, restart } = fixture();
  startAgent(1, "s-a795ed");
  restart();
  startAgent(1, "s-d550d1");
  const inspected = inspectRun(journal, run);
  expect(inspected?.status.waiting).toBe("session codex-sol s-d550d1");
  expect(inspected?.phases[0]?.steps).toMatchObject([
    { status: "unknown", historical: true, session: "s-a795ed" },
    { status: "running", session: "s-d550d1" },
  ]);
});

test("the end of an old owner question remains with that attempt after a new one starts", () => {
  const { run, journal, intent, agent } = fixture();
  intent(agent, requestAsk.name, {});
  intent(agent + "~ended", "workflow.ask.ended", {}).end("completed", { ended: "expired" });
  intent(agent, requestAsk.name, {}, 2);
  const inspected = inspectRun(journal, run);
  expect(inspected?.phases[0]?.steps).toMatchObject([
    { status: "failed", historical: true, endedAt: expect.any(String) },
    { status: "running" },
  ]);
  expect(inspected?.status.waiting).toBe("call request.ask");
});
