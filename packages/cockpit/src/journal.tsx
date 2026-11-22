import { recordList, SlotItem, useProjection, type StoredRecord } from "@niwa-labs/cockpit-sdk";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

export const JOURNAL_LIMIT = 500;
const RECENT = recordList({}, JOURNAL_LIMIT);
type Chain = { id: string; type: string; depth: number; at: number; data: unknown };
function RecordPanel({ record, id, close }: { record?: StoredRecord | undefined; id: string; close: () => void }) {
  const panel = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    panel.current?.showModal();
  }, []);
  const chain = useQuery({
    queryKey: ["trace", id],
    queryFn: async ({ signal }) => {
      const response = await fetch("/trace-data/" + encodeURIComponent(id), { signal });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as { causes: Chain[]; trace: Chain[] };
    },
  });
  const item = record ?? chain.data?.trace.find(r => r.depth === 0);
  return (
    <dialog ref={panel} className="desk-panel" onCancel={close} aria-labelledby="record-title">
      <button onClick={close}>← Назад</button>
      <h2 id="record-title">{item?.type ?? "Запись журнала"}</h2>
      <code>{id}</code>
      <p>
        {item && new Date(item.at).toLocaleString("ru")}{record && " · #" + record.seq + " · " + record.stream}
      </p>
      <pre>{JSON.stringify(item?.data, null, 2)}</pre>
      <h3>Причины и следствия</h3>
      {chain.error && <p role="alert">{chain.error.message}</p>}
      {chain.data && (
        <>
          <ul>
            {chain.data.causes.map((r) => (
              <li key={r.id}>
                {r.type} · {r.id}
              </li>
            ))}
          </ul>
          <ul>
            {chain.data.trace
              .filter((r) => r.depth > 0)
              .map((r) => (
                <li key={r.id}>
                  {r.type} · {r.id}
                </li>
              ))}
          </ul>
          {!chain.data.causes.length && !chain.data.trace.some((r) => r.depth > 0) && <p>Связанных записей нет.</p>}
        </>
      )}
    </dialog>
  );
}
function RecordRow({ record, open }: { record: StoredRecord; open: () => void }) {
  const data = JSON.stringify(record.data) ?? "";
  return (
    <button data-slot="record" onClick={open} className="flex w-full min-w-0 items-baseline gap-3 text-left text-sm">
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{record.seq}</span>
      <span className="shrink-0 font-medium">{record.type}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{data}</span>
    </button>
  );
}

export function Journal({ recordId }: { recordId?: string | undefined } = {}) {
  const records = useProjection(RECENT);
  const [family, setFamily] = useState("");
  const [search, setSearch] = useState("");
  const [selected, select] = useState<StoredRecord>();
  const [closedId, closeId] = useState("");
  const activeId = selected?.id ?? (recordId !== closedId ? recordId : undefined);
  const families = [...new Set(records.map((r) => r.type.split(".")[0]!))].sort();
  const visible = records
    .filter(
      (r) =>
        (!family || r.type.split(".")[0] === family) &&
        (!search ||
          [r.type, r.id, r.stream, JSON.stringify(r.data)].join(" ").toLowerCase().includes(search.toLowerCase())),
    )
    .toReversed();
  return (
    <article data-slot="journal" className="desk-page">
      <h1>Журнал хоста</h1>
      <div className="desk-tools">
        <label>
          Тип события
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">Все события</option>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Поиск
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ID, тип или данные"
          />
        </label>
        <small>
          {visible.length} из {records.length} последних записей
        </small>
      </div>
      {!visible.length ? (
        <p>{records.length ? "Совпадений нет." : "В журнале пока нет записей."}</p>
      ) : (
        <ol className="desk-list">
          {visible.map((r) => (
            <li key={r.id}>
              <SlotItem
                name="record.view"
                itemKey={r.type}
                props={{ record: r }}
                fallback={<RecordRow record={r} open={() => select(r)} />}
              />
            </li>
          ))}
        </ol>
      )}
      {activeId && <RecordPanel id={activeId} record={selected ?? records.find(r => r.id === activeId)} close={() => { select(undefined); closeId(recordId ?? ""); }} />}
    </article>
  );
}
