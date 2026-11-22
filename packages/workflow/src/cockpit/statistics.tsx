import { useCall } from "@niwa-labs/cockpit-sdk";
import { formatDuration, PageSection } from "@niwa-labs/ui-kit";
import { useState } from "react";
import type { Measures } from "../stats.ts";
import { catalogue, catalogueEvents } from "./catalogue-actions.ts";

const percent = (rate: number | null) => (rate === null ? "—" : Math.round(rate * 100) + "%");
const duration = (ms?: number) => (ms === undefined ? "—" : formatDuration(ms));
const metrics: [string, (m: Measures) => string | number][] = [
  ["Запуски", (m) => m.runs],
  ["Выполнены", (m) => m.outcomes.done],
  ["Ошибки", (m) => m.outcomes.failed],
  ["Остановлены", (m) => m.outcomes.cancelled],
  ["На паузе", (m) => m.outcomes.paused],
  ["В работе", (m) => m.outcomes.running],
  ["Без участия человека", (m) => percent(m.cleanRate)],
  ["Медиана", (m) => duration(m.duration?.p50)],
  ["p90", (m) => duration(m.duration?.p90)],
];

export function Statistics({ id, versions = [] }: { id?: string; versions?: string[] }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [compare, setCompare] = useState<[string, string]>();
  const result = useCall(catalogue.stats, id ? { id } : {}, { refreshOn: catalogueEvents });
  const compared = useCall(
    catalogue.stats,
    { id: id ?? "", ...(compare ? { compare } : {}) },
    { enabled: !!compare, refreshOn: catalogueEvents },
  );
  const stats = result.data;
  if (!stats) return <p role="status">{result.error?.message ?? "Загружаю статистику…"}</p>;
  const m = stats.total;
  const times = [
    { label: "Агенты", value: m.time.agentMs, color: "var(--state-running)" },
    { label: "Ответы человека", value: m.time.humanMs, color: "var(--state-waiting)" },
    { label: "Таймеры", value: m.time.timerMs, color: "var(--state-done)" },
    { label: "Прочее", value: m.time.otherMs, color: "var(--muted-foreground)" },
  ];
  return (
    <PageSection title="Как идут сценарии">
      <dl className="desk-metrics">
        {metrics.map(([label, read]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{read(m)}</dd>
          </div>
        ))}
      </dl>
      {m.runs > 0 && (
        <div>
          <div className="desk-time-bar" aria-hidden>
            {times
              .filter((t) => t.value > 0)
              .map((t) => (
                <i key={t.label} style={{ flexGrow: t.value, background: t.color }} />
              ))}
          </div>
          <ul className="desk-time-key">
            {times.map((t) => (
              <li key={t.label}>
                <i style={{ background: t.color }} />
                {t.label} {duration(t.value)}
              </li>
            ))}
          </ul>
          {!!m.failures.length && <h3>Где ломаются</h3>}
          {m.failures.map((f) => (
            <p key={f.phase ?? ""}>
              {f.phase ?? "Вне фаз"} · ошибок {f.count}
            </p>
          ))}
          {m.agentCalls.map((c) => (
            <p key={c.harness + c.model}>
              {c.harness} · {c.model} · вызовов {c.calls}, ошибок {c.failed} · {duration(c.ms)}
            </p>
          ))}
        </div>
      )}
      {stats.scope === "all" &&
        stats.workflows
          .filter((w) => w.subject.kind === "script")
          .map(
            (w) =>
              w.subject.kind === "script" && (
                <p key={w.subject.file}>
                  <code>{w.subject.file}</code> · запусков {w.measures.runs}
                </p>
              ),
          )}
      {stats.scope === "workflow" &&
        stats.versions.map((v) => (
          <p key={v.version}>
            <code>{v.version.slice(0, 8)}</code> · запусков {v.measures.runs} · без участия человека{" "}
            {percent(v.measures.cleanRate)}
          </p>
        ))}
      {versions.length >= 2 && (
        <form
          className="desk-form"
          onSubmit={(e) => {
            e.preventDefault();
            setCompare([a || versions.at(-2)!, b || versions.at(-1)!]);
          }}
        >
          <div className="desk-tools">
            {[
              ["Первая версия", a || versions.at(-2)!],
              ["Вторая версия", b || versions.at(-1)!],
            ].map(([title, val], i) => (
              <label key={title}>
                {title}
                <select value={val} onChange={(e) => (i ? setB : setA)(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {v.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button disabled={(a || versions.at(-2)) === (b || versions.at(-1))}>Сравнить</button>
          </div>
          {compare && compared.error && <p role="alert">{compared.error.message}</p>}
          {compare && compared.data?.scope === "workflow" && (
            <table>
              <thead>
                <tr>
                  <th>Метрика</th>
                  {compared.data.versions.map((v) => (
                    <th key={v.version}>{v.version.slice(0, 8)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map(([label, read]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    {compared.data?.scope === "workflow" &&
                      compared.data.versions.map((v) => <td key={v.version}>{read(v.measures)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </form>
      )}
      {stats.caveats.length > 0 && (
        <details>
          <summary>Как считается статистика</summary>
          {stats.caveats.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </details>
      )}
    </PageSection>
  );
}
