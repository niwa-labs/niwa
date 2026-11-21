/**
 * feed.ts — everything that waits for the owner, as one list.
 *
 * The list is computed from the journal, read through the observation API: a paused invocation
 * and an open request are the same shape here. Every entry names the record it came from, so the
 * page can link to it and the trace can start from it.
 */

import { QuestionSchema, CORE_TYPES, recordTypeName, seq } from "@niwa-labs/core";
import type { Question, RecordId, StoredRecord } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

const REQUEST_CREATED = recordTypeName("request.created");
const SESSION_STARTED = recordTypeName("session.started");
const REQUEST_CLOSING = [
  recordTypeName("request.answered"),
  recordTypeName("request.cancelled"),
  recordTypeName("request.expired"),
];

/** Records that arrive in a burst are sent as one list once they settle. */
const SETTLE_MS = 50;

/** The choices an owner may take about a paused invocation. */
export type FeedChoice = "retry" | "skip" | "cancel";

/** One thing that waits for the owner. */
export interface FeedEntry {
  readonly kind: "paused" | "request";
  /** The id of the invocation or of the request. */
  readonly id: string;
  /** The record that says it waits. */
  readonly record: RecordId;
  /** The reason of the pause, or the question of the request. */
  readonly text: string;
  /** The choices the owner may take; empty for a request. */
  readonly choices: readonly FeedChoice[];
  /** The question of a request, whole: the page draws its options and its kind from it. */
  readonly question?: Question;
  /** The step the pause is about, when it paused on one. */
  readonly key?: string;
  /** The id niwa gave the session that asks, for a request a session niwa started put to the owner. */
  readonly session?: string;
  readonly at: number;
}

/** Whether a record can change the feed. */
function isFeedRecord(record: StoredRecord): boolean {
  return (
    record.type === CORE_TYPES.invocationState ||
    record.type === CORE_TYPES.invocationResolved ||
    record.type === REQUEST_CREATED ||
    record.type === SESSION_STARTED ||
    REQUEST_CLOSING.includes(record.type)
  );
}

/** A field of record data, when it is a string. */
function field(data: unknown, name: string): string | undefined {
  const value = (data as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The feed of a journal prefix, in the order things appeared.
 *
 * An invocation waits while its latest state is "paused" and no answer was written after that
 * state; one that paused again after an answer waits again. A request waits until a record
 * closes it, and is on the feed only when it is addressed to the owner.
 */
export function feedOf(records: readonly StoredRecord[]): FeedEntry[] {
  const latestState = new Map<string, StoredRecord>();
  const lastAnswer = new Map<string, number>();
  const openedRequests = new Map<string, StoredRecord>();
  const closedRequests = new Set<string>();
  // The ids niwa gave the sessions it started, by their pair `<harness> <native>`.
  const sessions = new Map<string, string>();

  for (const record of records) {
    const invocation = field(record.data, "invocation");
    const request = field(record.data, "request") ?? field(record.data, "id");
    if (record.type === CORE_TYPES.invocationState && invocation !== undefined) {
      latestState.set(invocation, record);
    } else if (record.type === CORE_TYPES.invocationResolved && invocation !== undefined) {
      lastAnswer.set(invocation, record.seq);
    } else if (record.type === REQUEST_CREATED && request !== undefined) {
      openedRequests.set(request, record);
    } else if (REQUEST_CLOSING.includes(record.type) && request !== undefined) {
      closedRequests.add(request);
    } else if (record.type === SESSION_STARTED) {
      const session = field(record.data, "session");
      const id = field(record.data, "id");
      if (session !== undefined && id !== undefined) sessions.set(session, id);
    }
  }

  const entries: FeedEntry[] = [];
  for (const [invocation, record] of latestState) {
    if (field(record.data, "state") !== "paused") continue;
    if ((lastAnswer.get(invocation) ?? -1) > record.seq) continue;
    const key = field(record.data, "key");
    entries.push({
      kind: "paused",
      id: invocation,
      record: record.id,
      text: field(record.data, "reason") ?? "the invocation is paused",
      choices: choicesOf((record.data as { choices?: unknown }).choices),
      ...(key === undefined ? {} : { key }),
      at: record.at,
    });
  }
  for (const [id, record] of openedRequests) {
    if (closedRequests.has(id)) continue;
    if ((record.data as { to?: { kind?: unknown } } | null)?.to?.kind !== "owner") continue;
    const asked = QuestionSchema.safeParse((record.data as { input?: unknown } | null)?.input);
    const from = (record.data as { from?: { kind?: unknown; harness?: unknown; id?: unknown } } | null)?.from;
    const session = from?.kind === "session" ? sessions.get(`${String(from.harness)} ${String(from.id)}`) : undefined;
    entries.push({
      kind: "request",
      id,
      record: record.id,
      text: asked.success ? asked.data.title : (field(record.data, "question") ?? "a question"),
      choices: [],
      ...(asked.success ? { question: asked.data } : {}),
      ...(session === undefined ? {} : { session }),
      at: record.at,
    });
  }
  return entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The choices of a paused state, keeping only the ones the core offers. */
function choicesOf(value: unknown): FeedChoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (choice): choice is FeedChoice => choice === "retry" || choice === "skip" || choice === "cancel",
  );
}

/**
 * Follow the feed: the whole list is sent once the journal settles, and again after every change.
 *
 * `onEnd` is called when the journal can no longer be read. `stop` closes the subscription.
 */
export function followFeed(
  api: NiwaApi,
  onFeed: (entries: FeedEntry[]) => void,
  onEnd: (error?: unknown) => void,
): { stop(): void } {
  const iterator = api.records.since(seq(0))[Symbol.asyncIterator]();
  const relevant: StoredRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) onFeed(feedOf(relevant));
    }, SETTLE_MS);
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    void iterator.return?.().catch(() => undefined);
  };

  schedule();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      if (isFeedRecord(next.value)) {
        relevant.push(next.value);
        schedule();
      }
    }
  })().then(
    () => {
      stop();
      onEnd();
    },
    (error: unknown) => {
      const wasStopped = stopped;
      stop();
      if (!wasStopped) onEnd(error);
    },
  );
  return { stop };
}

/** The feed as it is now: the first list of a followed feed. */
export function readFeed(api: NiwaApi): Promise<FeedEntry[]> {
  return new Promise((resolve, reject) => {
    const follower = followFeed(
      api,
      (entries) => {
        follower.stop();
        resolve(entries);
      },
      (error) => reject(error ?? new Error("the journal ended before the feed was read")),
    );
  });
}
