import { SessionSandboxBadge } from "@niwa-labs/cockpit-sdk";
import { IsolationMark } from "./isolation-mark.tsx";
import { runSummary } from "./run-summary.ts";
import { EntityLink, PageLink, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import {
  ActivityLabel,
  stepPause, StepPauseLabel,
  DataValue,
  ExecutionTrack,
  type Activity,
  type ExecutionMoment,
  type ExecutionPhase,
  type ExecutionStep,
} from "@niwa-labs/ui-kit";
import { z } from "zod";
import { inspectAction, type Inspection, type RunEntry, type Step } from "./actions.ts";
import { catalogueEvents } from "./catalogue-actions.ts";
import { phaseState, stepState } from "./plan.ts";
import { workflowStepLabel, workflowTimeline, type Moment } from "./timeline.ts";

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
function executionStep(s: Step, status: Inspection["status"], timers: Timers, answerStep: Step | undefined, sessions: Inspection["sessions"], moment?: Moment): ExecutionStep {
  const kind = kindOf(s);
  const live =
    status.state === "running" && !status.manualPause && s.status === "running" && !s.historical && !s.endedAt;
  const activity = live
    ? ({ agent: "working", action: "working", timer: "timer", question: "human", wait: undefined } as const)[kind]
    : undefined;
  const label = moment ? moment.boundary === "start" ? "Сессия открыта" : workflowStepLabel(s, moment.topic, moment.boundary === "end")
    : s.label === s.action && kind === "question" ? "Ответ владельца" : s.label || s.action;
  let title = <span title={moment && [s.action, s.key, s.id].join(" · ")}>
    <PageLink to={"/journal?record=" + encodeURIComponent(s.id)}>
      {label}
      {moment?.session && <span className="sr-only"> · {moment.topic ?? moment.session.id}</span>}
    </PageLink>
    {moment && s.historical && <small>Предыдущая попытка</small>}
    {moment && !moment.session && s.session && <> · <EntityLink entity={{ kind: "session", id: s.session }} short /></>}
  </span>;
  const session = s.session && !moment && sessions.find((row) => row.id === s.session);
  if (s.session && !moment) title = <span className="inline-flex flex-col items-start gap-1"><span className="inline-flex items-center gap-1">
    <EntityLink entity={{ kind: "session", id: s.session }} label={label} />
    <IsolationMark boxed={session ? session.boxed : undefined} subject="Сессия" />
  </span>{session && <SessionSandboxBadge session={session.ref} />}</span>;
  if (s.id === answerStep?.id)
    title = <PageLink to={"/requests/" + encodeURIComponent(status.requests[0]!)}>Ответить · {label}</PageLink>;
  const scheduled =
    !live || s.timerName === undefined
      ? []
      : timers.flatMap((t) => ((!s.timerName || s.timerName === t.name) && t.nextDue !== null ? [t.nextDue] : []));
  const due = Math.min(s.dueAt ? Date.parse(s.dueAt) : Infinity, ...scheduled);
  return {
    id: s.id,
    title,
    kind,
    state: stepState(s),
    activity,
    detail: moment?.session && s.prompt ? "Поручение сценария · " + s.prompt : s.prompt,
    branch: s.branch,
    start: Date.parse(s.startedAt),
    end: s.endedAt ? Date.parse(s.endedAt) : undefined,
    due: Number.isFinite(due) ? due : undefined,
  };
}

function SessionHeading({ moment }: { moment: Moment & { session: NonNullable<Moment["session"]> } }) {
  const { session, topic, boundary } = moment;
  const harness = session.ref.split(" ", 1)[0]!;
  const label = topic ? topic + " · " + harness : "Сессия · " + harness;
  return <div className="nw-session-heading">
    <h4><EntityLink entity={{ kind: "session", id: session.id }} label={label} /></h4>
    {boundary === "start" && <>
      <IsolationMark boxed={session.boxed} subject="Сессия" />
      <SessionSandboxBadge session={session.ref} />
      {!moment.step && <span>Сессия открыта</span>}
    </>}
  </div>;
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

export function InspectedTrack({ inspection, detail = false, chronological = false }: {
  inspection: Inspection; detail?: boolean; chronological?: boolean;
}) {
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
  const timeline = chronological ? workflowTimeline(inspection) : undefined;
  const timelines = timeline?.map(moments => moments.map((moment): ExecutionMoment => {
    const { boundary, session, step } = moment;
    return {
      id: step?.id ?? session?.id + "/" + boundary,
      at: moment.at,
      session: session && { id: session.id, boundary },
      step: step && executionStep(step, status, timers, answerStep, inspection.sessions, moment),
      heading: session && boundary && (boundary !== "end"
        ? <SessionHeading moment={{ ...moment, session }} />
        : !step && <PageLink to={"/journal?record=" + encodeURIComponent(session.end!.record)}>Сессия закрыта</PageLink>),
    };
  }));
  const phases: ExecutionPhase[] = inspection.phases.map((p, index) => {
    const active = open.filter((s) => s.phase === p.title);
    return {
      id: p.title,
      title: p.title,
      detail: p.detail,
      state: phaseState(p, status),
      activity: p.state === "current" ? runActivity(status, active) : undefined,
      steps: p.steps.map((s) => executionStep(s, status, timers, answerStep, inspection.sessions)),
      timeline: timelines?.[index],
    };
  });
  const looseSteps = inspection.steps.map(s => executionStep(s, status, timers, answerStep, inspection.sessions));
  const pause = status.state === "paused" && !status.manualPause ? stepPause(status.reason) : undefined;
  const pausedStep = pause ? all.findLast(s => !s.historical && s.key === pause.key) : undefined;
  const pausedMoment = pausedStep && timeline?.flat().find(({ step }) => step === pausedStep);
  const pauseLabel = pausedStep && (chronological ? workflowStepLabel(pausedStep, pausedMoment?.topic) : pausedStep.label);
  const why = describeRun(status, activity, open);
  return (
    <>
      {phases.length || looseSteps.length ? (
        <ExecutionTrack
          phases={phases}
          looseSteps={looseSteps}
          looseTimeline={timelines?.at(-1)}
          detail={detail}
          observedAt={inspection.observedAt ? Date.parse(inspection.observedAt) : undefined}
        />
      ) : (
        <p>{status.state === "finished" ? "Фазы не записаны" : "Ожидает первого шага"}</p>
      )}
      {!answerStep && <p className="nw-run-status">
        {status.requests.length ? <PageLink to={status.requests.length === 1 ? "/requests/"+encodeURIComponent(status.requests[0]!) : "/requests"}>Ждут ответа · {status.requests.length}</PageLink> : pause ? <StepPauseLabel pause={pause} label={pauseLabel ?? pause.label} /> : <ActivityLabel activity={activity}>{why}</ActivityLabel>}
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
  if (inspection.data) return <InspectedTrack inspection={inspection.data} chronological />;
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
      {!!phases.length && <ExecutionTrack phases={phases} />}
      <p>{entry.requests ? <PageLink to="/requests">Ждут ответа · {entry.requests}</PageLink> : inspection.error?.message ?? runSummary(entry)}</p>
    </>
  );
}
