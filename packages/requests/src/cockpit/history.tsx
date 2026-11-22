import { PageLink, useCall, useViewer, type PageProps } from "@niwa-labs/cockpit-sdk";
import { Badge, CopyValue, DataValue, PageSection, SchemaView } from "@niwa-labs/ui-kit";
import { useState } from "react";
import { z } from "zod";

import { Address, Answer, Question } from "./actions.ts";
import { AnswerForm } from "./answer-form.tsx";
import { addressText } from "./answers.ts";

const closedStates = ["answered", "cancelled", "expired"] as const;
const states = z.enum(["open", ...closedStates]);
type State = z.infer<typeof states>;

const LABELS: Record<State, string> = {
  open: "Ждёт ответа",
  answered: "Есть ответ",
  cancelled: "Отменён",
  expired: "Срок истёк",
};
const glance = z.object({
  id: z.string(),
  description: z.string(),
  status: states,
  from: Address.optional(),
  to: Address,
  deadline: z.number().optional(),
});
const list = {
  name: "request.list",
  input: z.object({ status: states.optional() }),
  output: z.object({ items: z.array(glance) }),
};
const get = {
  name: "request.get",
  input: z.object({ id: z.string() }),
  output: glance.extend({
    input: Question,
    question: z.string(),
    answerPolicy: z.literal("owner-only").optional(),
    answer: Answer.optional(),
    by: Address.optional(),
  }),
};
const refreshOn = { types: ["request.*"] };

function RequestStatus({ status }: { status: State }) {
  return <Badge variant={status === "answered" ? "default" : "secondary"}>{LABELS[status]}</Badge>;
}

export function RequestHistory() {
  const viewer = useViewer();
  const [status, setStatus] = useState<"" | (typeof closedStates)[number]>("");
  const result = useCall(list, status ? { status } : {}, { enabled: viewer.can(list), refreshOn });
  if (!viewer.can(list)) return null;
  const entries = result.data?.items.filter((request) => request.status !== "open").toReversed();
  return (
    <PageSection title="История запросов" actions={
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Статус
        <select
          aria-label="Статус запросов"
          className="rounded-md border bg-background px-2 py-1"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="">Все</option>
          {closedStates.map((state) => <option value={state} key={state}>{LABELS[state]}</option>)}
        </select>
      </label>
    }>
      {result.isError ? (
        <p role="alert">Не удалось загрузить историю запросов.</p>
      ) : entries === undefined ? (
        <p role="status">Загружаю историю…</p>
      ) : entries.length === 0 ? (
        <p>{status ? "Запросов с таким статусом нет." : "Закрытых запросов пока нет."}</p>
      ) : (
        <ul className="divide-y">
          {entries.map((request) => (
            <li key={request.id} className="min-w-0 flex flex-col gap-1 py-2">
              <PageLink to={"/requests/" + encodeURIComponent(request.id)} className="text-base font-semibold wrap-anywhere hover:underline">
                {request.description}
              </PageLink>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground wrap-anywhere">
                <RequestStatus status={request.status} />
                <span>Адресат · {addressText(request.to)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageSection>
  );
}

function AnswerValue({ input, answer }: { input: z.infer<typeof Question>; answer: z.infer<typeof Answer> }) {
  if ("text" in answer) return <p className="whitespace-pre-wrap wrap-anywhere">{answer.text}</p>;
  if ("form" in answer) return <DataValue value={answer.form} />;
  const options = "options" in input ? input.options : [];
  if (answer.ids.length === 0) return <p>Ни один вариант не выбран.</p>;
  return (
    <ul className="list-disc flex flex-col gap-1 px-4">
      {answer.ids.map((id) => <li className="wrap-anywhere" key={id}>{options.find((option) => option.id === id)?.label ?? id}</li>)}
    </ul>
  );
}

export function RequestDetail({ params }: PageProps<"/requests/$id">) {
  const got = useCall(get, { id: params.id }, { refreshOn });
  if (got.isPending) return <p role="status">Загружаю запрос…</p>;
  if (got.isError) return <p role="alert">Не удалось загрузить запрос.</p>;
  const request = got.data;
  return (
    <article className="desk-page">
      <header className="min-w-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <RequestStatus status={request.status} />
          <CopyValue value={request.id} name="Скопировать номер запроса" />
        </div>
        <h2 className="text-2xl font-semibold wrap-anywhere">{request.input.title}</h2>
      </header>
      {request.input.detail && <p className="whitespace-pre-wrap wrap-anywhere">{request.input.detail}</p>}
      <dl className="nw-fields">
        {request.from && <div><dt>Отправитель</dt><dd>{addressText(request.from)}</dd></div>}
        <div><dt>Адресат</dt><dd>{addressText(request.to)}</dd></div>
        {request.deadline !== undefined && (
          <div><dt>Срок ответа</dt><dd><DataValue value={request.deadline} field="at" /></dd></div>
        )}
      </dl>
      {request.input.kind === "form" && (
        <PageSection title="Поля формы"><SchemaView schema={request.input.schema} /></PageSection>
      )}
      {request.input.kind === "permission" && (
        <PageSection title="Условия разрешения"><DataValue value={request.input.subject} /></PageSection>
      )}
      {request.answer !== undefined && (
        <PageSection title="Ответ">
          {request.by && <p className="mb-2 text-sm text-muted-foreground wrap-anywhere">Ответил · {addressText(request.by)}</p>}
          <AnswerValue input={request.input} answer={request.answer} />
        </PageSection>
      )}
      {request.status === "open" && (
        <PageSection title="Ответ">
          <AnswerForm request={request} onSent={() => void got.refetch()} />
        </PageSection>
      )}
    </article>
  );
}
