/** The runs of the host, in blocks by the directory they were started for. */

import { useCall, EntityLink, PageLink } from "@niwa-labs/cockpit-sdk";
import { Badge, MiniPhaseTrack, StateRing, cn, formatAgo, type WorkState } from "@niwa-labs/ui-kit";

import { runsAction, type RunEntry } from "./actions.ts";
import { groupByDirectory, type RunGroup } from "./groups.ts";

/** What a run's state is called in a ring: a paused run waits for a decision. */
export function ringOf(state: RunEntry["state"]): WorkState {
  return state === "paused" ? "waiting" : state === "running" ? "running" : "done";
}

function RunRow({ entry }: { entry: RunEntry }) {
  return (
    <li data-slot="run-row" data-state={entry.state} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StateRing state={ringOf(entry.state)} />
        <PageLink to={`/runs/${encodeURIComponent(entry.run)}`} className="min-w-0 wrap-anywhere text-sm font-semibold hover:underline focus-visible:underline">
          {entry.name}
        </PageLink>
      </div>
      {!!entry.phases?.length && <MiniPhaseTrack phases={entry.phases}/>}
      <div className="flex min-w-0 flex-wrap items-center gap-2 pl-4 text-xs text-muted-foreground">
        <EntityLink entity={{ kind: "run", id: entry.run }} short />
        {entry.requests > 0 && <Badge variant="secondary">Ожидают ответа: {entry.requests}</Badge>}
        <time className="tabular-nums" dateTime={entry.requestedAt}>
          {formatAgo(entry.requestedAt)}
        </time>
      </div>
    </li>
  );
}

/** One block: the directory, and the runs started for it. */
export function RunBlock({ group }: { group: RunGroup }) {
  return (
    <section data-slot="run-block" data-directory={group.directory ?? ""} className="min-w-0 rounded-lg border bg-card text-card-foreground">
      <header className="flex min-w-0 flex-col gap-1 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 wrap-anywhere text-sm font-semibold">{group.directory === undefined ? "Без проекта" : group.name}</h3>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{group.runs.length}</span>
        </div>
        {group.directory !== undefined && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={group.directory}>
            {group.directory}
          </span>
        )}
      </header>
      <ul className="m-0 list-none divide-y px-3">
        {group.runs.map((entry) => (
          <RunRow key={entry.run} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/** The runs grouped by directory. Reads again when a record of a workflow run arrives. */
export function Runs({ limit = 200, className }: { limit?: number; className?: string }) {
  const runs = useCall(runsAction, { limit }, { refreshOn: { types: ["workflow.run.*", "workflow.phase.*"] } });
  if (runs.isPending) return <p className="text-sm text-muted-foreground">Loading runs…</p>;
  if (runs.isError) return <p role="alert" className="text-sm text-destructive">The runs could not be read: {runs.error.message}</p>;
  const groups = groupByDirectory(runs.data.entries);
  if (groups.length === 0) return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  return (
    <div data-slot="runs" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {groups.map((group) => (
        <RunBlock key={group.directory ?? ""} group={group} />
      ))}
    </div>
  );
}
