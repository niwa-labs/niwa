/** The tasks of the host and one task with how it ended. */

import { EntityLink, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { Badge, StateRing } from "@niwa-labs/ui-kit";

import { getAction, listAction, type TaskItem } from "./actions.ts";

function who(address: { kind: string; id?: string | undefined; harness?: string | undefined }): string {
  if (address.harness !== undefined && address.id !== undefined) return `${address.kind} ${address.harness}/${address.id}`;
  return address.id === undefined ? address.kind : `${address.kind} ${address.id}`;
}

function TaskRow({ task }: { task: TaskItem }) {
  return (
    <li data-slot="task-row" data-status={task.status} className="flex min-w-0 items-center gap-3 py-2">
      <StateRing state={task.status === "done" ? "done" : "running"} label={task.status} />
      <PageLink to={`/tasks/${encodeURIComponent(task.id)}`} className="min-w-0 truncate text-sm font-medium hover:underline">
        {task.description}
      </PageLink>
      <EntityLink entity={{ kind: "task", id: task.id }} short />
      <Badge variant="secondary">{task.kind}</Badge>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{who(task.responsible)}</span>
    </li>
  );
}

export function TasksPage() {
  const tasks = useCall(listAction, {}, { refreshOn: { types: ["task.*"] } });
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Tasks</h2>
      {tasks.isPending ? (
        <p className="text-sm text-muted-foreground">Loading tasks…</p>
      ) : tasks.isError ? (
        <p role="alert" className="text-sm text-destructive">The tasks could not be read: {tasks.error.message}</p>
      ) : tasks.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <ul data-slot="tasks" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
          {tasks.data.items.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskPage({ params }: PageProps<"/tasks/$taskId">) {
  const task = useCall(getAction, { id: params.taskId }, { refreshOn: { types: ["task.*"] } });
  if (task.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading the task…</p>;
  if (task.isError) return <p role="alert" className="p-4 text-sm text-destructive">The task could not be read: {task.error.message}</p>;
  const { data } = task;
  return (
    <article data-slot="task-page" className="flex min-w-0 flex-col gap-3 p-4">
      <header className="flex min-w-0 items-center gap-2">
        <StateRing state={data.status === "done" ? (data.outcome?.status === "failure" ? "failed" : "done") : "running"} label={data.status} />
        <h2 className="min-w-0 truncate text-lg font-semibold">{data.description}</h2>
        <EntityLink entity={{ kind: "task", id: data.id }} />
      </header>
      <p className="whitespace-pre-wrap text-sm">{data.text}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{data.kind}</dd>
        <dt className="text-muted-foreground">Asked by</dt>
        <dd>{who(data.askedBy)}</dd>
        <dt className="text-muted-foreground">Responsible</dt>
        <dd>{who(data.responsible)}</dd>
        <dt className="text-muted-foreground">Reports to</dt>
        <dd>{who(data.reportTo)}</dd>
      </dl>
      {data.outcome === undefined ? (
        <p className="text-sm text-muted-foreground">Not finished yet.</p>
      ) : data.outcome.status === "failure" ? (
        <p role="status" className="text-sm text-destructive">Failed: {data.outcome.reason}</p>
      ) : (
        <pre data-slot="task-result" className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">{JSON.stringify(data.outcome.result, null, 2)}</pre>
      )}
    </article>
  );
}
