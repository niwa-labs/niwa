import { expect, test } from "bun:test";
import { callKey, CockpitProvider, createRecordStream, createViewer, definePlugin, httpHostClient, loadPlugins } from "@niwa-labs/cockpit-sdk";
import { CORE_TYPES, recordId, seq, type JournalReader, type RecordTypeName, type StoredRecord } from "@niwa-labs/core";
import { SessionEnded, SessionStarted } from "@niwa-labs/sessions/records";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { inspectAction, runsAction } from "../src/cockpit/actions.ts";
import { DashboardRuns } from "../src/cockpit/dashboard.tsx";
import { workflowStepLabel, workflowTimeline } from "../src/cockpit/timeline.ts";
import { inspectRun } from "../src/inspect.ts";
import { PhaseEntered, RunFinished, RunId, RunRequested, RunStarted, StepPhase } from "../src/records.ts";

function tower() {
  const run = RunId.parse("run-bd11d2");
  const invocation = "workflow/tower";
  const records: StoredRecord[] = [];
  const journal: JournalReader = {
    get: id => records.find(row => row.id === id),
    find: ({ type, field, equals, after = 0 }) => records.filter(row =>
      row.type === type && row.seq > after && (field === undefined || (row.data as Record<string, unknown>)[field] === equals)),
    since: (from, types) => records.filter(row => row.seq > from && (types === undefined || types.includes(row.type))),
    last: () => seq(records.length),
    query: () => { throw new Error("Unexpected query"); },
    tail: () => { throw new Error("Unexpected tail"); },
  };
  function add(type: RecordTypeName, data: Record<string, unknown>, identifier = String(records.length)) {
    const id = recordId(identifier);
    records.push({
      id, type, data: { invocation, ...data }, seq: seq(records.length + 1), cause: null, root: id,
      actor: { kind: "handler", handler: "workflow/run", invocation },
      at: 1_700_000_000_000 + 1000 * records.length, schema: 1, stream: "main",
    } as StoredRecord);
  }
  const phase = "Предварительное исследование";
  const origin = { run, file: "tower.ts", args: {}, label: "Tower prestudy", phases: [{ title: phase }] };
  add(RunRequested.name, origin);
  add(RunStarted.name, origin);
  add(PhaseEntered.name, { run, phase, branch: "" });

  function intent(key: string, action: string, input: unknown) {
    const id = invocation + "/step/" + key;
    const operationId = invocation + "/" + key;
    add(CORE_TYPES.stepIntent, { key, action, input, operationId }, id + "/intent");
    return {
      emit: (type: RecordTypeName, value: Record<string, unknown>) => add(type, value, operationId + "/emit/1"),
      finish: (value: unknown, status = "completed") => add(CORE_TYPES.stepOutcome, { key, outcome: { status, value } }, id + "/outcome"),
    };
  }
  function call(label: string, action: string, input: unknown = {}, branch = "") {
    const key = branch + "label:" + label;
    add(StepPhase.name, { run, phase, key });
    return intent(key, action, input);
  }
  function open(topic: string, id: string) {
    const ref = "codex-sol fake-" + id;
    const launch = call(topic, "session.start.codex-sol");
    const nested = intent("label:" + topic + ".step-1", "session.start", {});
    nested.emit(SessionStarted.name, { run, id, session: ref });
    nested.finish({ session: id, ref });
    launch.finish({ session: id, ref });
    return { id, ref, topic };
  }
  function send({ topic, id }: ReturnType<typeof open>, label = topic + "-send") {
    call(label, "session.turn-send", { session: id, prompt: "Исследуй " + topic })
      .finish({ receipt: { status: "started", turn: 1 }, handle: { session: id, turn: 1, operation: "delivery" } });
  }
  function wait({ topic, ref }: ReturnType<typeof open>) {
    return call(topic + "-wait", "session.turn-wait", { session: ref, operation: "delivery", turn: 1 });
  }
  function close({ topic, ref, id }: ReturnType<typeof open>) {
    const step = call(topic + "-close", "session.end", { session: id, reason: "finished" });
    step.emit(SessionEnded.name, { session: ref });
    step.finish({ ended: true });
  }

  const missions = open("missions", "s-a795ed");
  send(missions);
  const missionsWait = wait(missions);
  const limits = open("limits", "s-d550d1");
  send(limits);
  const limitsWait = wait(limits);
  call("limits-send", "niwa.now", {}, "p1.2.").finish(42);
  missionsWait.finish({ status: "completed", value: "Answer" });
  close(missions);
  const primitives = open("niwa-primitives", "s-03a28c");
  send(primitives);
  limitsWait.finish({ status: "timed-out" });
  call("Проверка-лимитов", "session.turn-wait", { session: limits.id, operation: "delivery" }).finish(undefined, "failed");
  close(limits);
  wait(primitives).finish({ status: "completed", value: { checked: true } });
  close(primitives);
  add(RunFinished.name, { run, outcome: { status: "done", result: null } });
  return inspectAction.output.parse(inspectRun(journal, run));
}

test("Tower phases order lifecycle and receipt events across overlaps and preserve general actions", () => {
  const inspected = tower();
  const [moments] = workflowTimeline(inspected);
  expect(moments!.map(({ step, session, topic, boundary }) => [
    session?.id, boundary ?? (step && workflowStepLabel(step, topic)),
  ])).toEqual([
    ["s-a795ed", "start"],
    ["s-a795ed", "Поручение отправлено"],
    ["s-d550d1", "start"],
    ["s-d550d1", "Поручение отправлено"],
    [undefined, "limits-send"],
    ["s-a795ed", "Ответ получен"],
    ["s-a795ed", "end"],
    ["s-03a28c", "start"],
    ["s-03a28c", "Поручение отправлено"],
    ["s-d550d1", "Время ожидания истекло"],
    ["s-d550d1", "Проверка-лимитов · Ожидание ответа · ошибка"],
    ["s-d550d1", "end"],
    ["s-03a28c", "Ответ получен"],
    ["s-03a28c", "end"],
  ]);
  const waited = inspected.phases[0]!.steps.find(step => step.label === "missions-wait")!;
  expect(workflowStepLabel({ ...waited, sessionResult: undefined }, "missions")).toBe("Результат ожидания не подтверждён");
  expect(workflowStepLabel({ ...waited, status: "unknown", historical: true }, "missions")).toBe("Ожидание ответа · исход неизвестен");
  expect(workflowStepLabel({ ...waited, status: "cancelled" }, "missions")).toBe("Ожидание ответа · отменено");
});

test("the home card renders Tower on one axis with keyboard links and one sandbox badge per session", async () => {
  const inspection = tower();
  const queries = new QueryClient();
  queries.setQueryData(callKey(runsAction, {}), { entries: [{
    run: inspection.run, name: "Tower prestudy", state: "finished",
    requestedAt: inspection.origin.requestedAt, about: "done", requests: 0,
  }] });
  queries.setQueryData(callKey(inspectAction, { run: inspection.run }), inspection);
  for (const session of inspection.sessions) {
    queries.setQueryData(callKey("niwa.records.read", { types: ["session.marked"], filter: { session: session.ref }, tail: 1 }),
      { records: [{ data: { mark: session.id } }] });
    queries.setQueryData(callKey("niwa.records.read", { types: ["session.box.manifest"], filter: { mark: session.id }, tail: 1 }),
      { records: [{ data: { mark: session.id, sandbox: "tower-" + session.id } }] });
  }
  const host = httpHostClient();
  const services = {
    host, viewer: createViewer({ id: "owner", owner: true, actions: [runsAction.name, inspectAction.name, "niwa.records.read"] }),
    records: createRecordStream(host),
  };
  const { registry } = await loadPlugins([{ id: "sessions", load: async () => ({ default: definePlugin({
    id: "sessions",
    setup: ctx => ctx.entities.register("session", { label: "Сессия", prefix: "s", href: id => "/sessions/" + id }),
  }) }) }], services);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={queries}>
      <CockpitProvider runtime={{ ...services, registry, navigator: { navigate() {} }, reportFault() {} }}>
        <DashboardRuns project="" />
      </CockpitProvider>
    </QueryClientProvider>,
  );
  expect(markup.match(/class="nw-timeline"/g)).toHaveLength(1);
  expect(markup.match(/data-boundary="start"/g)).toHaveLength(3);
  expect(markup.match(/data-boundary="end"/g)).toHaveLength(3);
  expect(markup.match(/data-slot="sandbox-badge"/g)).toHaveLength(3);
  expect(markup.match(/Поручение отправлено/g)).toHaveLength(3);
  expect(markup.match(/Ответ получен/g)).toHaveLength(2);
  expect(markup.match(/Сессия закрыта/g)).toHaveLength(3);
  expect(markup).toContain('href="/sessions/s-a795ed"');
  expect(markup).toContain('href="/journal?record=workflow%2Ftower%2Fstep%2Flabel%3Amissions-send%2Fintent"');
  expect(markup).toContain('title="session.turn-send · label:missions-send');
  expect(markup).not.toContain(">missions-send<");
  const general = markup.match(/<li class="nw-moment"><time.*?limits-send<\/a>/);
  expect(general?.[0]).toContain('nw-moment-axis" data-mark="true"');
  expect(general?.[0]?.match(/data-before="true" data-after="true"/g)).toHaveLength(2);
});
