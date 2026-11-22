import { PageLink, useCall, useViewer, type PageProps } from "@niwa-labs/cockpit-sdk";
import { z } from "zod";
import { useState } from "react";
import { Address } from "./actions.ts";
import { addressText } from "./answers.ts";

const states = ["open", "answered", "cancelled", "expired"] as const;
const glance = z.object({
  id: z.string(),
  description: z.string(),
  question: z.string(),
  status: z.enum(states),
  from: Address.optional(),
  to: Address,
});
const list = {
  name: "request.list",
  input: z.object({ status: z.enum(states).optional() }),
  output: z.object({ items: z.array(glance) }),
};
const get = {
  name: "request.get",
  input: z.object({ id: z.string() }),
  output: glance.extend({
    input: z.record(z.string(), z.unknown()),
    answer: z.unknown().optional(),
    by: Address.optional(),
  }),
};
const refreshOn = { types: ["request.*"] };
export function RequestHistory() {
  const viewer = useViewer();
  const [status, setStatus] = useState<"" | (typeof states)[number]>("");
  const result = useCall(list, status ? { status } : {}, { enabled: viewer.can(list), refreshOn });
  if (!viewer.can(list)) return null;
  return (
    <section className="desk-section">
      <h2>История запросов</h2>
      <label>
        Статус{" "}
        <select
          aria-label="Статус запросов"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="">Все</option>
          {states.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      {result.error ? (
        <p role="alert">{result.error.message}</p>
      ) : !result.data ? (
        <p>Загружаю…</p>
      ) : !result.data.items.length ? (
        <p>Запросов с таким статусом пока нет.</p>
      ) : (
        <ul className="desk-list">
          {result.data.items.toReversed().map((r) => (
            <li key={r.id}>
              <PageLink to={"/requests/" + r.id}>{r.description}</PageLink>{" "}
              <small>
                {r.status} · {r.id} · {addressText(r.to)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function RequestDetail({ params }: PageProps<"/requests/$id">) {
  const got = useCall(get, { id: params.id }, { refreshOn });
  const r = got.data;
  return (
    <article className="desk-page">
      <PageLink to="/requests">← Запросы</PageLink>
      {r ? (
        <>
          <h1>{r.description}</h1>
          <p>
            {r.id} · {r.status} · {addressText(r.to)}
          </p>
          <pre>{JSON.stringify(r.input, null, 2)}</pre>
          {r.answer !== undefined && (
            <section>
              <h2>Ответ</h2>
              <pre>{JSON.stringify(r.answer, null, 2)}</pre>
            </section>
          )}
          {r.status === "open" && <PageLink to="/requests">Ответить на запрос →</PageLink>}
        </>
      ) : (
        <p>{got.error?.message ?? "Загружаю запрос…"}</p>
      )}
    </article>
  );
}
