/**
 * The history plugin: `history.read` of a transcript, and `history.watch` and `history.unwatch` over the reading sides of the
 * installations it is given. A watch writes what it learns as records (records.ts) and goes on after
 * a restart from where the last pause left it; the transcript itself is never written.
 *
 * A session niwa starts is watched by itself, from its `session.started`: its progress is written like
 * any other's, a long quiet is a pause and never a guessed end, and its `session.ended` is the exact
 * end. The plugin reads those records by their names, so it imports nothing of the sessions module.
 */

import { action, recordTypeName, seq } from "@niwa-labs/core";
import type { JournalReader, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin, PluginApi, Subscriber } from "@niwa-labs/plugin";
import { harnessId, requireAbility, sessionId } from "@niwa-labs/harness";
import type { HarnessInstanceRegistry, HarnessKindRegistry, Locator, SessionId } from "@niwa-labs/harness";

import { readTranscript } from "./read.ts";
import type { ReadingBinding } from "./read.ts";
import {
  GUESSED_SIGNALS,
  HISTORY_TYPES,
  HistorySessionEnded,
  HistorySessionPaused,
  HistorySessionSeen,
  HistorySessionUnwatched,
  SessionProgress,
  historyRead,
  historySignal,
  historyUnwatch,
  historyWatch,
} from "./records.ts";
import type { EndSignal } from "./records.ts";
import { watchSession } from "./watch.ts";
import type { Progress, WatchClock, WatchTiming } from "./watch.ts";

export interface HistoryOptions {
  /** The installations whose sessions can be watched: bound, or the registries they are bound from. */
  readonly harnesses: readonly ReadingBinding[] | { readonly harnesses: HarnessInstanceRegistry; readonly kinds: HarnessKindRegistry };
  readonly timing?: WatchTiming;
  readonly clock?: WatchClock;
}

function bindingsOf(options: HistoryOptions): ReadingBinding[] {
  const { harnesses } = options;
  if (!("kinds" in harnesses)) return [...harnesses];
  return harnesses.harnesses.ids().map((id) => {
    const instance = harnesses.harnesses.resolve(id);
    return { instance, ...(harnesses.kinds.get(instance.kind)?.reading === undefined ? {} : { reading: harnesses.kinds.get(instance.kind)!.reading! }) };
  });
}

const keyOf = (id: SessionId): string => `${id.harness}\u0000${id.native}`;

/** The names of the records of the sessions module this plugin reads: a session niwa started, and its end. */
const SESSION_STARTED = recordTypeName("session.started");
const SESSION_ENDED = recordTypeName("session.ended");
/** The record the insert inside a harness writes when the harness says a session ended. */
const INSERT_SESSION_ENDED = recordTypeName("insert.session-ended");

/** A session as the sessions module names it, `<harness> <native>`, as a reading side names it. */
function sessionOfRef(ref: unknown): SessionId | undefined {
  if (typeof ref !== "string") return undefined;
  const space = ref.indexOf(" ");
  if (space <= 0 || space === ref.length - 1) return undefined;
  return sessionId(harnessId(ref.slice(0, space)), ref.slice(space + 1));
}

/** The session a record of the insert names, `{ harness, native }`. */
function sessionOfPair(value: unknown): SessionId | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { harness, native } = value as { harness?: unknown; native?: unknown };
  return typeof harness === "string" && typeof native === "string" && harness !== "" && native !== "" ? sessionId(harnessId(harness), native) : undefined;
}

/** Did niwa start this session? Its own `session.started` says so. */
function ownedBy(journal: JournalReader | undefined, id: SessionId): boolean {
  return (journal?.find({ type: SESSION_STARTED, field: "session", equals: `${id.harness} ${id.native}` }).length ?? 0) > 0;
}

/** Where a watch of a session stands in the journal: watched or not, the last pause, the last progress and its process. */
interface Standing {
  watching: boolean;
  from?: Locator;
  progress?: Progress;
  pid?: number;
}

function standingOf(records: readonly StoredRecord[]): Map<string, Standing & { session: SessionId }> {
  const standing = new Map<string, Standing & { session: SessionId }>();
  for (const stored of records) {
    const session = (stored.data as { session?: SessionId }).session;
    if (session === undefined) continue;
    const key = keyOf(session);
    const now = standing.get(key) ?? { session, watching: false };
    if (stored.type === HistorySessionSeen.name) {
      now.watching = true;
      const { pid } = HistorySessionSeen.schema.parse(stored.data);
      if (pid === undefined) delete now.pid;
      else now.pid = pid;
    } else if (stored.type === HistorySessionEnded.name || stored.type === HistorySessionUnwatched.name) now.watching = false;
    else if (stored.type === HistorySessionPaused.name) now.from = HistorySessionPaused.schema.parse(stored.data).upto;
    else if (stored.type === SessionProgress.name) {
      const { done, total } = SessionProgress.schema.parse(stored.data);
      now.progress = { done, total };
    }
    standing.set(key, now);
  }
  return standing;
}

/** Does a process live? A process that exists but is not ours to signal lives too. */
function lives(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export function history(options: HistoryOptions): Plugin {
  return plugin("history", (api: PluginApi) => {
    api.declare(...HISTORY_TYPES);
    const bindings = bindingsOf(options);
    const watches = new Map<string, AbortController>();

    /** Where each watch stands, from the journal. */
    const standingNow = () => standingOf(api.journal?.()?.since(seq(0), HISTORY_TYPES.map((type) => type.name)) ?? []);

    const readingOf = (id: SessionId) => {
      const binding = bindings.find((candidate) => candidate.instance.id === id.harness);
      if (binding === undefined || binding.reading === undefined) {
        throw new Error(`harness "${id.harness}" has no reading side to watch a session with`);
      }
      requireAbility(binding.instance, "reading", "read");
      return binding.reading;
    };

    /** The starts of watches in progress, by session: a start is reserved before its first await. */
    const starting = new Map<string, Promise<void>>();

    /**
     * Start watching a session with `start`, unless it is watched or a start is already under way, in
     * which case the caller shares that start. The reservation is released when the start is done or fails.
     */
    const begin = async (id: SessionId, start: () => Promise<void>): Promise<void> => {
      const key = keyOf(id);
      const under = starting.get(key);
      if (under !== undefined) return await under;
      if (watches.has(key)) return;
      const task = start();
      starting.set(key, task);
      try {
        await task;
      } finally {
        starting.delete(key);
      }
    };

    /** Stop following a session, when it is followed. */
    const stop = (id: SessionId): void => {
      const controller = watches.get(keyOf(id));
      watches.delete(keyOf(id));
      controller?.abort();
    };

    /** Follow a session; what it learns is written as records until it ends or the watch stops. */
    const follow = (id: SessionId, standing: Omit<Standing, "watching">): void => {
      const key = keyOf(id);
      if (watches.has(key)) return;
      const reading = readingOf(id);
      const controller = new AbortController();
      watches.set(key, controller);
      const owned = ownedBy(api.journal?.(), id);
      void (async () => {
        try {
          const events = watchSession(reading, id, {
            signal: controller.signal,
            ...(options.timing === undefined ? {} : { timing: options.timing }),
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            ...(standing.from === undefined ? {} : { from: standing.from }),
            ...(standing.progress === undefined ? {} : { progress: standing.progress }),
            // A session niwa runs ends when niwa says so: its quiet is a wait for the next turn.
            ...(owned ? { guessEnd: false } : {}),
            ...(standing.pid === undefined ? {} : { alive: () => lives(standing.pid!) }),
          });
          for await (const event of events) {
            switch (event.kind) {
              case "progress":
                await api.emit(SessionProgress, { session: id, done: event.done, total: event.total });
                break;
              case "paused":
                await api.emit(HistorySessionPaused, { session: id, upto: event.upto, why: event.why });
                break;
              case "ended":
                await api.emit(HistorySessionEnded, { session: id, certainty: event.certainty, why: event.why });
                break;
            }
          }
        } catch {
          // A host that closes while a record is written ends the watch; the next start resumes it.
        } finally {
          if (watches.get(key) === controller) watches.delete(key);
        }
      })();
    };

    /** The certainty a signal of the end gives. */
    const certaintyOf = (signal: EndSignal) => (GUESSED_SIGNALS.includes(signal) ? "guessed" : "exact");

    api.action(
      action(historyWatch, {
        // A watch that is already on is left as it is: it may be asked for again.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const id = input.session;
          await begin(id, async () => {
            const reading = readingOf(id);
            let cwd: string | undefined;
            for await (const info of reading.list({ natives: [id.native] })) cwd = info.cwd ?? cwd;
            // A session watched before goes on from where that watch left it, saying no progress twice.
            const before = standingNow().get(keyOf(id));
            await ctx.emit(HistorySessionSeen, {
              session: id,
              harness: id.harness,
              ...(cwd === undefined ? {} : { cwd }),
              ...(input.pid === undefined ? {} : { pid: input.pid }),
            });
            // Only where the earlier watch got to is carried over: the process is the one this call names, if any.
            follow(id, {
              ...(before?.from === undefined ? {} : { from: before.from }),
              ...(before?.progress === undefined ? {} : { progress: before.progress }),
              ...(input.pid === undefined ? {} : { pid: input.pid }),
            });
          });
          return { watching: true };
        },
      }),
    );

    api.action(
      action(historyRead, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "local",
        run: async (input) => await readTranscript(bindings.find((candidate) => candidate.instance.id === input.session.harness), input.session, input),
      }),
    );

    api.action(
      action(historyUnwatch, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (!watches.has(keyOf(input.session))) return { stopped: false };
          stop(input.session);
          await ctx.emit(HistorySessionUnwatched, { session: input.session });
          return { stopped: true };
        },
      }),
    );

    api.action(
      action(historySignal, {
        // An end already written is not written again: the signal may be given again.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (standingNow().get(keyOf(input.session))?.watching !== true) return { ended: false };
          // A session niwa runs ends when niwa says so: a sign that only suggests an end does not end it.
          if (GUESSED_SIGNALS.includes(input.signal) && ownedBy(api.journal?.(), input.session)) return { ended: false };
          stop(input.session);
          await ctx.emit(HistorySessionEnded, { session: input.session, certainty: certaintyOf(input.signal), why: input.signal });
          return { ended: true };
        },
      }),
    );

    // The sessions niwa starts, and the ends niwa and the inserts say: read by their names, from the
    // moment the plugin first serves, so the sessions of an older journal are not watched again.
    let firstServed: number | undefined;
    api.subscribers(() => {
      const journal = api.journal?.();
      if (journal === undefined) return [];
      firstServed ??= journal.last();
      // One subscription, so a session's start is always taken before its end.
      const sessions: Subscriber = {
        id: "niwa-sessions",
        queries: [{ types: [SESSION_STARTED, SESSION_ENDED, INSERT_SESSION_ENDED] }],
        from: firstServed,
        handler: async (data, step, stored) => {
          const { session, cwd } = data as { session?: unknown; cwd?: unknown };
          if (stored.type === SESSION_STARTED) {
            const id = sessionOfRef(session);
            if (id === undefined) return;
            // A session of an installation with no reading side has no transcript to follow.
            if (bindings.find((candidate) => candidate.instance.id === id.harness)?.reading === undefined) return;
            await begin(id, async () => {
              await step.emit(HistorySessionSeen, { session: id, harness: id.harness, ...(typeof cwd === "string" ? { cwd } : {}) });
              follow(id, {});
            });
            return;
          }
          const id = stored.type === SESSION_ENDED ? sessionOfRef(session) : sessionOfPair(session);
          if (id === undefined || standingNow().get(keyOf(id))?.watching !== true) return;
          stop(id);
          const why: EndSignal = stored.type === SESSION_ENDED ? "session-ended" : "end-hook";
          await step.emit(HistorySessionEnded, { session: id, certainty: certaintyOf(why), why });
        },
      };
      return [sessions];
    });

    // The watches the journal says are on go on from their last pause; all stop with the host.
    api.service(() => {
      if (api.journal?.() !== undefined) {
        for (const [, standing] of standingNow()) {
          if (!standing.watching) continue;
          try {
            follow(standing.session, standing);
          } catch {
            // An installation that is gone has nothing to watch with.
          }
        }
      }
      return () => {
        for (const controller of watches.values()) controller.abort();
        watches.clear();
      };
    });
  });
}
