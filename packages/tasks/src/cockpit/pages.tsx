/** The host's tasks, grouped by state, with the contract and outcome of each task. */

import { EntityLink, PageCommands, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { CopyValue, DataValue, PageSection, SchemaView, StateRing } from "@niwa-labs/ui-kit";
import type { z } from "zod";

import { getAction, listAction, type Address, type TaskItem } from "./actions.ts";

const refreshOn = { types: ["task.*"] };

function TaskAddress({ address }: { address: z.infer<typeof Address> }) {
  if (address.kind === "owner") return <>Владелец</>;
  if (address.kind === "task" && address.id) return <EntityLink entity={{ kind: "task", id: address.id }} short />;
  if (address.kind === "session" && address.id) {
    const label = [address.harness, address.id].filter(Boolean).join(" · ");
    return <EntityLink entity={address.id} label={label} />;
  }
  return <>{address.id ?? address.kind}</>;
}

function TaskRow({ task }: { task: TaskItem }) {
  const done = task.status === "done";
  return (
    <li data-slot="task-row" data-status={task.status} className="flex min-w-0 items-start gap-3 py-2">
      <span className="mt-1 shrink-0">
        <StateRing state={done ? "done" : "running"} label={done ? "Завершена" : "В работе"} />
      </span>
      <div className="min-w-0 flex flex-col gap-1">
        <PageLink to={"/tasks/" + encodeURIComponent(task.id)} className="text-base font-semibold wrap-anywhere hover:underline">
          {task.description}
        </PageLink>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground wrap-anywhere">
          <span>{task.kind}</span>
          <span>Ответственный · <TaskAddress address={task.responsible} /></span>
        </div>
      </div>
    </li>
  );
}

export function TasksPage() {
  const tasks = useCall(listAction, {}, { refreshOn });
  if (tasks.isPending) return <p role="status">Загружаю задачи…</p>;
  if (tasks.isError) return <p role="alert">Не удалось загрузить задачи.</p>;
  const open = tasks.data.items.filter((task) => task.status === "open").toReversed();
  const done = tasks.data.items.filter((task) => task.status === "done").toReversed();
  return (
    <>
      <PageSection title="В работе">
        {open.length === 0 ? <p>Открытых задач нет.</p> : (
          <ul data-slot="tasks" className="divide-y">{open.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
        )}
      </PageSection>
      {done.length > 0 && (
        <PageSection title="Завершённые">
          <ul data-slot="completed-tasks" className="divide-y">{done.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
        </PageSection>
      )}
    </>
  );
}

export function TaskPage({ params }: PageProps<"/tasks/$taskId">) {
  const task = useCall(getAction, { id: params.taskId }, { refreshOn });
  if (task.isPending) return <p role="status">Загружаю задачу…</p>;
  if (task.isError) return <p role="alert">Не удалось загрузить задачу.</p>;
  const { data } = task;
  const state = data.status === "open" ? "running" : data.outcome?.status === "failure" ? "failed" : "done";
  const status = state === "running" ? "В работе" : state === "failed" ? "Не выполнена" : "Завершена";
  return (
    <article data-slot="task-page" className="desk-page">
      <header className="min-w-0 flex flex-col gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StateRing state={state} label={status} />
          <span>{status} · {data.kind}</span>
          <CopyValue value={data.id} name="Скопировать номер задачи" />
        </p>
        <h2 className="text-2xl font-semibold wrap-anywhere">{data.description}</h2>
        {data.status === "open" && (
          <PageCommands commands={[
            { action: "task.report", label: "Добавить отчёт", preset: { task: data.id } },
            { action: "task.finish", label: "Завершить задачу", preset: { task: data.id } },
          ]} />
        )}
      </header>
      {data.text !== data.description && <p className="whitespace-pre-wrap wrap-anywhere">{data.text}</p>}
      <PageSection title="Участники">
        <dl className="nw-fields">
          <div><dt>Поставил задачу</dt><dd><TaskAddress address={data.askedBy} /></dd></div>
          <div><dt>Ответственный</dt><dd><TaskAddress address={data.responsible} /></dd></div>
          <div><dt>Получатель отчёта</dt><dd><TaskAddress address={data.reportTo} /></dd></div>
        </dl>
      </PageSection>
      {data.outcome?.status === "failure" ? (
        <PageSection title="Почему задача не выполнена"><DataValue value={data.outcome.reason} /></PageSection>
      ) : data.outcome?.status === "result" ? (
        <PageSection title="Результат" data-slot="task-result"><DataValue value={data.outcome.result} /></PageSection>
      ) : data.result && (
        <PageSection title="Ожидаемый результат"><SchemaView schema={data.result} /></PageSection>
      )}
    </article>
  );
}
