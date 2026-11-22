import { PageLink, useCall, useViewer, type HomeTileProps } from "@niwa-labs/cockpit-sdk";
import { useEffect, useMemo } from "react";
import { runsAction, type RunEntry } from "./actions.ts";
import { catalogueEvents } from "./catalogue-actions.ts";
import { ActivityLabel, MiniPhaseTrack } from "@niwa-labs/ui-kit";
import { RunTrack } from "./track.tsx";
import { RunCommands } from "./run-commands.tsx";

const groups = [
  ["decision", "Ожидают решения"],
  ["running", "В работе"],
  ["waiting", "Ожидают события"],
  ["finished", "Завершились"],
] as const;
function bucket(run: RunEntry) {
  if (run.state === "finished") return "finished";
  if (run.requests || run.manualPause || run.state === "paused") return "decision";
  return /^(sleep |wait )/.test(run.waiting ?? "") ? "waiting" : "running";
}
function useRuns() {
  return useCall(runsAction, {}, { refreshOn: catalogueEvents });
}

export function RunSummary({ project }: HomeTileProps) {
  const runs = useRuns();
  const visible = runs.data?.entries.filter((r) => !project || r.directory === project);
  return (
    <div className="desk-strip">
      {groups.map(([key, title]) => {
        const count = visible?.filter((r) => bucket(r) === key).length;
        return (
          <button
            key={key}
            data-kind={key}
            disabled={!count}
            onClick={() => document.getElementById("group-" + key)?.scrollIntoView({ block: "start" })}
          >
            <span>{title}</span>
            <b>{count ?? "—"}</b>
            <span className="desk-meter" aria-hidden>
              {Array.from({ length: Math.min(count ?? 0, 24) }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DashboardRuns({ project, reportProjects }: HomeTileProps) {
  const runs = useRuns();
  const viewer = useViewer();
  const directories = useMemo(
    () => [...new Set(runs.data?.entries.flatMap((r) => (r.directory ? [r.directory] : [])))],
    [runs.data],
  );
  useEffect(() => reportProjects?.(directories), [directories, reportProjects]);
  const visible = runs.data?.entries.filter((r) => !project || r.directory === project);
  return (
    <section className="desk-section" data-slot="runs-tile">
      <header className="desk-tools">
        <h2>Workflow</h2>
        {viewer.can("workflow.start") && (
          <PageLink
            className="desk-primary"
            to={"/workflows/launch" + (project ? "?project=" + encodeURIComponent(project) : "")}
          >
            ▶ Запустить workflow
          </PageLink>
        )}
        <PageLink to="/workflows">Каталог сценариев</PageLink>
      </header>
      {runs.error ? (
        <p role="alert">{runs.error.message}</p>
      ) : !visible ? (
        <p>Загружаю запуски…</p>
      ) : (
        !visible.length && <p>Пока нет запусков</p>
      )}
      {groups.map(([key, title]) => {
        const entries = visible?.filter((r) => bucket(r) === key);
        if (!entries?.length) return null;
        return (
          <section className="desk-group" id={"group-" + key} key={key}>
            <h3>
              {title} · {entries.length}
            </h3>
            {entries
              .toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt))
              .map((r, index) => {
                const compact = entries.length > 4 && index >= 3;
                const current = r.phases?.flatMap((p, i) =>
                  p.state === "current" ? [p.title + " (" + (i + 1) + "/" + r.phases!.length + ")"] : [],
                );
                return (
                  <article
                    data-slot="run-row"
                    data-kind={key}
                    key={r.run}
                    className={compact ? "desk-run compact-run" : "desk-run"}
                  >
                    <div className="desk-tools">
                      <PageLink to={"/runs/" + r.run}>{r.name}</PageLink>
                      {compact && r.phases && (
                        <MiniPhaseTrack
                          phases={r.phases.map((p) => ({
                            ...p,
                            activity: p.state === "current" && key === "waiting" ? "timer" : undefined,
                          }))}
                        />
                      )}
                      {r.state !== "finished" && !!current?.length && (
                        <small className="desk-current">{current.join(", ")}</small>
                      )}
                      <small title={r.directory}>
                        {r.directory?.split("/").filter(Boolean).at(-1)} ·{" "}
                        {new Date(r.requestedAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}
                      </small>
                      <code>{r.run}</code>
                      <RunCommands run={r.run} state={r.state} workflow={r.workflow} compact={compact} />
                    </div>
                    {compact ? (
                      <ActivityLabel activity={key === "waiting" ? "timer" : key === "running" ? "working" : undefined}>
                        {r.waiting ?? r.about}
                      </ActivityLabel>
                    ) : (
                      <RunTrack entry={r} />
                    )}
                    {r.requests > 0 && <PageLink to="/requests">Ждут ответа · {r.requests}</PageLink>}
                  </article>
                );
              })}
          </section>
        );
      })}
    </section>
  );
}
