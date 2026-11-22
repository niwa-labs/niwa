import { Check, Copy, FileText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/** Display labels can be short. The clipboard always receives the original value. */
export function CopyValue({ value, label, name }: { value: string; label?: ReactNode; name?: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (result === "idle") return;
    const t = setTimeout(() => setResult("idle"), 1900);
    return () => clearTimeout(t);
  }, [result]);
  return (
    <span className="nw-copy-wrap">
      <button
        type="button"
        className="nw-copy"
        data-slot="copy-value"
        title={value}
        aria-label={(name ?? "Скопировать") + " · " + value}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setResult("copied");
          } catch {
            setResult("failed");
          }
        }}
      >
        {label ?? value}
        {result === "copied" ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {result !== "idle" && (
        <small role="status">
          {result === "copied" ? (
            "Скопировано"
          ) : (
            <>
              <span>Скопируйте вручную</span>{" "}
              <input
                aria-label="Полное значение для копирования"
                readOnly
                value={value}
                onFocus={(e) => e.currentTarget.select()}
              />
            </>
          )}
        </small>
      )}
    </span>
  );
}
export function FileRef({ path }: { path: string }) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const file = parts.pop() || path,
    directory = parts.filter(Boolean).slice(-2).join("/");
  return (
    <CopyValue
      value={path}
      name="Скопировать путь"
      label={
        <span className="nw-file">
          <FileText size={15} />
          <span>
            <b>{file}</b>
            {directory && <small>{directory}/</small>}
          </span>
        </span>
      }
    />
  );
}
const fieldNames: Record<string, string> = {
  id: "Идентификатор",
  run: "Запуск",
  session: "Сессия",
  task: "Задача",
  from: "Отправитель",
  to: "Получатель",
  kind: "Вид",
  type: "Тип",
  text: "Текст",
  title: "Название",
  description: "Описание",
  detail: "Подробности",
  status: "Статус",
  state: "Состояние",
  message: "Сообщение",
  reason: "Причина",
  result: "Результат",
  outcome: "Итог",
  file: "Файл",
  directory: "Каталог",
  cwd: "Рабочий каталог",
  path: "Путь",
  owner: "Владелец",
  at: "Время",
  key: "Ключ",
  scope: "Область",
  action: "Действие",
  input: "Вход",
  answer: "Ответ",
  data: "Данные",
  actor: "Автор",
  branch: "Ветка",
  duration: "Длительность",
  version: "Версия",
  model: "Модель",
  harness: "Агент",
  name: "Имя",
  label: "Название",
  prompt: "Поручение",
  options: "Варианты",
  required: "Обязательно",
  workflow: "Сценарий",
  seq: "Позиция в журнале",
  root: "Начало цепочки",
  cause: "Причина",
  value: "Значение",
  invocation: "Вызов",
  attempt: "Попытка",
  operationId: "Операция",
  permissions: "Разрешения",
};
export const fieldLabel = (key: string) =>
  Object.hasOwn(fieldNames, key) ? fieldNames[key]! : key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
export const recordObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="nw-fold" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label}</summary>
      {open && children}
    </details>
  );
}
function Series({ values, depth }: { values: unknown[]; depth: number }) {
  const [limit, more] = useState(12);
  return (
    <>
      <ul className="nw-value-list">
        {values.slice(0, limit).map((v, i) => (
          <li key={i}>
            <DataValue value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
      {values.length > limit && (
        <button className="nw-more" type="button" onClick={() => more(limit + 24)}>
          Показать ещё · {values.length - limit}
        </button>
      )}
    </>
  );
}
export function DataValue({ value, field = "", depth = 0 }: { value: unknown; field?: string; depth?: number }) {
  if (value == null) return <span className="nw-quiet">Не задано</span>;
  if (typeof value === "boolean")
    return (
      <span className="nw-tag" data-tone={value ? "green" : "neutral"}>
        {value ? "Да" : "Нет"}
      </span>
    );
  if (typeof value === "number") {
    if (/^(at|createdAt|dueAt|nextDue|timestamp)$/.test(field) && value > 1e11 && value < 1e14)
      return <time>{new Date(value).toLocaleString("ru")}</time>;
    return <span className="nw-number">{value.toLocaleString("ru")}</span>;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return <DataValue value={JSON.parse(s)} depth={depth} field={field} />;
      } catch {
        /* Human text may contain brackets. */
      }
    }
    if (/^(\/|~\/|[A-Za-z]:[\\/])[^\n]+$/.test(s)) return <FileRef path={value} />;
    if (/^https?:\/\/[^\s]+$/i.test(s))
      return (
        <a className="nw-url" href={s} target="_blank" rel="noreferrer">
          {s}
        </a>
      );
    if (/^[a-z]{1,14}-[a-f0-9]{6,}$|^[a-f0-9]{16,}$/i.test(s))
      return <CopyValue value={value} label={s.length > 22 ? s.slice(0, 10) + "…" + s.slice(-5) : s} />;
    return <span className="nw-value-text">{s || "Пустая строка"}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="nw-quiet">Пока пусто</span>;
    const content = <Series values={value} depth={depth} />;
    return depth >= 2 ? <Disclosure label={"Список · " + value.length}>{content}</Disclosure> : content;
  }
  const object = recordObject(value);
  if (!object) return <span className="nw-quiet">Нет значения</span>;
  const entries = Object.entries(object);
  if (!entries.length) return <span className="nw-quiet">Нет полей</span>;
  const content = (
    <dl className="nw-fields">
      {entries.map(([key, v]) => (
        <div key={key}>
          <dt title={key}>{fieldLabel(key)}</dt>
          <dd>
            <DataValue value={v} field={key} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
  return depth >= 2 ? <Disclosure label={"Подробности · " + entries.length}>{content}</Disclosure> : content;
}
