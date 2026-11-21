/** The sessions of the host and the transcript of one of them. */

import { EntityLink, PageLink, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import {
  Markdown,
  Message,
  MessageAvatar,
  MessageBubble,
  MessageContent,
  MessageHeader,
  StateRing,
  ToolCall,
  Transcript,
  formatAgo,
  type WorkState,
} from "@niwa-labs/ui-kit";

import { listAction, readAction, type SessionEntry } from "./actions.ts";
import { itemsOf, type TranscriptItem } from "./transcript.ts";

const RING: Readonly<Record<SessionEntry["state"], WorkState>> = { running: "running", idle: "waiting", ended: "done", unknown: "pending" };

function SessionRow({ entry }: { entry: SessionEntry }) {
  const id = entry.id;
  return (
    <li data-slot="session-row" data-state={entry.state} className="flex min-w-0 items-center gap-3 py-2">
      <StateRing state={RING[entry.state]} label={entry.state} />
      {id === undefined ? (
        <span className="min-w-0 truncate text-sm">{entry.title ?? entry.ref}</span>
      ) : (
        <PageLink to={`/sessions/${encodeURIComponent(id)}`} className="min-w-0 truncate text-sm font-medium hover:underline">
          {entry.title ?? entry.ref}
        </PageLink>
      )}
      {id === undefined ? null : <EntityLink entity={{ kind: "session", id }} short />}
      {entry.cwd === undefined ? null : (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline" title={entry.cwd}>
          {entry.cwd}
        </span>
      )}
      {entry.model === undefined ? null : <span className="shrink-0 text-xs text-muted-foreground">{entry.model}</span>}
      {entry.lastActivityAt === undefined ? null : (
        <time className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={new Date(entry.lastActivityAt).toISOString()}>
          {formatAgo(entry.lastActivityAt)}
        </time>
      )}
    </li>
  );
}

export function SessionsPage() {
  const sessions = useCall(listAction, { limit: 100 }, { refreshOn: { types: ["session.*"] } });
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Sessions</h2>
      {sessions.isPending ? (
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      ) : sessions.isError ? (
        <p role="alert" className="text-sm text-destructive">The sessions could not be read: {sessions.error.message}</p>
      ) : sessions.data.sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      ) : (
        <>
          <ul data-slot="sessions" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {sessions.data.sessions.map((entry) => (
              <SessionRow key={entry.ref} entry={entry} />
            ))}
          </ul>
          {sessions.data.total > sessions.data.sessions.length ? (
            <p className="text-xs text-muted-foreground">
              {sessions.data.sessions.length} of {sessions.data.total} sessions, the latest first.
            </p>
          ) : null}
        </>
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
  const id = params.sessionId;
  const read = useCall(readAction, { session: id, window: { limit: 200 } }, { refreshOn: { types: ["session.*"] } });
  return (
    <div data-slot="session-page" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b px-4 py-3">
        <PageLink to="/sessions" className="text-sm text-muted-foreground hover:underline">
          Sessions
        </PageLink>
        <span className="text-muted-foreground">/</span>
        <EntityLink entity={{ kind: "session", id }} />
      </header>
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
      {read.data?.page?.hasEarlier === true ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">Earlier records are not shown.</p> : null}
    </div>
  );
}
