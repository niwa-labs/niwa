import { definePlugin, PageLink, recordList, useCall, useProjection } from "@niwa-labs/cockpit-sdk";
import { Badge, PageSection } from "@niwa-labs/ui-kit";
import { z } from "zod";

const schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), ms: z.number() }),
  z.object({ kind: z.literal("at"), at: z.number() }),
  z.object({ kind: z.literal("daily"), time: z.string() }),
]);
const timer = z.object({
  name: z.string(),
  description: z.string(),
  schedule,
  nextDue: z.number().nullable(),
});
type Timer = z.infer<typeof timer>;
const list = {
  name: "timer.list",
  input: z.object({}),
  output: z.object({ sleeps: z.array(z.string()), timers: z.array(timer) }),
};
const refreshOn = { types: ["timer.*"] };
const recent = recordList({ types: ["timer.fired", "timer.slept"] }, 30);
const firing = z.object({ timer: z.string(), due: z.number() });
const dateTime = new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "medium" });
const durationFormats = {
  hour: new Intl.NumberFormat("ru", { style: "unit", unit: "hour", unitDisplay: "long" }),
  minute: new Intl.NumberFormat("ru", { style: "unit", unit: "minute", unitDisplay: "long" }),
  second: new Intl.NumberFormat("ru", { style: "unit", unit: "second", unitDisplay: "long" }),
};

function Clock({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{dateTime.format(at)}</time>;
}

function Interval({ value }: { value: number }) {
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = (value / 1_000) % 60;
  const parts = [
    hours && durationFormats.hour.format(hours),
    minutes && durationFormats.minute.format(minutes),
    (seconds || !(hours || minutes)) && durationFormats.second.format(seconds),
  ].filter(Boolean);
  return <>Интервал · {parts.join(" ")}</>;
}

function Schedule({ value }: { value: Timer["schedule"] }) {
  switch (value.kind) {
    case "daily": return <>Ежедневно в {value.time} по времени хоста</>;
    case "every": return <Interval value={value.ms} />;
    case "at": return <>Однократно · <Clock at={value.at} /></>;
  }
}

function nameOf(entry: Timer): string {
  const automatic = /^(?:every \d+(?:\.\d+)?ms|daily \d\d:\d\d(?::\d\d)?|at \d{4}-\d\d-\d\dT[^\s]+)$/;
  return automatic.test(entry.description) ? entry.name : entry.description;
}

function pending(timers: Timer[]): Timer[] {
  return timers.filter((item) => item.nextDue !== null).sort((a, b) => (a.nextDue ?? Infinity) - (b.nextDue ?? Infinity));
}

function TimerRows({ rows }: { rows: Timer[] }) {
  return (
    <ul className="divide-y">
      {rows.map((entry) => (
        <li key={entry.name} className="min-w-0 flex flex-col gap-1 py-2">
          <p className="font-semibold wrap-anywhere">{nameOf(entry)}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span><Schedule value={entry.schedule} /></span>
            {entry.nextDue !== null && entry.schedule.kind !== "at" && <span>Следующее · <Clock at={entry.nextDue} /></span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

function WaitingSteps({ sleeps }: { sleeps: string[] }) {
  if (sleeps.length === 0) return null;
  return (
    <PageSection title="Ожидают пробуждения">
      <ul className="divide-y">
        {sleeps.map((line, index) => {
          // timer.list uses two spaces between the local clock, the owner of the wait and its label.
          const columns = /^(.*?) {2}(\S+) {2}(.*)$/.exec(line);
          const [, clock, owner, label] = columns ?? [];
          const run = owner && /^run[-_][0-9a-z-]+$/i.test(owner) ? owner : undefined;
          return (
            <li key={line + index} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
              <span className="font-medium wrap-anywhere">{label || "Ожидание шага"}</span>
              {clock && <span className="text-sm text-muted-foreground">Пробуждение · {clock}</span>}
              {run && <PageLink to={"/runs/" + encodeURIComponent(run)} className="text-sm text-primary hover:underline">Открыть запуск</PageLink>}
            </li>
          );
        })}
      </ul>
    </PageSection>
  );
}

function TimerTile() {
  const timers = useCall(list, {}, { refreshOn });
  const upcoming = timers.data ? pending(timers.data.timers) : [];
  return (
    <PageSection title="Таймеры">
      {timers.isPending ? <p role="status">Загружаю расписание…</p> : timers.isError ? (
        <p role="alert">Не удалось загрузить расписание.</p>
      ) : upcoming.length === 0 ? <p>Ближайших срабатываний нет.</p> : (
        <TimerRows rows={upcoming.slice(0, 4)} />
      )}
      {Boolean(timers.data?.sleeps.length) && <p className="text-sm text-muted-foreground">Ожидают пробуждения · {timers.data?.sleeps.length}</p>}
      <PageLink to="/timers" className="text-sm text-primary hover:underline">Все таймеры →</PageLink>
    </PageSection>
  );
}

function Timers() {
  const timers = useCall(list, {}, { refreshOn });
  const events = useProjection(recent);
  const upcoming = timers.data ? pending(timers.data.timers) : [];
  const next = upcoming[0];
  const finished = timers.data?.timers.filter((entry) => entry.nextDue === null) ?? [];
  const names = new Map(timers.data?.timers.map((entry) => [entry.name, nameOf(entry)]));
  return (
    <>
      <PageSection title="Расписание">
        {timers.isPending ? <p role="status">Загружаю расписание…</p> : timers.isError ? (
          <p role="alert">Не удалось загрузить расписание.</p>
        ) : next === undefined || next.nextDue === null ? <p>Предстоящих срабатываний нет.</p> : (
          <>
            <div className="rounded-md border bg-card px-4 py-2">
              <p className="text-sm text-muted-foreground">Ближайшее срабатывание</p>
              <p className="mt-1 text-base font-semibold wrap-anywhere">{nameOf(next)}</p>
              <p className="mt-1 flex flex-wrap gap-2 text-sm">
                <Clock at={next.nextDue} />
                {next.schedule.kind !== "at" && <span className="text-muted-foreground"><Schedule value={next.schedule} /></span>}
              </p>
            </div>
            {upcoming.length > 1 && <TimerRows rows={upcoming.slice(1)} />}
          </>
        )}
      </PageSection>
      <WaitingSteps sleeps={timers.data?.sleeps ?? []} />
      {finished.length > 0 && <PageSection title="Без следующего срабатывания"><TimerRows rows={finished} /></PageSection>}
      <PageSection title="Последние срабатывания и пробуждения">
        {events.length === 0 ? <p>Срабатываний и пробуждений пока нет.</p> : (
          <ul className="divide-y">
            {events.toReversed().map((record) => {
              const parsed = firing.safeParse(record.data);
              const fired = record.type === "timer.fired";
              const title = fired && parsed.success
                ? names.get(parsed.data.timer) ?? parsed.data.timer
                : fired ? "Срабатывание таймера" : "Шаг возобновлён";
              return (
                <li key={record.id} className="min-w-0 flex flex-col gap-1 py-2">
                  <p className="font-medium wrap-anywhere">{title}</p>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">{fired ? "Срабатывание" : "Пробуждение"}</Badge>
                    <Clock at={record.at} />
                    <PageLink to={"/journal?record=" + encodeURIComponent(record.id)} className="text-primary hover:underline">В журнале</PageLink>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PageSection>
    </>
  );
}

export default definePlugin({
  id: "timers",
  setup(ctx) {
    if (!ctx.viewer.can(list)) return;
    ctx.pages.add({ path: "/timers", title: "Таймеры", nav: { order: 37 }, commandHeading: true, component: Timers });
    ctx.slots.register("home.tile", { key: "timers", order: 30, component: TimerTile });
  },
});
