/** The sessions of the host and the transcript of one of them. */

import { EntityLink, PageLink, useAction, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import {
  FileRef,
  Markdown,
  Message,
  MessageAvatar,
  MessageBubble,
  MessageContent,
  MessageHeader,
  PageSection,
  StateRing,
  ToolCall,
  Transcript,
  formatAgo,
  type WorkState,
} from "@niwa-labs/ui-kit";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeTileProps } from "@niwa-labs/cockpit-sdk";
import { listAction, readAction, sessionStateAction, type SessionEntry, type TranscriptRecord } from "./actions.ts";
import { SessionSandboxBadge } from "@niwa-labs/cockpit-sdk";
import { itemsOf, type TranscriptItem } from "./transcript.ts";

const RING: Readonly<Record<SessionEntry["state"], WorkState>> = { running: "running", idle: "waiting", ended: "done", unknown: "pending" };
const SESSION_STATE_LABEL: Readonly<Record<SessionEntry["state"], string>> = {
  running: "Идёт ход",
  idle: "Между ходами",
  ended: "Завершена",
  unknown: "Состояние неизвестно",
};

function SessionRow({ entry }: { entry: SessionEntry }) {
  const session = entry.id ?? entry.ref;
  const title = entry.title?.trim() || entry.model || entry.ref;
  return (
    <li data-slot="session-row" data-state={entry.state} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StateRing state={RING[entry.state]} label={SESSION_STATE_LABEL[entry.state]} aria-hidden="true" />
        <PageLink to={`/sessions/${encodeURIComponent(session)}`} className="min-w-0 wrap-anywhere text-sm font-semibold hover:underline focus-visible:underline">
          {title}
          {title !== session && <span className="sr-only"> · {session}</span>}
        </PageLink>
      </div>
      <div data-slot="session-meta" className="flex min-w-0 flex-wrap items-center gap-2 pl-4 text-xs text-muted-foreground">
        <span>{SESSION_STATE_LABEL[entry.state]}</span>
        {entry.id && <EntityLink entity={{ kind: "session", id: entry.id }} short />}
        {entry.run && <EntityLink entity={{ kind: "run", id: entry.run }} short />}
        {entry.model && entry.model !== title && <span className="min-w-0 wrap-anywhere">{entry.model}</span>}
        {entry.lastActivityAt !== undefined && (
          <time className="tabular-nums" dateTime={new Date(entry.lastActivityAt).toISOString()}>
            {formatAgo(entry.lastActivityAt)}
          </time>
        )}
      </div>
      {entry.id && <div className="pl-4 empty:hidden"><SessionSandboxBadge session={entry.ref} /></div>}
      {entry.cwd && <div className="min-w-0 pl-4 text-xs"><FileRef path={entry.cwd} /></div>}
    </li>
  );
}

export function SessionsTile({ project, reportProjects }: HomeTileProps) {
  const sessions = useCall(listAction, { managedOnly: true, limit: 500 }, { refreshOn: { types: ["session.*"] } });
  const dirs = useMemo(() => [...new Set(sessions.data?.sessions.flatMap(s => s.cwd ? [s.cwd] : []))], [sessions.data]);
  useEffect(() => reportProjects?.(dirs), [dirs, reportProjects]);
  const rows = sessions.data?.sessions.filter(s => !s.run && (!project || s.cwd === project)).slice(0, 30);
  return <PageSection title="Самостоятельные сессии">
    {sessions.error ? <p role="alert">{sessions.error.message}</p> : !rows ? <p>Загружаю…</p> : rows.length ? <ul>{rows.map(s => <SessionRow key={s.ref} entry={s} />)}</ul> : <p>Нет сессий вне запусков.</p>}
    <PageLink to="/sessions">Все сессии →</PageLink></PageSection>;
}

export function SessionsPage() {
  const [source, setSource] = useState<"managed" | "all">("managed");
  return (
    <>
      <div className="desk-tools" role="group" aria-label="Источник сессий">
        <button type="button" className={source === "managed" ? "desk-primary" : undefined} aria-pressed={source === "managed"} onClick={() => setSource("managed")}>
          Сессии Niwa
        </button>
        <button type="button" className={source === "all" ? "desk-primary" : undefined} aria-pressed={source === "all"} onClick={() => setSource("all")}>
          Вся история с диска
        </button>
      </div>
      <SessionResults key={source} managedOnly={source === "managed"} />
    </>
  );
}

function SessionResults({ managedOnly }: { managedOnly: boolean }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const sessions = useCall(listAction, { managedOnly, limit: 100, ...(cursor && { cursor }) }, { refreshOn: { types: ["session.*"] } });
  const nextCursor = sessions.data?.nextCursor;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {sessions.data?.unreadable?.map(h => <p role="status" key={h.harness}>{h.harness} · {h.reason}</p>)}
      {sessions.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">{managedOnly ? "Загружаю сессии…" : "Читаю историю с диска…"}</p>
      ) : sessions.isError ? (
        <p role="alert" className="text-sm text-destructive">Не удалось прочитать сессии: {sessions.error.message}</p>
      ) : sessions.data.sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Сессий пока нет.</p>
      ) : (
        <>
          <ul data-slot="sessions" aria-label={managedOnly ? "Сессии Niwa" : "Вся история с диска"} className="m-0 list-none divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {sessions.data.sessions.map((entry) => (
              <SessionRow key={entry.ref} entry={entry} />
            ))}
          </ul>
          {sessions.data.total > sessions.data.sessions.length ? (
            <p className="text-xs text-muted-foreground">
              Показано {sessions.data.sessions.length} из {sessions.data.total} сессий.
            </p>
          ) : null}
        </>
      )}
      {(cursor || nextCursor) && (
        <nav className="desk-tools" aria-label="Страницы списка сессий">
          {cursor && <button type="button" onClick={() => setCursors(c => c.slice(0, -1))}>← Предыдущие сессии</button>}
          {nextCursor && <button type="button" onClick={() => setCursors(c => [...c, nextCursor])}>Следующие сессии →</button>}
        </nav>
      )}
    </div>
  );
}

function shellCommand(name: string, input: unknown): string | undefined {
  if (!/^(bash|sh|shell|terminal|exec_command)$/i.test(name)) return undefined;
  const command = typeof input === "string" ? input
    : input && typeof input === "object" && "command" in input ? input.command
    : input && typeof input === "object" && "cmd" in input ? input.cmd : undefined;
  return typeof command === "string" ? command : undefined;
}

function runningToolTitle(name: string, input: unknown): string {
  const title = `Выполняется · ${name}`;
  const command = shellCommand(name, input);
  const program = typeof command === "string" ? /^\s*([\w./+-]+)(?:\s|$)/.exec(command)?.[1]?.split("/").at(-1) : undefined;
  return program && program !== name ? `${title} · ${program}` : title;
}

const targetLabels: Readonly<Record<string, string>> = {
  read: "Чтение файла", edit: "Изменение файлов", search: "Поиск", web: "Веб-запрос",
  plan: "План", subagent: "Поручение агенту", mcp: "Вызов MCP", other: "Параметры",
};

function ActiveTool({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const fields = item.input && typeof item.input === "object" ? Object.entries(item.input) : [];
  const description = fields.find(([key]) => key === "description")?.[1];
  const command = shellCommand(item.category === "shell" ? "shell" : item.name, item.input)
    ?? (item.category === "shell" ? item.target : undefined);
  const steps = item.category === "plan" ? fields.find(([key]) => ["plan", "todos", "items"].includes(key))?.[1] : undefined;
  const checklist = Array.isArray(steps) ? steps.flatMap(step => {
    if (typeof step === "string") return [step];
    const title = step?.step ?? step?.content ?? step?.text;
    return typeof title === "string" ? [`${["completed", "done"].includes(step.status ?? step.state) ? "✓" : "•"} ${title}`] : [];
  }).join("\n") : undefined;
  const target = checklist || (item.paths?.length ? item.paths.join("\n") : item.target);
  const label = targetLabels[item.category ?? "other"] ?? "Параметры";
  const keys = fields.map(([key]) => key).filter(key => key !== "description");
  const fallback = keys.length ? keys.join(", ") : undefined;
  return (
    <div data-slot="active-tool" className="mt-1.5 min-w-0 space-y-1">
      {typeof description === "string" && description.trim() && <p className="text-sm wrap-anywhere text-foreground">{description}</p>}
      {command ? (
        <pre data-slot="active-command" aria-label="Текущая команда" className="max-h-32 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
          <code className="block whitespace-pre-wrap wrap-anywhere font-mono">{command}</code>
        </pre>
      ) : (target || fallback) && (
        <div className="max-h-32 overflow-auto rounded-md border px-3 py-2 text-xs">
          <span className="mr-2 text-muted-foreground">{target ? label : "Параметры"}</span>
          <span className="whitespace-pre-wrap wrap-anywhere font-mono">{target ?? fallback}</span>
        </div>
      )}
    </div>
  );
}

function Item({ item, active }: { item: TranscriptItem; active: boolean }) {
  if (item.kind === "tool") {
    return (
      <div className="px-4 py-1">
        <ToolCall name={item.name} title={item.state === "running" ? runningToolTitle(item.name, item.input) : undefined} state={item.state} input={item.input} output={item.output} />
        {active && <ActiveTool item={item} />}
      </div>
    );
  }
  if (item.kind === "note" && item.collapsible) {
    return (
      <details className="px-4 py-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium">{item.label}</summary>
        <div className="mt-1 whitespace-pre-wrap wrap-anywhere">{item.text}</div>
      </details>
    );
  }
  if (item.kind === "note") {
    return (
      <div className="px-4 py-1 text-xs text-muted-foreground">
        <span className="font-medium">{item.label}</span>
        {item.text === "" ? null : <span className="ml-2 line-clamp-3 whitespace-pre-wrap">{item.text}</span>}
      </div>
    );
  }
  return (
    <div className="px-4 py-2">
      <Message align={item.role === "user" ? "end" : "start"}>
        {item.role === "assistant" ? <MessageAvatar className="size-7 text-xs">AI</MessageAvatar> : null}
        <MessageContent>
          {item.role === "assistant" && item.model !== undefined ? <MessageHeader>{item.model}</MessageHeader> : null}
          <MessageBubble>{item.role === "user" ? <p className="whitespace-pre-wrap">{item.text}</p> : <Markdown text={item.text} />}</MessageBubble>
        </MessageContent>
      </Message>
    </div>
  );
}

export function SessionPage({ params }: PageProps<"/sessions/$sessionId">) {
  return <SessionTranscript key={params.sessionId} id={params.sessionId} />;
}

function SessionTranscript({ id }: { id: string }) {
  const read = useCall(readAction, { session: id, window: { limit: 200 } }, { refreshOn: { types: ["session.*"] } });
  const session = useCall(sessionStateAction, { id }, { refreshOn: { types: ["session.turn-started", "session.turn-ended", "session.ended"] } });
  const earlier = useAction(readAction);
  const loading = useRef(false);
  const [history, setHistory] = useState<{ records: TranscriptRecord[]; hasEarlier: boolean }>();
  const tail = read.data;
  const [lastTail, setLastTail] = useState(tail);
  if (tail !== lastTail) {
    setLastTail(tail);
    const boundary = tail?.records[0]?.locator;
    const overlap = boundary && lastTail?.records.findIndex(record => record.locator === boundary);
    if (typeof overlap === "number" && overlap > 0) {
      setHistory({ records: [...(history?.records ?? []), ...lastTail!.records.slice(0, overlap)], hasEarlier: history?.hasEarlier ?? !!lastTail?.page?.hasEarlier });
    } else if (overlap === -1) {
      setHistory(undefined);
    }
  }
  const records = useMemo(() => [...(history?.records ?? []), ...(tail?.records ?? [])], [history, tail]);
  const items = useMemo(() => itemsOf(records), [records]);
  const last = items.at(-1);
  const activeKey = last?.kind === "tool" && last.state === "running" && session.data?.state === "running" ? last.key : undefined;
  const before = records[0]?.locator;
  const canLoad = !!before && (history?.hasEarlier ?? tail?.page?.hasEarlier);
  async function loadEarlier() {
    if (!canLoad || !before || loading.current) return;
    loading.current = true;
    try {
      const page = await earlier.mutateAsync({ session: id, window: { limit: 200, before } });
      if (page.coverage?.status === "unavailable") throw new Error(page.coverage.reason);
      setHistory(current => ({
        records: [...page.records, ...(current?.records ?? [])],
        hasEarlier: !!page.page?.hasEarlier && !!page.records[0]?.locator && page.records[0].locator !== before,
      }));
    } catch {
      // A subsequent scroll to the top retries the same window.
    } finally {
      loading.current = false;
    }
  }
  return (
    <div data-slot="session-page" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b px-4 py-3">
        <PageLink to="/sessions" className="text-sm text-muted-foreground hover:underline">
          Sessions
        </PageLink>
        <span className="text-muted-foreground">/</span>
        <EntityLink entity={{ kind: "session", id }} />
      </header>
      {read.data?.coverage?.reason && <p role="alert">{read.data.coverage.reason}</p>}
      {read.isPending ? (
        <p className="p-4 text-sm text-muted-foreground">Loading the transcript…</p>
      ) : read.isError ? (
        <p role="alert" className="p-4 text-sm text-destructive">The transcript could not be read: {read.error.message}</p>
      ) : (
        <Transcript
          items={items}
          onReachStart={canLoad ? loadEarlier : undefined}
          preserveScrollAnchor={!!(history || tail?.page?.hasEarlier)}
          itemKey={(item) => item.key}
          renderItem={(item) => <Item item={item} active={item.key === activeKey} />}
          empty="Nothing has been said in this session yet."
        />
      )}
      {earlier.isError && <p role="alert">Не удалось загрузить историю. Прокрутите вверх, чтобы повторить.</p>}
    </div>
  );
}
