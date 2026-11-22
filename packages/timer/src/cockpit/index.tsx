import { definePlugin, PageLink, useCall, useProjection, recordList } from "@niwa-labs/cockpit-sdk";
import { z } from "zod";
const schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), ms: z.number() }),
  z.object({ kind: z.literal("at"), at: z.number() }),
  z.object({ kind: z.literal("daily"), time: z.string() }),
]);
const list = {
  name: "timer.list",
  input: z.object({}),
  output: z.object({
    sleeps: z.array(z.string()),
    timers: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        schedule,
        nextDue: z.number().nullable(),
      }),
    ),
  }),
};
const recent = recordList({ types: ["timer.*"] }, 30);
function TimerList({ compact = false }: { compact?: boolean }) {
  const timers = useCall(list, {}, { refreshOn: { types: ["timer.*"] } });
  if (!timers.data) return <p>{timers.error?.message ?? "Загружаю таймеры…"}</p>;
  const all = timers.data.timers;
  const rows = compact ? all.toSorted((a, b) => (a.nextDue ?? Infinity) - (b.nextDue ?? Infinity)).slice(0, 4) : all;
  return (
    <>
      <ul className="desk-list">
        {rows.map((t) => (
          <li key={t.name}>
            <b>{t.description}</b>
            <small>
              {t.name} ·{" "}
              {t.schedule.kind === "daily"
                ? "Ежедневно " + t.schedule.time
                : t.schedule.kind === "every"
                  ? "Каждые " + t.schedule.ms / 1000 + " с"
                  : new Date(t.schedule.at).toLocaleString("ru")}
              {t.nextDue !== null && " · следующий " + new Date(t.nextDue).toLocaleString("ru")}
            </small>
          </li>
        ))}
      </ul>
      {!all.length && <p>Таймеров пока нет.</p>}
      {!!timers.data.sleeps.length && (
        <>
          <h3>Ожидают пробуждения</h3>
          {timers.data.sleeps.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </>
      )}
    </>
  );
}
function TimerTile() {
  return (
    <section className="desk-section">
      <h2>Таймеры</h2>
      <TimerList compact />
      <PageLink to="/timers">Все таймеры →</PageLink>
    </section>
  );
}
function Timers() {
  const events = useProjection(recent);
  return (
    <article className="desk-page">
      <h1>Таймеры и пробуждения</h1>
      <section className="desk-section">
        <h2>Расписание</h2>
        <TimerList />
      </section>
      <section className="desk-section">
        <h2>Последние события</h2>
        {!events.length && <p>Событий таймеров в последних записях нет.</p>}
        {events.toReversed().map((r) => (
          <details key={r.id}>
            <summary>
              {new Date(r.at).toLocaleString("ru")} · {r.type}
            </summary>
            <pre>{JSON.stringify(r.data, null, 2)}</pre>
          </details>
        ))}
      </section>
    </article>
  );
}
export default definePlugin({
  id: "timers",
  setup(ctx) {
    if (!ctx.viewer.can(list)) return;
    ctx.pages.add({ path: "/timers", title: "Таймеры", nav: { order: 37 }, component: Timers });
    ctx.slots.register("home.tile", { key: "timers", order: 30, component: TimerTile });
  },
});
