/** The sessions of the host and the transcript of one of them. */

import { EntityLink, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
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

import { useEffect, useMemo, useState } from "react";
import type { HomeTileProps } from "@niwa-labs/cockpit-sdk";
import { listAction, readAction, type SessionEntry } from "./actions.ts";
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

function Item({ item }: { item: TranscriptItem }) {
  if (item.kind === "tool") {
    return (
      <div className="px-4 py-1">
        <ToolCall name={item.name} state={item.state} input={item.input} output={item.output} />
      </div>
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
  const [anchors, setAnchors] = useState<string[]>([]);
  const before = anchors.at(-1);
  const read = useCall(readAction, { session: id, window: { limit: 200, ...(before && { before }) } }, { refreshOn: { types: ["session.*"] } });
  return (
    <div data-slot="session-page" className="flex h-full min-h-0 min-w-0 flex-col">
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
          items={itemsOf(read.data.records)}
          itemKey={(item) => item.key}
          renderItem={(item) => <Item item={item} />}
          empty="Nothing has been said in this session yet."
          className="min-h-80"
        />
      )}
      <div className="desk-tools">{read.data?.page?.hasEarlier && read.data.records[0]?.locator && <button onClick={() => setAnchors(a => [...a, read.data.records[0]!.locator!])}>← Предыдущие сообщения</button>}
        {before && <button onClick={() => setAnchors(a => a.slice(0, -1))}>Следующие сообщения →</button>}</div>
    </div>
  );
}
