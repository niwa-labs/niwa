import { useEffect, useState, type ReactNode } from "react";
import { WORK_STATE_LABEL, type WorkState } from "./state.tsx";

/** Motion describes what is happening now. Settled work carries no activity. */
export type Activity = "working" | "human" | "timer" | "paused" | "starting";
export function ActivityLabel({ activity, children }: { activity?: Activity | undefined; children: ReactNode }) {
  return (
    <span className="nw-activity" data-activity={activity}>
      {children}
    </span>
  );
}

export interface ExecutionStep {
  id: string;
  title: ReactNode;
  kind: "agent" | "question" | "timer" | "wait" | "action";
  state: WorkState;
  activity?: Activity | undefined;
  detail?: string | undefined;
  branch?: string | undefined;
  start: number;
  end?: number | undefined;
  due?: number | undefined;
}
export function MiniPhaseTrack({
  phases,
}: {
  phases: readonly { title: string; state: "done" | "current" | "ahead"; activity?: Activity | undefined }[];
}) {
  return (
    <span className="nw-mini" aria-label="Фазы">
      {phases.map((p) => (
        <span key={p.title}><i data-state={p.state} data-activity={p.activity} aria-label={WORK_STATE_LABEL[p.state === "ahead" ? "pending" : p.state === "current" ? "running" : "done"]} />{p.title}</span>
      ))}
    </span>
  );
}
export interface ExecutionPhase {
  id: string;
  title: string;
  detail?: string | undefined;
  state: WorkState;
  activity?: Activity | undefined;
  steps: ExecutionStep[];
  timeline?: ExecutionMoment[] | undefined;
}

export interface ExecutionMoment {
  id: string;
  at: string;
  step?: ExecutionStep | undefined;
  heading?: ReactNode;
  session?: { id: string; boundary?: "start" | "end" | "continuation" | "reference" | undefined } | undefined;
}
const marks: Record<WorkState, string> = {
  pending: "○",
  running: "●",
  waiting: "Ⅱ",
  done: "✓",
  failed: "!",
  unknown: "?",
  stopped: "×",
  skipped: "↷",
  reused: "↺",
};
function Node({ phase }: { phase: ExecutionPhase }) {
  return (
    <i className="nw-node" data-state={phase.state} aria-label={WORK_STATE_LABEL[phase.state]}>
      {phase.activity === "timer" ? "◷" : phase.activity === "human" ? "?" : marks[phase.state]}
    </i>
  );
}

export function PhaseSequence({ phases }: { phases: ExecutionPhase[] }) {
  return (
    <ol className="nw-sequence" aria-label="План фаз">
      {phases.map((p) => (
        <li key={p.id} title={p.detail}>
          <Node phase={p} />
          <div>
            <ActivityLabel activity={p.activity}>{p.title}</ActivityLabel>
            {p.detail && <small>{p.detail}</small>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <time className="nw-countdown" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {" "}
      · {s >= 3600 && Math.floor(s / 3600) + " ч "}
      {s >= 60 && (Math.floor(s / 60) % 60) + " мин "}
      {s % 60} с
    </time>
  );
}

function Branch({ step, full, first, last, as: Tag = "li" }: {
  step: ExecutionStep; full: boolean; first: number; last: number; as?: "li" | "div";
}) {
  const icon = { agent: "A", question: "?", timer: "◷", wait: "◷", action: "⌘" }[step.kind];
  return (
    <Tag className="nw-branch" data-kind={step.kind} data-activity={step.activity}>
      <div className="nw-step">
        <i aria-hidden>{icon}</i>
        <span>
          {step.title}
          {step.activity === "timer" && step.due !== undefined && <Countdown at={step.due} />}
        </span>
        <em aria-label={WORK_STATE_LABEL[step.state]}>
          {step.activity === "working" ? "" : step.state === "running" ? "…" : marks[step.state]}
        </em>
      </div>
      {step.detail && (full || step.kind === "agent") && (
        <small className="nw-prompt">{full ? step.detail : step.detail.slice(0, 64)}</small>
      )}
      {full && (
        <>
          {last > first && (
            <div className="nw-duration" aria-hidden>
              <i
                style={{
                  left: ((step.start - first) / (last - first)) * 100 + "%",
                  width: (((step.end ?? last) - step.start) / (last - first)) * 100 + "%",
                }}
              />
            </div>
          )}
          <small>
            {step.branch && "Ветка " + step.branch + " · "}
            {time(step.start)}
            {step.end !== undefined && " – " + time(step.end)}
          </small>
        </>
      )}
    </Tag>
  );
}

function Timeline({ moments }: { moments: ExecutionMoment[] }) {
  const reserved: Array<string | undefined> = [];
  const active = new Set<string>();
  const lastUse = new Map(moments.flatMap((moment, index) => moment.session ? [[moment.session.id, index] as const] : []));
  const visible = () => reserved.map(id => id !== undefined && active.has(id));
  const rows = moments.map((moment, index) => {
    const before = visible();
    const session = moment.session;
    let lane = -1;
    if (session) {
      lane = reserved.indexOf(session.id);
      if (lane === -1) {
        lane = reserved.indexOf(undefined);
        if (lane === -1) lane = reserved.length;
        reserved[lane] = session.id;
      }
      if (session.boundary === "start" || session.boundary === "continuation") active.add(session.id);
      if (session.boundary === "end") active.delete(session.id);
    }
    const after = visible();
    if (session && lastUse.get(session.id) === index && !active.has(session.id)) reserved[lane] = undefined;
    return { moment, lane, before, after };
  });
  const columns = Math.max(0, ...rows.map(({ lane, before, after }) => Math.max(lane + 1, before.length, after.length)));
  const clock = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <ol className="nw-timeline" aria-label="Хронология действий сценария">
    {rows.map(({ moment, lane, before, after }) => {
      const date = new Date(moment.at);
      return <li key={moment.id} className="nw-moment" data-session={moment.session?.id} data-boundary={moment.session?.boundary}>
        <time dateTime={moment.at} title={date.toLocaleString("ru")}>{clock.format(date)}</time>
        <span className="nw-moment-rails" aria-hidden="true">
          <span className="nw-moment-axis" data-mark={lane === -1 || undefined} />
          {Array.from({ length: columns }, (_, i) => <span key={i} className="nw-moment-lane"
            data-before={before[i] || undefined}
            data-after={after[i] || undefined}
            data-mark={i === lane || undefined}
            data-join={i <= lane && !!moment.session?.boundary || undefined}>
            {i === lane && <i />}
          </span>)}
        </span>
        <div className="nw-moment-content">
          {moment.heading}
          {moment.step && <Branch as="div" step={moment.step} full={false} first={0} last={0} />}
        </div>
      </li>;
    })}
  </ol>;
}

function PhaseSteps({ steps, detail, observedAt }: {
  steps: ExecutionStep[];
  detail: boolean;
  observedAt?: number | undefined;
}) {
  if (!steps.length) return null;
  const first = steps.reduce((start, step) => Math.min(start, step.start), Infinity);
  const last = steps.reduce((end, step) => Math.max(end, step.end ?? observedAt ?? step.start), first);
  let latestEnd = -Infinity;
  const parallel = detail && [...steps].sort((a, b) => a.start - b.start).some(step => {
    if (latestEnd > step.start) return true;
    latestEnd = Math.max(latestEnd, step.end ?? Infinity);
    return false;
  });
  return <>
    {parallel && <small className="nw-fork">⑂ Параллельные ветки</small>}
    <ul className="nw-branches">
      {steps.map(step => <Branch key={step.id} step={step} full={detail} first={first} last={last} />)}
    </ul>
  </>;
}

/** Keep the declared plan above the step history, even when the first phase has long prompts. */
function DetailedTrack({ phases, observedAt }: { phases: ExecutionPhase[]; observedAt?: number | undefined }) {
  const [picked, setPicked] = useState<string>();
  const current = phases.find(p => p.state === "running" || p.state === "waiting" || p.state === "failed");
  const selected = phases.find(p => p.id === picked) ?? current ?? phases.find(p => p.steps.length) ?? phases[0];
  return <section className="nw-track nw-track-inspect" data-detail="true" aria-label="Ход выполнения">
    <ol className="nw-phase-index" aria-label="План фаз">
      {phases.map(p => <li key={p.id} className="nw-phase" data-activity={p.activity}>
        <button type="button" className="nw-phase-title" aria-pressed={p.id === selected?.id}
          onClick={() => setPicked(p.id === picked ? undefined : p.id)}>
          <Node phase={p}/><span>{p.title}{p.detail && <small>{p.detail}</small>}</span>
        </button>
      </li>)}
    </ol>
    {selected && (selected.steps.length
      ? <PhaseSteps steps={selected.steps} observedAt={observedAt} detail />
      : <small>{selected.state === "pending" ? "Фаза ещё не началась" : "Шагов пока нет"}</small>)}
  </section>;
}

export function ExecutionTrack({ phases, looseSteps = [], looseTimeline, detail = false, observedAt }: {
  looseSteps?: ExecutionStep[];
  looseTimeline?: ExecutionMoment[] | undefined;
  phases: ExecutionPhase[];
  detail?: boolean;
  observedAt?: number | undefined;
}) {
  return <>
    {phases.length > 0 && (detail ? <DetailedTrack phases={phases} observedAt={observedAt} /> :
    <ol className="nw-track" data-detail="false" aria-label="Ход выполнения">
      {phases.map(p => <li className="nw-phase" key={p.id} data-activity={p.activity}>
        <div className="nw-phase-title"><Node phase={p} />{p.title}</div>
        {p.timeline?.length ? <Timeline moments={p.timeline} /> :
          <PhaseSteps steps={p.steps} detail={false} observedAt={observedAt} />}
      </li>)}
    </ol>)}
    {looseSteps.length > 0 && <section className="nw-loose-steps" aria-label="Шаги вне фаз">
      <h3>{phases.length ? "Шаги вне фаз" : "Шаги"}</h3>
      {looseTimeline?.length ? <Timeline moments={looseTimeline} /> :
        <PhaseSteps steps={looseSteps} detail={detail} observedAt={observedAt} />}
    </section>}
  </>;
}
