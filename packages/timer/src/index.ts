/**
 * The timer module: wake at a moment or with a period.
 *
 * A timer is a declaration, not a thread. `timer.every(60000)` and `timer.at(date)` say when
 * something should happen; the module turns that into records. A firing is an external input:
 * it starts its own chain, and the root of that chain is the firing itself.
 *
 * **A trigger is a filter over the firing type.** `timer.fired("daily-digest")` is not a new
 * record type: it is "timer.fired" narrowed to the firings of one timer (`{ timer: "daily-digest" }`).
 * A handler of a trigger is woken by exactly those firings and by no others, so two plugins can
 * watch two timers of the same host without seeing each other's. A trigger made with a schedule
 * (`timer.daily("21:00")`) carries it: the plugin whose handler subscribes to it offers the timer, so
 * subscribing is all it takes for the timer to be scheduled.
 *
 * **A firing is written once.** The id of a firing is `fire-<hash>` in the common id format, the
 * hash of the timer and the moment it was due, never of the moment it was written. The same due
 * time always has the same id, so a firing written twice (a host that restarted, a tick that
 * overlapped) is the same record and not a second fact. A deterministic id makes a repeated write
 * harmless.
 *
 * **What happens when the host was down.** Every timer says what to do with the dues it missed
 * while the host was not running:
 *
 * - `"once"` (the default): after the host starts, the timer fires exactly once for all the
 *   dues it missed, and the schedule continues from that firing: a schedule holds one next due, and it
 *   is recomputed from the moment of the firing, so the missed slots collapse into one firing instead
 *   of being replayed.
 * - `"skip"`: the missed dues are gone. The timer fires the next time it is due, and nothing is
 *   said about what was missed.
 *
 * Both rules say "once" in the sense that matters: a due time produces at most one firing, and a
 * timer that was down for an hour does not wake up an hour later with an hour of firings queued
 * behind it.
 *
 * The next due of every timer is kept in the state of the plugin, so the host knows after a
 * restart which dues it missed.
 *
 * **A sleep is a wait, and a wait is durable.** `sleep(ms)` inside a handler says when the code
 * may go on: the moment is read through the clock of the host, the wait is a step of the
 * invocation, and the wake that ends it is a record in the journal. A host that is restarted in
 * the middle of a sleep finds the handler waiting, and it wakes once — at the moment that was
 * asked for, or at once when the moment passed while the host was down.
 */

import {
  DeniedError,
  EntityDescription,
  IdIndex,
  IntegrityError,
  UnknownId,
  action,
  actionRef,
  currentInvocation,
  idSchema,
  recordId,
  seq,
  shortInvocation,
  shortRun,
  stableJson,
  timestamp,
} from "@niwa-labs/core";
import type {
  Id,
  InvocationScope,
  JournalReader,
  RecordId,
  RecordType,
  Step,
  StoredRecord,
  Timestamp,
} from "@niwa-labs/core";
import { TIMER_OFFER, plugin, trigger } from "@niwa-labs/plugin";
import type { MissedRule, Plugin, ServiceContext, StateHandle, TimerDef, TimerOffer, Trigger } from "@niwa-labs/plugin";
import { z } from "zod";

import { SleepRequested, TimerFired, TimerId, TimerSlept, clockOf, readSleepKey, sleepKey, timerFiredQuery, timerId, timerSleepRequest } from "./records.ts";
import type {
  SleepKey,
  SleepRequestedData,
  TimerFiredData,
  TimerSleptData,
} from "./records.ts";

export { SleepRequested, TimerFired, TimerId, TimerSlept, clockOf, readSleepKey, sleepKey, timerFiredQuery, timerId, timerSleepRequest } from "./records.ts";
export type {
  SleepKey,
  SleepRequestedData,
  TimerFiredData,
  TimerSleptData,
};
// The definition of a timer and the point plugins offer one at (`TIMER_OFFER`) are the plugin layer's: a plugin that
// needs a timer offers it without importing this module.
export type { MissedRule, TimerDef };

/** How long a write that failed waits before it is tried again. */
const RETRY_MS = 1000;

/** The rule a timer uses when it says nothing: one firing for all the missed dues. */
export const DEFAULT_MISSED: MissedRule = "once";

/**
 * A trigger: the firings of one timer.
 *
 * It is the type "timer.fired" with the filter `{ timer }`. A handler registered for it is woken by
 * the firings of that timer and by no others, and the timers plugin is named as the one that writes them.
 */
export interface TimerTrigger extends Trigger<TimerFiredData> {
  /** The id of the timer this trigger watches. */
  readonly timer: TimerId;
  /** The schedule of the timer, when the trigger declares one. */
  readonly def?: TimerDef;
}

/**
 * A trigger that carries the schedule of its timer: what `every`, `at` and `daily` make. A plugin
 * that subscribes to it offers the timer (`TIMER_OFFER`), so the timers plugin schedules it.
 */
export interface ScheduledTimerTrigger extends TimerTrigger {
  readonly def: TimerDef;
}

/**
 * The trigger of one timer: the firings of that timer, as a type a handler can be written for.
 *
 * The trigger carries the type it narrows, so a handler of it is named after the type by
 * default — but two triggers of two timers are two handlers, so each carries its own name.
 */
export function timerFired(id: string): TimerTrigger {
  return triggerOf(timerId(id), undefined);
}

/** What a timer's author may add to the schedule: the id the timer is named by, and a description of it. */
export interface TimerOptions {
  readonly id?: string;
  readonly description?: string;
}

/**
 * The trigger of a timer that fires every period.
 *
 * The id of the timer is the period by default: `every:60000`. Two timers with the same period
 * are the same timer, so a second one needs an id of its own.
 */
export function every(ms: number, options: TimerOptions = {}): ScheduledTimerTrigger {
  requirePeriod(ms);
  const key = timerId(options.id ?? `every:${ms}`);
  return triggerOf(key, { id: key, every: ms, ...describedBy(options) });
}

/**
 * The trigger of a timer that fires once, at a moment.
 *
 * The id of the timer is the moment by default: `at:1735689600000`.
 */
export function at(moment: number | Date, options: TimerOptions = {}): ScheduledTimerTrigger {
  const due = timestamp(moment instanceof Date ? moment.getTime() : moment);
  const key = timerId(options.id ?? `at:${due}`);
  return triggerOf(key, { id: key, at: due, ...describedBy(options) });
}

/**
 * The trigger of a timer that fires every day at a time of day, "HH:MM" in local time.
 *
 * The id of the timer is the time by default: `daily:21:00`.
 */
export function daily(time: string, options: TimerOptions = {}): ScheduledTimerTrigger {
  const clock = parseTimeOfDay(time);
  const key = timerId(options.id ?? `daily:${clock}`);
  return triggerOf(key, { id: key, daily: clock, ...describedBy(options) });
}

/** The description a timer's options carry, as the part of a definition it is. */
function describedBy(options: TimerOptions): { readonly description?: string } {
  return options.description === undefined ? {} : { description: options.description };
}

/** A trigger over one timer, with the schedule it declares and the offer of it. */
function triggerOf(id: TimerId, def: TimerDef): ScheduledTimerTrigger;
function triggerOf(id: TimerId, def: undefined): TimerTrigger;
function triggerOf(id: TimerId, def: TimerDef | undefined): TimerTrigger {
  const base = trigger(TimerFired, {
    name: `timer.fired:${id}`,
    filter: timerFiredQuery(id).filter ?? {},
    provider: "timers",
    ...(def === undefined ? {} : { offer: { key: TIMER_OFFER, value: def } }),
  });
  return { ...base, timer: id, ...(def === undefined ? {} : { def }) };
}

/** The id of a firing: `fire-<hash>`. */
export type FiringId = Id<"firing">;

/** What a firing is born from: the timer and the moment it was due. */
function firingSeed(timer: string, due: number): RecordId {
  return recordId(`timer:${timer}:${due}`);
}

/**
 * The id of the firing of one timer at one due: `fire-<hash of the timer and the due>`.
 *
 * It is a function of the timer and the moment it was due, so the same firing written twice is
 * the same record. The host writes it with this id, and the journal keeps one record per id.
 */
export function firingId(ids: IdIndex<"firing">, timer: TimerId, due: Timestamp): FiringId {
  return ids.issue(firingSeed(timer, due));
}

/**
 * The id of the wake of one sleep: `timer:slept:${key}`.
 *
 * It is a function of the sleeping place, so a wake written twice is the same record: a host that
 * restarts and finds the sleep still waiting writes the same wake, not a second one.
 */
export function sleptId(key: SleepKey): RecordId {
  return recordId(`timer:slept:${key}`);
}

/**
 * The timers of niwa, as one name.
 *
 * `timer.daily("21:00")`, `timer.every(60000)` and `timer.at(date)` are the triggers a handler
 * can be written for; `timer.fired(id)` is the trigger of a timer that was declared elsewhere.
 */
export const timer = {
  /** A timer that fires once, at a moment. */
  at,
  /** A timer that fires every day at a time of day, "HH:MM" in local time. */
  daily,
  /** A timer that fires every period. */
  every,
  /** The firings of one timer, as a type a handler can be written for. */
  fired: timerFired,
};

/**
 * The key of one sleep: the invocation and the sleeping place.
 *
 * It is a function of the two, so the same sleeping place always has the same key, and two
 * sleeping places of one invocation never have the same one.
 */
function sleepKeyOf(scope: InvocationScope, place: string): SleepKey {
  return sleepKey(`${scope.invocation}:${place}`);
}

/**
 * How many sleeps one run of one invocation has asked for.
 *
 * It is the number of the sleeping place: a handler that sleeps twice has two places, and the
 * wake of one is not the answer of the other. The count belongs to the run, so a replay of the
 * handler reaches the same places again.
 */
const sleepsOf = new WeakMap<InvocationScope, number>();

/** The sleeping places one invocation has used, so a place is never slept at twice. */
const placesOf = new WeakMap<InvocationScope, Set<string>>();

/**
 * Sleep for `ms` milliseconds, and go on when the time has come.
 *
 * A sleep is a step, like a call: the moment is read through the clock of the host, so the code
 * between the steps is reproducible, and the wait survives a restart. A host that was down while
 * the sleep was running wakes the handler once — at the moment that was asked for, or at once when
 * that moment passed while the host was down.
 *
 * The `key` names the sleeping place. One sleeping place is one sleep: a handler that sleeps
 * twice may give the two sleeps two keys; without one, the sleeps are told apart by their
 * number.
 *
 * @throws when the sleep is asked for outside an invocation: there is nothing to wait with, or
 * when the key was used by an earlier sleep of the same invocation: the wake of a place comes once.
 */
export async function sleep(step: Step, ms: number, key?: string): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(`a sleep must be a non-negative number of milliseconds, got ${String(ms)}`);
  }
  const scope = currentInvocation();
  if (scope === undefined) {
    throw new Error("a sleep is a step of an invocation: it cannot be made outside one");
  }
  const number = (sleepsOf.get(scope) ?? 0) + 1;
  const waitKey = `timer.sleep-${number}`;
  const named = key ?? waitKey;
  const places = placesOf.get(scope) ?? new Set<string>();
  if (places.has(named)) {
    throw new Error(`the sleeping place "${named}" was slept at already in this invocation: a place is woken once, so a second sleep needs a key of its own`);
  }
  const place = sleepKeyOf(scope, named);
  places.add(named);
  placesOf.set(scope, places);
  sleepsOf.set(scope, number);
  const at = (await step.now()) + ms;
  // The wait is begun before the request is written. The wake of a sleep can only be written
  // after the request is, and a wait looks for the records that came after it began: a wait
  // that began after the request could miss a wake that was written in between, and the handler
  // would wait for ever.
  const waiting = step.wait(TimerSlept, { filter: { key: place }, key: waitKey });
  // The wait refuses when no wake has come, and the refusal is the suspension of the invocation.
  // It is caught here, so the request can be written, and it is raised again below.
  const settled = waiting.then(
    (value) => ({ refused: false as const, value }),
    (error: unknown) => ({ refused: true as const, error }),
  );
  await step(timerSleepRequest, { at, key: place }, { key: `timer.sleep-emit-${number}` });
  const outcome = await settled;
  if (outcome.refused) throw outcome.error;
}

/**
 * What a handler that sleeps needs the host to have: the timers plugin declares the two records
 * of a sleep. A handler that calls `sleep` names them in `requires`, so a host without the timers
 * refuses to serve instead of failing the handler (or waiting for ever) when a sleep is asked for.
 */
export const SLEEP_NEEDS: readonly RecordType<any>[] = [
  { ...SleepRequested, provider: "timers" },
  { ...TimerSlept, provider: "timers" },
];

/** What the plugin remembers about each timer: when it is due, and whether it is done. */
interface ScheduleEntry {
  /** The next moment the timer is due, in milliseconds since the epoch. */
  readonly due: number;
  /** True when the timer has fired and will not fire again. */
  readonly done: boolean;
}

/** The schedule of every timer of the plugin, by the id of the timer. */
type Schedule = Record<string, ScheduleEntry>;

/** One timer, as the scheduler keeps it. */
interface Scheduled {
  readonly id: TimerId;
  readonly def: TimerDef;
  readonly description: EntityDescription;
  readonly missed: MissedRule;
  /** The next moment the timer is due. Meaningless once the timer is done. */
  due: Timestamp;
  /** True when the timer has fired and will not fire again. */
  done: boolean;
  /** True while the firing of the due is being written. */
  firing: boolean;
  /** A failed write is not tried again before this moment. */
  retryAt: number;
}

/**
 * The timers of one host, as a plugin.
 *
 * The plugin declares the firing type and runs one service: the scheduler. The service starts
 * when the host starts serving and stops when it closes or the plugin is unloaded.
 *
 * The timers are given as plain definitions or as the triggers that declare them; a trigger
 * carries its schedule with it.
 */
export function timers(defs: readonly (TimerDef | ScheduledTimerTrigger)[]): Plugin {
  const listed = defs.map((def) => build(defOf(def)));
  const ids = new Set<TimerId>();
  for (const { id } of listed) {
    if (ids.has(id)) throw new Error(`two timers have the id "${id}": a timer id must name one timer`);
    ids.add(id);
  }
  return plugin("timers", (api) => {
    api.declare(TimerFired, SleepRequested, TimerSlept);
    /**
     * The timers of the host: the listed ones, then the ones the plugins offer (`TIMER_OFFER`). A listed
     * timer wins over an offered one of the same id: the owner's list is how a plugin's schedule is changed.
     * Read when the host serves, so the plugins that offer may be installed in any order.
     */
    let known: Scheduled[] | undefined;
    const scheduleOfHost = (): Scheduled[] => {
      if (known !== undefined) return known;
      const all = [...listed];
      for (const { plugin: offeredBy, value } of api.offers(TIMER_OFFER)) {
        const entry = build(defOf(value));
        const same = all.find((one) => one.id === entry.id);
        if (same === undefined) all.push(entry);
        else if (stableJson(same.def) !== stableJson(entry.def)) {
          console.error(`niwa: the timer "${entry.id}" that "${offeredBy}" offers is also listed, with another schedule: the listed one is used`);
        }
      }
      known = all;
      return all;
    };
    const memory = api.state<Schedule>("schedule", ScheduleSchema, {});
    /** The ids of the firings the journal holds, so a firing asked for again gets the id it has. */
    const firingIds = new IdIndex("firing", () =>
      (api.journal?.()?.since(seq(0), [TimerFired.name]) ?? []).map((row) => {
        const data = row.data as TimerFiredData;
        return { id: String(row.id), seed: firingSeed(data.timer, data.due) };
      }),
    );
    /**
     * The sleeps that are asked for while the host serves, by the key of the sleeping place.
     *
     * It is set when the service starts: a sleep asked for before the service is up is found by
     * the scan the service makes when it starts.
     */
    let askSleep: ((data: SleepRequestedData) => void) | undefined;
    api.service((ctx) => {
      const journal = api.journal?.();
      let stopped = false;
      const running: Scheduled[] = scheduleOfHost().map((entry) => {
        const saved = memory.get()[entry.id];
        const state =
          saved === undefined
            ? { due: firstDue(entry, ctx.now()), done: false }
            : settle(entry, saved, journal, firingIds);
        return { ...entry, due: timestamp(state.due), done: state.done };
      });
      // The sleeps that are over, by the key of the sleeping place, and the wakes that are
      // armed for the ones that are not.
      const ended = new Set<SleepKey>();
      // The wakes whose record is being written: not over until the write is confirmed.
      const writing = new Set<SleepKey>();
      const wakes = new Map<SleepKey, () => void>();
      /**
       * End one sleep: the wake is written for the sleeping place, and the handler that waits
       * for it goes on.
       *
       * A wake that was written before is not written again: the id is a function of the
       * sleeping place, so a host that restarts and finds the sleep still waiting writes the
       * same record. The sleep is over only when the write is confirmed: a write that failed is
       * tried again after a delay, so the handler is not left asleep.
       */
      const wake = async (key: SleepKey): Promise<void> => {
        if (stopped || ended.has(key) || writing.has(key)) return;
        writing.add(key);
        try {
          await ctx.emit(TimerSlept, { key }, { id: sleptId(key) });
          ended.add(key);
        } catch (error) {
          // Written in the meantime: the sleep is over.
          if (error instanceof IntegrityError) {
            ended.add(key);
            return;
          }
          if (stopped) return;
          console.error(
            `niwa: the sleep "${key}" could not be woken, it is tried again: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          armSleep(key, ctx.now() + RETRY_MS);
        } finally {
          writing.delete(key);
        }
      };
      /**
       * Arm the wake of one sleep: the clock of the host carries it.
       *
       * A moment that has passed is fired at once: the sleep is over, and the handler that
       * waits for it goes on now.
       */
      const armSleep = (key: SleepKey, at: number): void => {
        wakes.get(key)?.();
        wakes.delete(key);
        if (at <= ctx.now()) {
          void wake(key);
          return;
        }
        // The promise is returned, so a clock that is moved by hand waits for the wake to be
        // written instead of running past it.
        const cancel = ctx.schedule(at, () => {
          wakes.delete(key);
          return wake(key);
        });
        wakes.set(key, cancel);
      };
      /**
       * A sleep that is asked for: it is armed, unless it is over already.
       *
       * The wake of a sleep that was asked for twice is armed once: the key is the sleeping
       * place, so the second request is the same sleep.
       */
      askSleep = (data: SleepRequestedData): void => {
        const key = readSleepKey(data.key);
        if (key === undefined) return skipped("a sleep request", data.key);
        if (stopped || ended.has(key)) return;
        armSleep(key, data.at);
      };
      /**
       * The sleeps the journal holds that are not over: they are the sleeps of a host that was
       * down, and they are woken when their moment comes — or at once when it passed.
       */
      const scan = (): void => {
        for (const row of journal?.since(seq(0), [TimerSlept.name]) ?? []) {
          const key = readSleepKey((row.data as TimerSleptData).key);
          if (key === undefined) skipped("a wake", (row.data as TimerSleptData).key);
          else ended.add(key);
        }
        for (const row of journal?.since(seq(0), [SleepRequested.name]) ?? []) {
          const data = row.data as SleepRequestedData;
          const key = readSleepKey(data.key);
          if (key === undefined) {
            skipped("a sleep request", data.key);
            continue;
          }
          if (ended.has(key)) continue;
          armSleep(key, data.at);
        }
      };
      scan();

      // The first tick settles what the host missed while it was down: the dues that are in the
      // past are the ones the rule of the timer decides about.
      let first = true;
      // The wake that is armed for the next due: it is the clock of the host, so a host whose
      // clock is moved by hand wakes when the clock says the due has come.
      let cancel: (() => void) | undefined;
      /** Arm the wake for the nearest due that is still to come. */
      const arm = (): void => {
        cancel?.();
        cancel = undefined;
        if (stopped) return;
        let next: number | undefined;
        for (const entry of running) {
          // A timer whose firing is being written is armed again when the write is over.
          if (entry.done || entry.firing) continue;
          const at = Math.max(entry.due, entry.retryAt);
          if (next === undefined || at < next) next = at;
        }
        if (next === undefined) return;
        cancel = ctx.schedule(next, () => {
          cancel = undefined;
          return tick();
        });
      };
      /**
       * One tick: the dues that are due are fired, and the next wake is armed.
       *
       * The firings are written in parallel: a slow write must not hold up the other timers.
       * The promise it returns settles when those writes are done, so a clock that moves by
       * hand waits for them instead of running past them.
       *
       * A timer goes on to its next due only when its firing is confirmed in the journal: a write
       * that failed leaves the due where it was, and it is tried again after a delay.
       */
      const tick = (): Promise<void> => {
        const now = ctx.now();
        const written: Array<Promise<void>> = [];
        for (const entry of running) {
          if (entry.done || entry.firing || entry.due > now || entry.retryAt > now) continue;
          const due = entry.due;
          // The next due is computed from now, so a timer that was late does not queue up the
          // dues it missed: it fires once and continues from there.
          const following = nextDue(entry, now);
          const advance = (): void => {
            entry.due = following ?? due;
            // A timer that fires once is done when it has fired. Its due stays a real moment:
            // a state that holds "no due" would have to be written as null, and the journal
            // would not read it back as the number it was.
            entry.done = following === undefined;
            entry.retryAt = 0;
            remember(memory, [entry]);
          };
          // The rule of the timer decides about the dues that passed while the host was down; a
          // due that is the moment of the start has not passed.
          if (first && entry.missed === "skip" && due < now) {
            advance();
            continue;
          }
          // The schedule is remembered after the firing is written: a host that dies in between
          // fires the same due again on its next start, with the same id, and that is one record.
          entry.firing = true;
          written.push(
            fire(ctx, entry, due, now, journal, firingIds, () => stopped).then((confirmed) => {
              entry.firing = false;
              if (stopped) return;
              // The timer is armed again whatever happens to its state: a timer that is not armed
              // is a timer that is gone.
              try {
                if (confirmed) advance();
                else entry.retryAt = ctx.now() + RETRY_MS;
              } finally {
                arm();
              }
            }),
          );
        }
        first = false;
        arm();
        return Promise.all(written).then(() => undefined);
      };
      remember(memory, running);
      // The first tick happens at once: a timer that was due while the host was down must not
      // wait for the first wake to come.
      void tick().catch((error: unknown) => {
        console.error(
          `niwa: the timer scheduler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return () => {
        stopped = true;
        cancel?.();
        for (const cancelWake of wakes.values()) cancelWake();
        wakes.clear();
      };
    });
    /** The sleeps that are not over: the records that asked for them, by the sleeping place. */
    const pendingSleeps = (): Array<{ at: number; row: StoredRecord }> => {
      const journal = api.journal?.();
      // A record whose key cannot be one is no sleep: the scan of the service reports it.
      const ended = new Set(journal?.since(seq(0), [TimerSlept.name]).map((row) => (row.data as TimerSleptData).key));
      const pending = new Map<string, { at: number; row: StoredRecord }>();
      for (const row of journal?.since(seq(0), [SleepRequested.name]) ?? []) {
        const data = row.data as SleepRequestedData;
        if (readSleepKey(data.key) !== undefined && !ended.has(data.key)) pending.set(data.key, { at: data.at, row });
      }
      return [...pending.values()].sort((a, b) => a.at - b.at);
    };
    api.summarize(() => ({ sleeps: pendingSleeps().length }));
    /** A timer as its owner sees it: what it is, when it is next due, the last firing of it. */
    const entityOf = (entry: Scheduled): TimerEntity => {
      const saved = memory.get()[entry.id];
      const last = lastFiringOf(api.journal?.(), entry.id);
      return {
        name: entry.id,
        description: entry.description,
        schedule: scheduleOf(entry.def),
        missed: entry.missed,
        nextDue: saved === undefined || saved.done ? null : saved.due,
        lastFiring: last === undefined ? null : idSchema("firing").parse(last),
      };
    };
    // The timers and the sleeps name the runs that asked: they are the owner's to see.
    const onlyOwner = (caller: { kind: string; principal?: { kind: string } }): void => {
      if (caller.kind === "client" && caller.principal?.kind !== "owner") throw new DeniedError("only the owner sees the pending sleeps and timers");
    };
    api.action(
      action(timerList, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (_input, ctx) => {
          onlyOwner(ctx.caller);
          return {
            sleeps: pendingSleeps().map(({ at, row }) => {
              // The run that asked is the data of the record the chain began with; a handler that is no run is named by its invocation.
              const asked = (api.journal?.()?.get(row.root)?.data as { run?: unknown } | undefined)?.run;
              const who = typeof asked === "string" ? shortRun(asked) : row.actor.kind === "handler" ? shortInvocation(String(row.actor.invocation)) : row.actor.kind;
              // The request is written by the sleep's step: its id is the step's operation, `<invocation>/<key>/emit/1`.
              const label = String(row.id).replace(/\/emit\/\d+$/, "").split("/").at(-1)?.replace(/~arm$/, "").replace(/^label:/, "") ?? "";
              return `${clockOf(at)}  ${who}  ${label}`;
            }),
            timers: scheduleOfHost().map(entityOf),
          };
        },
      }),
    );
    api.action(
      action(timerGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: ({ name }, ctx) => {
          onlyOwner(ctx.caller);
          const entry = scheduleOfHost().find((one) => one.id === name);
          if (entry === undefined) throw new UnknownId(name, "timer");
          return entityOf(entry);
        },
      }),
    );
    // A sleep is asked for by this action, as a step of the handler that sleeps: the request is a
    // record of the timers, written once.
    api.action(
      action(timerSleepRequest, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          await ctx.emit(SleepRequested, input);
          return {};
        },
      }),
    );
    // A sleep that is asked for is armed at once: the wake is a record the waiting handler is
    // woken by, and it is written when the moment of the sleep comes.
    api.on(SleepRequested, { id: "timer-sleep" }, (data) => {
      askSleep?.(data);
    });
  });
}

/** How a timer says when it fires. */
const TimerSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), ms: z.number() }),
  z.object({ kind: z.literal("at"), at: z.number() }),
  z.object({ kind: z.literal("daily"), time: z.string() }),
]);
type TimerSchedule = z.infer<typeof TimerSchedule>;

/** One timer as `timer.list` and `timer.get` show it. */
export const TimerEntity = z.object({
  /** The author's name for the timer: what the firings carry and what `timer.get` takes. */
  name: TimerId,
  description: EntityDescription,
  schedule: TimerSchedule,
  /** What the timer does with the dues missed while the host was down. */
  missed: z.enum(["once", "skip"]),
  /** The next moment the timer is due, in milliseconds since the epoch; null when it is done. */
  nextDue: z.number().nullable(),
  /** The firing with the latest due, null when the timer has not fired. */
  lastFiring: idSchema("firing").nullable(),
});
export type TimerEntity = z.infer<typeof TimerEntity>;

/** What `timer.list` shows: the pending sleeps, one line each, and the timers. */
export const timerList = actionRef("timer.list", {
  description:
    "The pending sleeps and the timers. A sleep is one line: the moment it ends, the run or invocation that asked and its label. A timer is its name, description, schedule, next due and the id of its last firing; take a name from here to get one.",
  input: z.object({}),
  output: z.object({ sleeps: z.array(z.string()), timers: z.array(TimerEntity) }),
});

/** One timer by its name. */
export const timerGet = actionRef("timer.get", {
  description: "Get one timer by its name: its description, schedule, next due and the id of its last firing.",
  input: z.object({ name: z.string().min(1) }),
  output: TimerEntity,
});

/** The schedule of a timer, as data. */
function scheduleOf(def: TimerDef): TimerSchedule {
  if (def.every !== undefined) return { kind: "every", ms: def.every };
  if (def.daily !== undefined) return { kind: "daily", time: def.daily };
  return { kind: "at", at: def.at };
}

/** How a timer says when it fires, for a person who gave it no description. */
function scheduleText(def: TimerDef): string {
  if (def.every !== undefined) return `every ${String(def.every)}ms`;
  if (def.daily !== undefined) return `daily ${def.daily}`;
  return `at ${new Date(def.at).toISOString()}`;
}

/** The id of the latest firing of a timer: the one with the greatest due. */
function lastFiringOf(journal: JournalReader | undefined, timer: TimerId): string | undefined {
  let latest: { id: string; due: number } | undefined;
  for (const row of journal?.since(seq(0), [TimerFired.name]) ?? []) {
    const data = row.data as TimerFiredData;
    if (data.timer === timer && (latest === undefined || data.due > latest.due)) latest = { id: String(row.id), due: data.due };
  }
  return latest?.id;
}

/** The definition of a timer, whether it came as a definition or as a trigger. */
function defOf(def: TimerOffer): TimerDef {
  return "timer" in def ? def.def : def;
}

/** One timer, with its rule checked. */
function build(def: TimerDef): Scheduled {
  const id = timerId(def.id);
  const count = [def.every !== undefined, def.at !== undefined, def.daily !== undefined].filter(
    Boolean,
  ).length;
  if (count === 0) {
    throw new Error(`timer "${id}" says neither "every", "at" nor "daily": it would never fire`);
  }
  if (count > 1) {
    throw new Error(`timer "${id}" has more than one schedule: one timer has one schedule`);
  }
  if (def.every !== undefined) requirePeriod(def.every);
  if (def.at !== undefined) timestamp(def.at);
  if (def.daily !== undefined) parseTimeOfDay(def.daily);
  const description = EntityDescription.safeParse(def.description ?? scheduleText(def));
  if (!description.success) throw new TypeError(`timer "${id}" has a bad description: ${description.error.issues[0]?.message ?? "invalid"}`);
  const missed = def.missed ?? DEFAULT_MISSED;
  if (missed !== "once" && missed !== "skip") {
    throw new Error(`timer "${id}" has an unknown missed rule "${String(missed)}"`);
  }
  return { id, def, description: description.data, missed, due: timestamp(0), done: false, firing: false, retryAt: 0 };
}

/** A period is a positive whole number of milliseconds: the moments it makes are timestamps. */
function requirePeriod(ms: number): void {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new TypeError(
      `a timer period must be a positive whole number of milliseconds, got ${String(ms)}`,
    );
  }
}

/** A time of day is "HH:MM" in local time. */
function parseTimeOfDay(time: string): string {
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) {
    throw new TypeError(`a time of day must be "HH:MM", got ${JSON.stringify(time)}`);
  }
  const [hours, minutes] = time.split(":").map(Number);
  if (hours === undefined || minutes === undefined || hours > 23 || minutes > 59) {
    throw new TypeError(`a time of day must be "HH:MM" in 24 hours, got ${JSON.stringify(time)}`);
  }
  return time;
}

/** The schema of what the plugin remembers about its timers. */
const ScheduleSchema: z.ZodType<Schedule> = z.record(
  z.string(),
  z.object({ due: z.number(), done: z.boolean() }),
);

/** The first moment a timer is due, when the plugin does not know one yet. */
function firstDue(entry: Scheduled, now: Timestamp): Timestamp {
  const { def } = entry;
  if (def.every !== undefined) return timestamp(now + def.every);
  if (def.daily !== undefined) return nextTimeOfDay(def.daily, now);
  return timestamp(def.at as number);
}

/**
 * Where a saved schedule stands, unless the due it points at already fired.
 *
 * The schedule is remembered after the firing is written, so a host that died in between left a
 * schedule pointing at a due the journal already holds. That due is settled: the timer goes on
 * exactly as the tick that wrote the firing would have, from the moment the firing carries.
 * Each step follows one firing of the journal, so the walk is as long as the firings the
 * schedule did not remember, not as the downtime.
 */
function settle(
  entry: Scheduled,
  saved: ScheduleEntry,
  journal: JournalReader | undefined,
  ids: IdIndex<"firing">,
): ScheduleEntry {
  let { due, done } = { due: saved.due, done: saved.done };
  while (!done) {
    const firing = journal?.get(recordId(firingId(ids, entry.id, timestamp(due))));
    if (firing === undefined) break;
    const at = (firing.data as TimerFiredData).at;
    const following = nextDue(entry, timestamp(at));
    if (following === undefined) {
      done = true;
    } else if (following > due) {
      due = following;
    } else {
      break;
    }
  }
  return { due, done };
}

/**
 * The next moment a timer is due, given the moment it fired.
 *
 * A timer that fires once has no next due: the answer is undefined, and the timer is done.
 */
function nextDue(entry: Scheduled, now: Timestamp): Timestamp | undefined {
  const { def } = entry;
  if (def.every !== undefined) return timestamp(now + def.every);
  if (def.daily !== undefined) return nextTimeOfDay(def.daily, now);
  return undefined;
}

/** The next moment of a time of day, after `from`. */
function nextTimeOfDay(time: string, from: Timestamp): Timestamp {
  const [hours, minutes] = time.split(":").map(Number);
  const day = new Date(from);
  day.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (day.getTime() <= from) {
    day.setDate(day.getDate() + 1);
    // The hour is set again: on the day a clock change skipped it, the first setting landed on
    // the next hour, and the next day has its own.
    day.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  }
  return timestamp(day.getTime());
}

/** A stored record that cannot be what it says it is: it is left out, and the log says so. */
function skipped(what: string, key: unknown): void {
  console.error(`niwa: ${what} with the sleep key ${JSON.stringify(key)} is skipped: a sleep key is a non-empty string without whitespace`);
}

/** What the plugin remembers about its timers. */
function remember(memory: StateHandle<Schedule>, running: readonly Scheduled[]): void {
  memory.update((current) => {
    const next = { ...current };
    for (const entry of running) {
      next[entry.id] = { due: entry.due, done: entry.done };
    }
    return next;
  });
}

/**
 * Write the firing of one timer.
 *
 * The id is the one of the timer and the due, so a firing written twice is the same record. The
 * answer is whether the firing is in the journal: only then may the timer go on to its next due.
 */
async function fire(
  ctx: ServiceContext,
  entry: Scheduled,
  due: Timestamp,
  at: Timestamp,
  journal: JournalReader | undefined,
  ids: IdIndex<"firing">,
  stopped: () => boolean,
): Promise<boolean> {
  const id = recordId(firingId(ids, entry.id, due));
  // The firing carries the moment it was written, so a second write of it is not the same
  // content: the one that is already in the journal is the firing, and it is not written again.
  if (journal?.get(id) !== undefined) return true;
  try {
    await ctx.emit(TimerFired, { timer: entry.id, due, at }, { id });
    return true;
  } catch (error) {
    if (error instanceof IntegrityError) return true; // written in the meantime
    if (stopped()) return false; // the host is closing
    console.error(
      `niwa: the timer "${entry.id}" could not write its firing, it is tried again: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
