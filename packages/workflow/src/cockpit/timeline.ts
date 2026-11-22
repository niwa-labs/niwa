import type { Inspection, Step } from "./actions.ts";

type Session = Inspection["sessions"][number];
type Boundary = "start" | "end" | "continuation" | "reference";
export type Moment = {
  at: string;
  sequence?: number | undefined;
  step?: Step | undefined;
  session?: Session | undefined;
  boundary?: Boundary | undefined;
  topic?: string | undefined;
};

const operation = {
  send: "Отправка поручения",
  wait: "Ожидание ответа",
  close: "Закрытие сессии",
  ask: "Запрос к сессии",
  interrupt: "Прерывание сессии",
  resume: "Возобновление сессии",
  start: "Запуск сессии",
} as const;

function operationOf(action: string): keyof typeof operation | undefined {
  if (action === "session.start" || action.startsWith("session.start.")) return "start";
  switch (action) {
    case "session.send":
    case "session.turn-send": return "send";
    case "session.turn-wait":
    case "session.turn-wait-many": return "wait";
    case "session.end": return "close";
    case "session.ask":
    case "session.ask-and-wait": return "ask";
    case "session.interrupt": return "interrupt";
    case "session.resume": return "resume";
  }
}

const results = {
  sent: "Поручение отправлено",
  queued: "Поручение в очереди",
  handled: "Поручение обработано",
  completed: "Ответ получен",
  ended: "Ход сессии завершился без результата",
  "no-answer": "Ход сессии завершился без ответа",
  "invalid-answer": "Ответ не прошёл проверку",
  "timed-out": "Время ожидания истекло",
  closed: "Сессия закрыта",
  "already-closed": "Сессия уже была закрыта",
} satisfies Record<NonNullable<Step["sessionResult"]>, string>;

export function workflowStepLabel(step: Step, topic?: string, closed = false): string {
  const op = operationOf(step.action);
  if (op === undefined) return step.label === step.action && step.action === "request.ask" ? "Ответ владельца" : step.label || step.action;

  // Script labels also serve as stable call keys. Hide the conventional machine keys in the
  // primary display, after the journal has associated the step with a session.
  const conventional = topic && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic) && step.label === topic + "-" + op;
  const title = step.label && step.label !== step.action && !conventional ? step.label : undefined;
  let description: string = operation[op];
  if (closed) description = results.closed;
  else if (step.status === "completed") {
    if (step.sessionResult) description = results[step.sessionResult];
    else if (step.action === "session.ask") description = results.completed;
    else if (op === "wait" && step.action !== "session.turn-wait-many") description = "Результат ожидания не подтверждён";
    else if (op === "send") description = "Отправка не подтверждена";
    else if (op === "close") description = "Закрытие не подтверждено";
    else if (op === "start" && step.session) description = "Сессия открыта";
  } else {
    const status = { failed: "ошибка", unknown: "исход неизвестен", skipped: "пропущено", cancelled: "отменено", paused: "на паузе", running: undefined }[step.status];
    if (status) description += " · " + status;
  }
  return title === undefined ? description : title + " · " + description;
}

function byTime(a: Pick<Moment, "at" | "sequence">, b: Pick<Moment, "at" | "sequence">) {
  return Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || 0;
}

/** One chronological stream per phase. Assign every boundary once, even when a session spans phases. */
export function workflowTimeline(inspection: Inspection): Moment[][] {
  const steps = [...inspection.phases.map(phase => phase.steps), inspection.steps];
  const timelines: Moment[][] = steps.map(() => []);
  const sessions = new Map(inspection.sessions.map(session => [session.id, session]));
  const bySession = new Map<string, Array<{ step: Step; section: number }>>();
  steps.forEach((sectionSteps, section) => {
    for (const step of sectionSteps) {
      const uses = step.session && sessions.has(step.session) ? bySession.get(step.session) ?? [] : undefined;
      if (uses) {
        uses.push({ step, section });
        bySession.set(step.session!, uses);
      } else {
        timelines[section]!.push({ at: step.startedAt, sequence: step.sequence, step });
      }
    }
  });
  for (const [id, uses] of bySession) {
    const session = sessions.get(id)!;
    uses.sort((a, b) => byTime({ at: a.step.startedAt, sequence: a.step.sequence }, { at: b.step.startedAt, sequence: b.step.sequence }));
    const launch = uses.find(({ step }) => operationOf(step.action) === "start");
    const first = launch ?? uses[0]!;
    const topic = launch && launch.step.label !== launch.step.action ? launch.step.label : undefined;
    const end = session.end;
    const closing = end && uses.find(({ step }) => step.sessionEndRecord === end.record && step.status === "completed");
    const lastBeforeEnd = end && uses.findLast(({ step }) => byTime({ at: step.startedAt, sequence: step.sequence }, end) <= 0);
    const last = closing ?? lastBeforeEnd ?? first;
    const opened = { at: session.startedAt, sequence: session.startSequence, session, topic };
    const openingStep = launch?.step.status === "completed" && !launch.step.prompt ? launch.step : undefined;
    timelines[first.section]!.push({ ...opened, boundary: "start", step: openingStep });
    if (end) timelines[last.section]!.push({ ...end, session, topic, boundary: "end", step: closing?.step });

    const sections = new Set([first.section]);
    for (const use of uses) {
      const { step, section } = use;
      if (!sections.has(section)) {
        const at = step.startedAt;
        const boundary = end && byTime(end, { at, sequence: step.sequence }) < 0 ? "reference" : "continuation";
        timelines[section]!.push({ at, sequence: step.sequence, session, topic, boundary });
        sections.add(section);
      }
      if (step === openingStep || use === closing) continue;
      timelines[section]!.push({
        at: step.endedAt ?? step.startedAt,
        sequence: step.endSequence ?? step.sequence,
        step, session, topic,
      });
    }
  }
  return timelines.map(timeline => timeline.sort(byTime));
}
