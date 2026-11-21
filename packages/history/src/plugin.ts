/**
 * The history plugin: `history.watch` and `history.unwatch` over the reading sides of the
 * installations it is given. A watch writes what it learns as records (records.ts) and goes on after
 * a restart from where the last pause left it; the transcript itself is never written.
 */

import { action, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";
import { requireAbility } from "@niwa-labs/harness";
import type { HarnessInstanceRegistry, HarnessKindRegistry, Locator, SessionId } from "@niwa-labs/harness";

import type { ReadingBinding } from "./read.ts";
import {
  HISTORY_TYPES,
  HistorySessionEnded,
  HistorySessionPaused,
  HistorySessionSeen,
  HistorySessionUnwatched,
  SessionProgress,
  historyUnwatch,
  historyWatch,
} from "./records.ts";
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

/** Where a watch of a session stands in the journal: watched or not, the last pause and the last progress. */
interface Standing {
  watching: boolean;
  from?: Locator;
  progress?: Progress;
}

function standingOf(records: readonly StoredRecord[]): Map<string, Standing & { session: SessionId }> {
  const standing = new Map<string, Standing & { session: SessionId }>();
  for (const stored of records) {
    const session = (stored.data as { session?: SessionId }).session;
    if (session === undefined) continue;
    const key = keyOf(session);
    const now = standing.get(key) ?? { session, watching: false };
    if (stored.type === HistorySessionSeen.name) now.watching = true;
    else if (stored.type === HistorySessionEnded.name || stored.type === HistorySessionUnwatched.name) now.watching = false;
    else if (stored.type === HistorySessionPaused.name) now.from = HistorySessionPaused.schema.parse(stored.data).upto;
    else if (stored.type === SessionProgress.name) {
      const { done, total } = SessionProgress.schema.parse(stored.data);
      now.progress = { done, total };
    }
    standing.set(key, now);
  }
  return standing;
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

    /** Follow a session; what it learns is written as records until it ends or the watch stops. */
    const follow = (id: SessionId, from?: Locator, progress?: Progress): void => {
      const key = keyOf(id);
      if (watches.has(key)) return;
      const controller = new AbortController();
      watches.set(key, controller);
      const reading = readingOf(id);
      void (async () => {
        try {
          const events = watchSession(reading, id, {
            signal: controller.signal,
            ...(options.timing === undefined ? {} : { timing: options.timing }),
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            ...(from === undefined ? {} : { from }),
            ...(progress === undefined ? {} : { progress }),
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
                await api.emit(HistorySessionEnded, { session: id, certainty: event.certainty });
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

    api.action(
      action(historyWatch, {
        // A watch that is already on is left as it is: it may be asked for again.
        recovery: "repeat",
        run: async (input, ctx) => {
          const id = input.session;
          if (watches.has(keyOf(id))) return { watching: true };
          const reading = readingOf(id);
          let cwd: string | undefined;
          for await (const info of reading.list({ natives: [id.native] })) cwd = info.cwd ?? cwd;
          // A session watched before goes on from where that watch left it, saying no progress twice.
          const before = standingNow().get(keyOf(id));
          await ctx.emit(HistorySessionSeen, { session: id, harness: id.harness, ...(cwd === undefined ? {} : { cwd }) });
          follow(id, before?.from, before?.progress);
          return { watching: true };
        },
      }),
    );

    api.action(
      action(historyUnwatch, {
        recovery: "repeat",
        run: async (input, ctx) => {
          const controller = watches.get(keyOf(input.session));
          if (controller === undefined) return { stopped: false };
          watches.delete(keyOf(input.session));
          controller.abort();
          await ctx.emit(HistorySessionUnwatched, { session: input.session });
          return { stopped: true };
        },
      }),
    );

    // The watches the journal says are on go on from their last pause; all stop with the host.
    api.service(() => {
      if (api.journal?.() !== undefined) {
        for (const [, standing] of standingNow()) {
          if (!standing.watching) continue;
          try {
            follow(standing.session, standing.from, standing.progress);
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
