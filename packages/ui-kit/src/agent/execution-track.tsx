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
        <i key={p.title} data-state={p.state} data-activity={p.activity} title={p.title + " · " + p.state} />
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

function Branch({ step, full, first, last }: { step: ExecutionStep; full: boolean; first: number; last: number }) {
  const icon = { agent: "A", question: "?", timer: "◷", wait: "◷", action: "⌘" }[step.kind];
  return (
    <li className="nw-branch" data-kind={step.kind} data-activity={step.activity}>
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
    </li>
  );
}

/** Same execution in a horizontal overview or a vertical inspection with aligned time bars. */
export function ExecutionTrack({
  phases,
  detail = false,
  observedAt,
}: {
  phases: ExecutionPhase[];
  detail?: boolean;
  observedAt?: number | undefined;
}) {
  return (
    <ol className="nw-track" data-detail={detail} aria-label="Ход выполнения">
      {phases.map((p) => {
        const first = p.steps.reduce((min, s) => Math.min(min, s.start), Infinity);
        const last = p.steps.reduce((max, s) => Math.max(max, s.end ?? observedAt ?? s.start), first);
        // Compare starts in order. A gap between sequential steps is not a parallel fork.
        let latestEnd = -Infinity;
        const parallel =
          detail &&
          [...p.steps]
            .sort((a, b) => a.start - b.start)
            .some((s) => {
              if (latestEnd > s.start) return true;
              latestEnd = Math.max(latestEnd, s.end ?? Infinity);
              return false;
            });
        return (
          <li className="nw-phase" key={p.id} data-activity={p.activity}>
            <div className="nw-phase-title">
              <Node phase={p} />
              {p.title}
              {detail && p.detail && <small>{p.detail}</small>}
            </div>
            {parallel && <small className="nw-fork">⑂ Параллельные ветки</small>}
            {p.steps.length > 0 && (
              <ul className="nw-branches">
                {p.steps.map((s) => (
                  <Branch key={s.id} step={s} full={detail} first={first} last={last} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
