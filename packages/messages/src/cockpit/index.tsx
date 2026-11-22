import { definePlugin, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { useState } from "react";
import { z } from "zod";

const address = z.object({ kind: z.string(), id: z.string().optional(), session: z.string().optional() });
const list = {
  name: "message.list",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        from: address,
        to: address,
        kind: z.string(),
        task: z.string().optional(),
      }),
    ),
  }),
};
const get = {
  name: "message.get",
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    from: address,
    to: address,
    body: z.record(z.string(), z.unknown()),
    task: z.string().optional(),
  }),
};
const refreshOn = { types: ["message.*"] };
function who(a: z.infer<typeof address>) {
  return a.id ?? a.session ?? a.kind;
}

function Messages() {
  const inbox = useCall(list, {}, { refreshOn });
  const [filter, setFilter] = useState("");
  const rows = inbox.data?.items
    .toReversed()
    .filter((m) =>
      [m.description, m.id, who(m.from), who(m.to), m.task].join(" ").toLowerCase().includes(filter.toLowerCase()),
    );
  return (
    <section className="desk-page">
      <h1>Сообщения</h1>
      <label>
        Поиск по тексту, участнику или задаче
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {inbox.error ? (
        <p role="alert">{inbox.error.message}</p>
      ) : !rows ? (
        <p>Загружаю сообщения…</p>
      ) : !rows.length ? (
        <p>{filter ? "Совпадений нет." : "Сообщений пока нет."}</p>
      ) : (
        <ul className="desk-list">
          {rows.map((m) => (
            <li key={m.id}>
              <PageLink to={"/messages/" + encodeURIComponent(m.id)}>{m.description}</PageLink>
              <small>
                {who(m.from)} → {who(m.to)} · {m.kind} · {m.id}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Message({ params }: PageProps<"/messages/$id">) {
  const message = useCall(get, { id: params.id }, { refreshOn });
  const m = message.data;
  return (
    <article className="desk-page">
      <PageLink to="/messages">← Сообщения</PageLink>
      <h1>Сообщение</h1>
      {m ? (
        <>
          <code>{m.id}</code>
          <p>
            {who(m.from)} → {who(m.to)}
          </p>
          <p>{String(m.body.text ?? "")}</p>
          <details>
            <summary>Содержимое</summary>
            <pre>{JSON.stringify(m.body, null, 2)}</pre>
          </details>
          {m.task && <PageLink to={"/tasks/" + m.task}>{m.task}</PageLink>}
        </>
      ) : (
        <p>{message.error?.message ?? "Загружаю…"}</p>
      )}
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
