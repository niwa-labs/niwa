import { definePlugin, EntityLink, PageCommands, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { Badge, CopyValue, DataValue, PageSection, SchemaView } from "@niwa-labs/ui-kit";
import { useState } from "react";
import { z } from "zod";

import { resultValue } from "../text.ts";

const kind = z.enum(["assignment", "update", "question", "answer", "result", "failure"]);
const labels: Record<z.infer<typeof kind>, string> = {
  assignment: "Поручение",
  update: "Сообщение",
  question: "Вопрос",
  answer: "Ответ",
  result: "Результат",
  failure: "Ошибка",
};
const address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() });
type Address = z.infer<typeof address>;
const list = {
  name: "message.list",
  input: z.object({}),
  output: z.object({
    items: z.array(z.object({
      id: z.string(),
      description: z.string(),
      from: address,
      to: address,
      kind,
      task: z.string().optional(),
    })),
  }),
};
const get = {
  name: "message.get",
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    from: address,
    to: address,
    body: z.object({
      type: kind,
      text: z.string(),
      kind: z.string().optional(),
      question: z.string().optional(),
      reason: z.string().optional(),
      result: z.unknown().optional(),
      data: z.unknown().optional(),
    }),
    task: z.string().optional(),
  }),
};
const refreshOn = { types: ["message.*"] };

function who(value: Address): string {
  if (value.kind === "owner") return "Владелец";
  if (value.kind === "session") return [value.harness, value.id].filter(Boolean).join(" · ");
  return value.id ?? value.kind;
}

function Participant({ value }: { value: Address }) {
  if (value.kind === "task" && value.id) return <EntityLink entity={{ kind: "task", id: value.id }} short />;
  if (value.kind === "session" && value.id) return <EntityLink entity={value.id} label={who(value)} />;
  return <>{who(value)}</>;
}

function Messages() {
  const inbox = useCall(list, {}, { refreshOn });
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const rows = inbox.data?.items.toReversed().filter((message) =>
    [message.description, labels[message.kind], message.id, who(message.from), who(message.to), message.task]
      .join(" ").toLowerCase().includes(query),
  );
  return (
    <>
      <label className="flex w-full max-w-lg flex-col gap-1 text-sm">
        Поиск по тексту, участнику или задаче
        <input
          type="search"
          className="w-full rounded-md border bg-background px-3 py-2"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {inbox.isError ? (
        <p role="alert">Не удалось загрузить сообщения.</p>
      ) : rows === undefined ? (
        <p role="status">Загружаю сообщения…</p>
      ) : rows.length === 0 ? (
        <p>{query ? "По этому запросу ничего не найдено." : "Сообщений пока нет."}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((message) => {
            const prefix = message.kind + ":";
            const subject = message.description.startsWith(prefix) ? message.description.slice(prefix.length).trim() : message.description;
            // An older host can cut a result that begins with a JSON object before the closing brace.
            const truncated = message.kind === "result" && /^\{\s*"[^"]+"\s*:/.test(subject) && subject.endsWith("…");
            return (
              <li key={message.id} className="min-w-0 flex flex-col gap-1 py-2">
                <PageLink to={"/messages/" + encodeURIComponent(message.id)} className="text-base font-semibold wrap-anywhere hover:underline">
                  {(truncated ? "" : subject) || labels[message.kind]}
                </PageLink>
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground wrap-anywhere">
                  <Badge variant="secondary">{labels[message.kind]}</Badge>
                  <span>{who(message.from)} → {who(message.to)}</span>
                  {message.task && <EntityLink entity={{ kind: "task", id: message.task }} label="Связанная задача" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Message({ params }: PageProps<"/messages/$id">) {
  const message = useCall(get, { id: params.id }, { refreshOn });
  if (message.isPending) return <p role="status">Загружаю сообщение…</p>;
  if (message.isError) return <p role="alert">Не удалось загрузить сообщение.</p>;
  const { data } = message;
  const { body } = data;
  const result = body.type === "result" ? resultValue(body.text) : undefined;
  const largeResult = body.type === "result" && body.text.startsWith("The result is ") &&
    body.text.includes("too large to carry in a message: it is kept as an artifact") && data.task !== undefined;
  const attachment = body.type === "result" && (
    body.data === body.text || (result !== undefined && JSON.stringify(body.data) === JSON.stringify(result))
  ) ? undefined : body.data;
  return (
    <article className="desk-page">
      <header className="min-w-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold">{labels[body.type]}</h2>
          <CopyValue value={data.id} name="Скопировать номер сообщения" />
        </div>
        {data.from.kind !== "owner" && (
          <PageCommands commands={[{ action: "message.send", label: "Ответить", preset: {
            to: data.from,
            ...(data.task && { task: data.task }),
            body: { type: "answer", ...(body.question && { question: body.question }) },
          } }]} />
        )}
      </header>
      {largeResult ? (
        <p>Полный результат доступен в карточке связанной задачи.</p>
      ) : result === undefined ? (
        <p className="whitespace-pre-wrap wrap-anywhere">{body.text}</p>
      ) : <PageSection title="Итог"><DataValue value={result} /></PageSection>}
      <PageSection title="О сообщении">
        <dl className="nw-fields">
          <div><dt>Отправитель</dt><dd><Participant value={data.from} /></dd></div>
          <div><dt>Получатель</dt><dd><Participant value={data.to} /></dd></div>
          {data.task && <div><dt>Задача</dt><dd><EntityLink entity={{ kind: "task", id: data.task }} /></dd></div>}
          {body.kind && <div><dt>Вид работы</dt><dd>{body.kind}</dd></div>}
          {body.reason && body.reason !== body.text && <div><dt>Причина</dt><dd><DataValue value={body.reason} /></dd></div>}
        </dl>
      </PageSection>
      {body.result !== undefined && <PageSection title="Ожидаемый результат"><SchemaView schema={body.result} /></PageSection>}
      {attachment !== undefined && <PageSection title="Приложение"><DataValue value={attachment} /></PageSection>}
    </article>
  );
}

export default definePlugin({
  id: "messages",
  setup(ctx) {
    ctx.pages.add({
      path: "/messages",
      title: "Сообщения",
      nav: { order: 32 },
      commandHeading: true,
      component: Messages,
      commands: [{ action: "message.send", label: "Написать сообщение", preset: { body: { type: "update" } } }],
    });
    ctx.pages.add({ path: "/messages/$id", panel: true, title: "Сообщение", component: Message });
    ctx.entities.register("message", {
      label: "Сообщение",
      prefix: "msg",
      href: (id) => "/messages/" + encodeURIComponent(id),
    });
  },
});
