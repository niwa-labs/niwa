import { recordList, SlotItem, useProjection, type StoredRecord } from "@niwa-labs/cockpit-sdk";
import { CopyValue, DataValue } from "@niwa-labs/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import "./journal.css";

export const JOURNAL_LIMIT = 500;
const RECENT = recordList({}, JOURNAL_LIMIT);
const clock = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hourClock = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long", year: "numeric" });
const dateTime = new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "medium" });

const families: Readonly<Record<string, string>> = {
  niwa: "Хост",
  workflow: "Сценарии",
  session: "Сессии",
  task: "Задачи",
  request: "Запросы",
  timer: "Таймеры",
  message: "Сообщения",
  rin: "Рин",
  git: "Git",
  forge: "Репозитории",
};

const eventNames: Readonly<Record<string, string>> = {
  "niwa.access.granted": "Выданы полномочия",
  "niwa.access.closed": "Закрыты полномочия",
  "niwa.access.decided": "Проверен доступ",
  "niwa.call.began": "Начат вызов",
  "niwa.call.settled": "Завершён вызов",
  "niwa.invocation.admitted": "Обработчик принял событие",
  "niwa.invocation.state": "Изменилось состояние обработчика",
  "niwa.plugin.installed": "Установлен модуль",
  "niwa.plugin.uninstalled": "Удалён модуль",
  "niwa.record.refused": "Запись отклонена",
  "niwa.state.changed": "Обновлено состояние",
  "niwa.state.read": "Прочитано состояние",
  "niwa.step.decision": "Принято решение по шагу",
  "niwa.step.intent": "Начат шаг",
  "niwa.step.outcome": "Получен результат шага",
  "niwa.subscription.position": "Обновилась позиция подписки",
  "message.sent": "Отправлено сообщение",
  "message.received": "Получено сообщение",
  "history.session.ended": "В историю добавлено завершение сессии",
  "request.created": "Создан запрос",
  "request.answered": "Получен ответ",
  "session.started": "Начата сессия",
  "session.ended": "Завершена сессия",
  "session.turn.started": "Начался ход сессии",
  "session.turn.ended": "Завершился ход сессии",
  "task.created": "Создана задача",
  "task.done": "Завершена задача",
  "timer.fired": "Сработал таймер",
  "workflow.run.requested": "Запрошен запуск",
  "workflow.run.started": "Начался запуск",
  "workflow.run.finished": "Завершился запуск",
};

type ChainRecord = {
  id: string;
  type: string;
  at: number;
  data: unknown;
  actor: string;
  depth: number;
};

type Chain = { causes: ChainRecord[]; trace: ChainRecord[] };

function familyOf(type: string): string {
  const separator = type.indexOf(".");
  return separator < 0 ? type : type.slice(0, separator);
}

function familyLabel(family: string): string {
  return Object.hasOwn(families, family) ? families[family]! : family;
}

function eventLabel(type: string): string {
  return Object.hasOwn(eventNames, type) ? eventNames[type]! : type;
}

function authorOf({ actor }: StoredRecord): string {
  if (actor.kind === "client") return actor.principal?.id ?? actor.id;
  return actor.kind === "handler" ? actor.handler : "host";
}

function authorLabel(author: string): string {
  return author === "host" ? "Хост" : author;
}

function objectOf(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function isSummaryText(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const text = value.trim();
  return !((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")));
}

function summaryOf({ data }: { data: unknown }): string | undefined {
  const item = objectOf(data);
  const input = objectOf(item?.input);
  const subject = objectOf(item?.principal);
  const outcome = objectOf(item?.outcome);
  const file = typeof item?.file === "string" ? item.file.split(/[\\/]/).at(-1) : undefined;
  const candidate = [
    item?.title, item?.action, item?.label, item?.description, input?.title, input?.text, item?.text,
    item?.reason, outcome?.reason, item?.phase, file, item?.question, item?.state, item?.name, item?.handler, item?.plugin, subject?.id,
    item?.session, item?.run, item?.task, item?.request, item?.timer, item?.key, item?.note, item?.id,
    data,
  ].find(isSummaryText);
  if (candidate === undefined) return undefined;
  const line = candidate.trim().replace(/\s+/g, " ");
  return line.length <= 145 ? line : line.slice(0, 144) + "…";
}

function searchData(data: unknown, needle: string): boolean {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.some((value) => searchData(value, needle));
  if (typeof data === "object")
    return Object.entries(data).some(([key, value]) => key.toLowerCase().includes(needle) || searchData(value, needle));
  return String(data).toLowerCase().includes(needle);
}

function hourOf(at: number): number {
  const date = new Date(at);
  return at - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
}

function shortReference(value: string): string {
  return value.length <= 30 ? value : value.slice(0, 16) + "…" + value.slice(-11);
}

function DateStamp({ at, format }: { at: number; format: Intl.DateTimeFormat }) {
  return <time dateTime={new Date(at).toISOString()} title={dateTime.format(at)}>{format.format(at)}</time>;
}

function RecordRow({ record, open }: { record: StoredRecord; open: () => void }) {
  const summary = summaryOf(record);
  const author = authorOf(record);
  const family = familyOf(record.type);
  return (
    <button type="button" data-slot="record" onClick={open} className="journal-row">
      <span className="journal-when"><DateStamp at={record.at} format={clock} /> <span>#{record.seq}</span></span>
      <span className="journal-line">
        <span className="journal-event">{eventLabel(record.type)}</span>
        {summary && <span className="journal-summary">{summary}</span>}
      </span>
      <span className="journal-by">
        <span className="journal-family" data-family={family}>{familyLabel(family)}</span>
        {authorLabel(author) !== familyLabel(family) && <span className="journal-author" title={author}>{authorLabel(author)}</span>}
      </span>
    </button>
  );
}

function Overview({ records, family, hour, setFamily, setHour }: {
  records: readonly StoredRecord[];
  family: string;
  hour: number | undefined;
  setFamily: (value: string) => void;
  setHour: (value: number | undefined) => void;
}) {
  const groups = new Map<string, number>();
  const hours = new Map<number, number>();
  for (const record of records) {
    const group = familyOf(record.type);
    const stamp = hourOf(record.at);
    if (hour === undefined || hour === stamp) groups.set(group, (groups.get(group) ?? 0) + 1);
    if (!family || family === group) hours.set(stamp, (hours.get(stamp) ?? 0) + 1);
  }
  return (
    <details className="journal-overview">
      <summary>Активность по семействам и часам</summary>
      <div className="journal-overview-body">
        <div>
          <h2>Семейства</h2>
          <div className="journal-slices">
            {[...groups].sort((a, b) => b[1] - a[1]).map(([name, count]) => (
              <button key={name} type="button" aria-pressed={family === name} onClick={() => setFamily(family === name ? "" : name)}>
                <span>{familyLabel(name)}</span><b>{count}</b>
              </button>
            ))}
            {groups.size === 0 && <p>Нет событий</p>}
          </div>
        </div>
        <div>
          <h2>Часы</h2>
          <div className="journal-slices">
            {[...hours].sort((a, b) => b[0] - a[0]).map(([stamp, count]) => (
              <button key={stamp} type="button" aria-pressed={hour === stamp} onClick={() => setHour(hour === stamp ? undefined : stamp)}>
                <DateStamp at={stamp} format={hourClock} /><b>{count}</b>
              </button>
            ))}
            {hours.size === 0 && <p>Нет событий</p>}
          </div>
        </div>
      </div>
    </details>
  );
}

function TraceList({ records, title, open }: { records: ChainRecord[]; title: string; open: (id: string) => void }) {
  const [limit, setLimit] = useState(8);
  if (!records.length) return null;
  return (
    <section className="journal-trace-group">
      <h3>{title} · {records.length}</h3>
      <ol>
        {records.slice(0, limit).map((record) => {
          const summary = summaryOf(record);
          return (
            <li key={record.id} data-depth={Math.min(record.depth, 3)}>
              <button type="button" className="journal-trace-link" onClick={() => open(record.id)}>
                <span>{eventLabel(record.type)}</span>
                {summary && <span className="journal-summary">{summary}</span>}
                <span className="journal-trace-meta">
                  <DateStamp at={record.at} format={dateTime} /> · {authorLabel(record.actor)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {records.length > limit && <button type="button" className="journal-action" onClick={() => setLimit(limit + 16)}>Показать ещё · {records.length - limit}</button>}
    </section>
  );
}

function RecordPanel({ records, record, id, close }: {
  records: readonly StoredRecord[];
  record: StoredRecord | undefined;
  id: string;
  close: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const currentId = history.at(-1) ?? id;
  const back = () => history.length ? setHistory(history.slice(0, -1)) : close();
  useEffect(() => {
    panel.current?.showModal();
  }, []);
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [currentId]);

  const chain = useQuery({
    queryKey: ["trace", currentId],
    queryFn: async ({ signal }) => {
      const response = await fetch("/trace-data/" + encodeURIComponent(currentId), { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Не удалось загрузить цепочку");
      return (await response.json()) as Chain;
    },
    retry: false,
  });
  const local = currentId === id ? record : records.find((row) => row.id === currentId);
  const origin = chain.data?.trace.find((row) => row.depth === 0);
  const item = local ?? origin;
  const summary = item && summaryOf(item);
  const author = local ? authorOf(local) : origin?.actor;
  const causes = chain.data?.causes ?? [];
  const consequences = chain.data?.trace.filter((row) => row.depth > 0) ?? [];
  const related = causes.length + consequences.length;

  return (
    <dialog ref={panel} className="desk-panel journal-panel" onCancel={(event) => { event.preventDefault(); back(); }} aria-labelledby="record-title">
      <button type="button" className="journal-action" onClick={back}>← Назад</button>
      <header>
        {item && item.type !== eventLabel(item.type) && <p className="journal-panel-type">{item.type}</p>}
        <h2 id="record-title">{item ? eventLabel(item.type) : "Запись журнала"}</h2>
        {summary && <p>{summary}</p>}
      </header>
      <dl className="journal-record-meta">
        <div><dt>Запись</dt><dd><CopyValue value={currentId} label={shortReference(currentId)} name="Скопировать ID записи" /></dd></div>
        {item && <div><dt>Время</dt><dd><DateStamp at={item.at} format={dateTime} /></dd></div>}
        {author && <div><dt>Автор</dt><dd>{authorLabel(author)}</dd></div>}
        {local && <div><dt>Позиция и поток</dt><dd>#{local.seq} · <CopyValue value={local.stream} label={shortReference(local.stream)} name="Скопировать поток" /></dd></div>}
        {local?.actor.issuedBy && <div><dt>Модуль</dt><dd>{local.actor.issuedBy}</dd></div>}
      </dl>
      <details className="journal-panel-section journal-chain">
        <summary>Причины и следствия{chain.data && " · " + related}</summary>
        {chain.isPending && <p role="status">Загружаем цепочку…</p>}
        {chain.isError && <p role="alert">Не удалось загрузить цепочку. <button type="button" className="journal-action" onClick={() => void chain.refetch()}>Повторить</button></p>}
        {chain.data === null && item && <p>Цепочка недоступна.</p>}
        {chain.data && (
          <>
            <TraceList key={currentId + ":causes"} records={causes} title="Причины" open={(next) => setHistory([...history, next])} />
            <TraceList key={currentId + ":effects"} records={consequences} title="Следствия" open={(next) => setHistory([...history, next])} />
            {related === 0 && <p>Связанных записей нет.</p>}
          </>
        )}
      </details>
      {!item && chain.isPending && <p role="status">Загружаем запись…</p>}
      {!item && chain.isError && <p>Запись недоступна.</p>}
      {!item && chain.data === null && <p>Запись не найдена.</p>}
      {item && (
        <section key={currentId} className="journal-panel-section">
          <h3>Данные события</h3>
          <DataValue value={item.data} />
        </section>
      )}
    </dialog>
  );
}

export function Journal({ recordId }: { recordId?: string | undefined } = {}) {
  const records = useProjection(RECENT);
  const [family, setFamily] = useState("");
  const [author, setAuthor] = useState("");
  const [hour, setHour] = useState<number>();
  const [search, setSearch] = useState("");
  const [selected, select] = useState<StoredRecord>();
  const [closedId, closeId] = useState("");
  const activeId = selected?.id ?? (recordId !== closedId ? recordId : undefined);
  const options = useMemo(() => {
    const authors = new Set<string>();
    const groups = new Set<string>();
    for (const record of records) {
      authors.add(authorOf(record));
      groups.add(familyOf(record.type));
    }
    return {
      authors: [...authors].sort((a, b) => authorLabel(a).localeCompare(authorLabel(b), "ru")),
      families: [...groups].sort((a, b) => familyLabel(a).localeCompare(familyLabel(b), "ru")),
    };
  }, [records]);

  const base = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return records.filter((record) => {
      const name = authorOf(record);
      if (author && name !== author) return false;
      if (!needle) return true;
      return [
        record.type, eventLabel(record.type), record.id, record.stream, "#" + record.seq, name, authorLabel(name),
      ].some((value) => value.toLowerCase().includes(needle)) || searchData(record.data, needle);
    });
  }, [records, author, search]);

  const visible = base.filter((record) =>
    (!family || familyOf(record.type) === family) && (hour === undefined || hourOf(record.at) === hour),
  ).toReversed();
  const reset = () => { setFamily(""); setAuthor(""); setHour(undefined); setSearch(""); };

  return (
    <article data-slot="journal" className="desk-page journal-page">
      <header className="journal-heading">
        <h1>Журнал хоста</h1>
        <p>Последние {JOURNAL_LIMIT} записей · сначала новые</p>
      </header>
      <div className="desk-tools journal-filters">
        <label>
          <span id="journal-filter-search">Поиск</span>
          <input aria-labelledby="journal-filter-search" type="search" value={search} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Тип, ID или данные" />
        </label>
        <label>
          <span id="journal-filter-family">Семейство</span>
          <select aria-labelledby="journal-filter-family" value={family} onChange={(event) => setFamily(event.target.value)}>
            <option value="">Все семейства</option>
            {options.families.map((name) => <option key={name} value={name}>{familyLabel(name)}</option>)}
            {family && !options.families.includes(family) && <option value={family}>{familyLabel(family)}</option>}
          </select>
        </label>
        <label>
          <span id="journal-filter-author">Автор</span>
          <select aria-labelledby="journal-filter-author" value={author} onChange={(event) => setAuthor(event.target.value)}>
            <option value="">Все авторы</option>
            {options.authors.map((name) => <option key={name} value={name}>{authorLabel(name)}</option>)}
            {author && !options.authors.includes(author) && <option value={author}>{authorLabel(author)}</option>}
          </select>
        </label>
      </div>
      <div className="journal-state">
        <p role="status">Показано {visible.length} из {records.length}</p>
        {hour !== undefined && <button type="button" className="journal-action" onClick={() => setHour(undefined)}>Убрать час · {hourClock.format(hour)} ×</button>}
        {(family || author || search || hour !== undefined) && <button type="button" className="journal-action" onClick={reset}>Сбросить фильтры</button>}
      </div>
      {!!records.length && <Overview records={base} family={family} hour={hour} setFamily={setFamily} setHour={setHour} />}
      {!visible.length ? (
        <p className="journal-empty">{records.length ? "Совпадений нет." : "В журнале пока нет записей."}</p>
      ) : (
        <ol className="journal-list">
          {visible.map((record, index) => {
            const previous = visible[index - 1];
            const newDay = previous === undefined || day.format(record.at) !== day.format(previous.at);
            return (
              <li key={record.id}>
                {newDay && <h2 className="journal-date"><DateStamp at={record.at} format={day} /></h2>}
                <SlotItem name="record.view" itemKey={record.type} props={{ record }}
                  fallback={<RecordRow record={record} open={() => select(record)} />} />
              </li>
            );
          })}
        </ol>
      )}
      {activeId && <RecordPanel key={activeId} id={activeId} records={records} record={selected ?? records.find((record) => record.id === activeId)}
        close={() => { select(undefined); closeId(recordId ?? ""); }} />}
    </article>
  );
}
