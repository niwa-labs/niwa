import { runSummary } from "./run-summary.ts";
import { EntityLink, PageLink, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import {
  ActivityLabel,
  DataValue,
  ExecutionTrack,
  PhaseSequence,
  type Activity,
  type ExecutionPhase,
  type ExecutionStep,
} from "@niwa-labs/ui-kit";
import { z } from "zod";
import { inspectAction, type Inspection, type RunEntry, type Step } from "./actions.ts";
import { catalogueEvents } from "./catalogue-actions.ts";
import { phaseState, stepState } from "./plan.ts";

function kindOf(s: Step): ExecutionStep["kind"] {
  if (s.session || s.action.startsWith("session.start") || s.action === "session.ask") return "agent";
  if (s.action === "request.ask") return "question";
  if (s.waitEvent?.startsWith("timer.")) return "timer";
  if (s.waitEvent || ["niwa.wait", "workflow.script.wait"].includes(s.action)) return "wait";
  return "action";
}
function runActivity(status: Inspection["status"], open: Step[]): Activity | undefined {
  if (status.state === "finished") return undefined;
  if (status.manualPause) return "paused";
  if (status.requests.length) return "human";
  if (status.state === "paused") return "paused";
  if (open.length && open.every((s) => ["wait", "timer"].includes(kindOf(s)))) return "timer";
  return open.length ? "working" : "starting";
}

const schedule = {
  name: "timer.list",
  input: z.object({}),
  output: z.object({ timers: z.array(z.object({ name: z.string(), nextDue: z.number().nullable() })) }),
};
type Timers = z.infer<typeof schedule.output>["timers"];
function executionStep(s: Step, status: Inspection["status"], timers: Timers, answerStep: Step | undefined): ExecutionStep {
  const kind = kindOf(s);
  const live =
    status.state === "running" && !status.manualPause && s.status === "running" && !s.historical && !s.endedAt;
  const activity = live
    ? ({ agent: "working", action: "working", timer: "timer", question: "human", wait: undefined } as const)[kind]
    : undefined;
  const label = s.label === s.action && kind === "question" ? "Ответ владельца" : s.label || s.action;
  let title = <PageLink to={"/journal?record=" + encodeURIComponent(s.id)}>{label}</PageLink>;
  if (s.session) title = <EntityLink entity={{ kind: "session", id: s.session }} label={label} />;
  if (s.id === answerStep?.id)
    title = <PageLink to={"/requests/" + encodeURIComponent(status.requests[0]!)}>Ответить · {label}</PageLink>;
  const scheduled =
    s.timerName === undefined
      ? []
      : timers.flatMap((t) => ((!s.timerName || s.timerName === t.name) && t.nextDue !== null ? [t.nextDue] : []));
  const due = Math.min(s.dueAt ? Date.parse(s.dueAt) : Infinity, ...scheduled);
  return {
    id: s.id,
    title,
    kind,
    state: stepState(s),
    activity,
    detail: s.prompt,
    branch: s.branch,
    start: Date.parse(s.startedAt),
    end: s.endedAt ? Date.parse(s.endedAt) : undefined,
    due: Number.isFinite(due) ? due : undefined,
  };
}

function describeRun(status: Inspection["status"], activity: Activity | undefined, open: Step[]) {
  if (status.outcome?.status === "failed") return status.outcome.error.message;
  if (status.outcome?.status === "cancelled") return "Остановлен";
  if (status.state === "finished") return "Выполнение окончено";
  if (status.reason) return status.reason;
  if (activity === "human") return "Ждёт ответа владельца";
  if (activity === "timer") return open.some((s) => kindOf(s) === "timer") ? "Ждёт таймер" : "Ждёт события";
  if (activity === "paused") return "На паузе";
  return status.waiting ?? "Запуск выполняется";
}

export function InspectedTrack({ inspection, detail = false }: { inspection: Inspection; detail?: boolean }) {
  const { status } = inspection;
  const all = [...inspection.steps, ...inspection.phases.flatMap((p) => p.steps)];
  const open = all.filter((s) => !s.historical && !s.endedAt && s.status === "running");
  const viewer = useViewer();
  const schedules = useCall(
    schedule,
    {},
    { enabled: viewer.can(schedule) && open.some((s) => s.timerName !== undefined), refreshOn: { types: ["timer.*"] } },
  );
  const timers = schedules.data?.timers ?? [];
  const activity = runActivity(status, open);
  const questions = open.filter(step => kindOf(step) === "question");
  const answerStep = status.state === "running" && !status.manualPause && status.requests.length === 1 && questions.length === 1
    ? questions[0] : undefined;
  const phases: ExecutionPhase[] = inspection.phases.map((p) => {
    const active = open.filter((s) => s.phase === p.title);
    return {
      id: p.title,
      title: p.title,
      detail: p.detail,
      state: phaseState(p, status),
      activity: p.state === "current" ? runActivity(status, active) : undefined,
      steps: p.steps.map((s) => executionStep(s, status, timers, answerStep)),
    };
  });
  const visible = [...phases];
  if (inspection.steps.length)
    visible.unshift({
      id: "unphased",
      title: phases.length ? "Вне фаз" : "Шаги",
      state: status.state === "finished" ? (status.outcome?.status === "done" ? "done" : "stopped") : "running",
      activity: open.some((s) => !s.phase) ? activity : undefined,
      steps: inspection.steps.map((s) => executionStep(s, status, timers, answerStep)),
    });
  const why = describeRun(status, activity, open);
  return (
    <>
      {visible.length ? (
        <ExecutionTrack
          phases={visible}
          detail={detail}
          observedAt={inspection.observedAt ? Date.parse(inspection.observedAt) : undefined}
        />
      ) : (
        <p>{status.state === "finished" ? "Фазы не записаны" : "Ожидает первого шага"}</p>
      )}
      {!answerStep && <p className="nw-run-status">
        {status.requests.length ? <PageLink to={status.requests.length === 1 ? "/requests/"+encodeURIComponent(status.requests[0]!) : "/requests"}>Ждут ответа · {status.requests.length}</PageLink> : <ActivityLabel activity={activity}>{why}</ActivityLabel>}
      </p>}
      {!detail && status.outcome?.status === "done" && status.outcome.result != null &&
        <details className="nw-run-result"><summary>Результат запуска</summary><DataValue value={status.outcome.result} /></details>}
    </>
  );
}

export function RunTrack({ entry }: { entry: RunEntry }) {
  const viewer = useViewer();
  const inspection = useCall(
    inspectAction,
    { run: entry.run },
    { enabled: viewer.can(inspectAction), refreshOn: catalogueEvents },
  );
  if (inspection.data) return <InspectedTrack inspection={inspection.data} />;
  const phases: ExecutionPhase[] = (entry.phases ?? []).map((p) => ({
    id: p.title,
    title: p.title,
    detail: p.detail,
    state:
      p.state === "ahead"
        ? "pending"
        : p.state === "done"
          ? "done"
          : entry.state === "paused"
            ? "waiting"
            : entry.state === "finished"
              ? "stopped"
              : "running",
    steps: [],
  }));
  return (
    <>
      {!!phases.length && <PhaseSequence phases={phases} />}
      <p>{entry.requests ? <PageLink to="/requests">Ждут ответа · {entry.requests}</PageLink> : inspection.error?.message ?? runSummary(entry)}</p>
    </>
  );
}
