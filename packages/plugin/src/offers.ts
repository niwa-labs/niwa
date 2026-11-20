/**
 * What a plugin offers to the plugins that read it (`api.offer`, `api.offers`): the built-in workflows a plugin ships
 * go to the workflow module, the timers it needs to the timers. The points and the shape of what is offered live here,
 * so the offering plugin imports no reader.
 *
 * Built-in workflows: scripts a plugin ships in its own tree and niwa runs by itself. A plugin offers each one in its setup —
 * `api.offer(BUILTIN_WORKFLOW, { name, file, description, triggers })` — and the workflow module, installed after it,
 * does the rest when the host starts: it registers the file (its code is stored under the home, its version is the hash
 * of its source closure, so a changed file in a new build of niwa is a new version by itself) and installs it on the
 * `on` of the script, under a profile that is exactly its `uses`. A built-in the plugin no longer offers is
 * uninstalled. The pair (plugin, name) finds the same `wf-…` again on every start, so nothing is made twice.
 *
 * The owner does not edit a built-in: registering a file under its id and uninstalling it are refused; it is turned
 * off by the option of the plugin that offers it.
 */

import type { RecordType } from "@niwa-labs/core";
import { offerKey } from "./plugin.ts";
import type { OfferKey } from "./plugin-types.ts";

/** One built-in workflow, as its plugin offers it. */
export interface BuiltinWorkflow {
  /** Its name among the built-ins of the plugin: with the plugin, what finds it again across restarts. */
  readonly name: string;
  /** The script: an absolute path inside the plugin's own tree. */
  readonly file: string;
  /** A few words on one line: what it is registered and installed under. */
  readonly description: string;
  /**
   * The record types its `on` names, other than the records of scripts: the workflow module starts runs on them as
   * on the `triggers` it is given, so the owner does not list them. A type is given by its name when the plugin that
   * declares it is not one the offering plugin imports (`"timer.fired"`): it must be declared by a plugin installed
   * before the workflow module.
   */
  readonly triggers?: ReadonlyArray<RecordType<any> | string>;
}

/** Where a plugin offers a built-in workflow: `api.offer(BUILTIN_WORKFLOW, { name, file, description, triggers })`. */
export const BUILTIN_WORKFLOW: OfferKey<BuiltinWorkflow> = offerKey("workflow.builtin", "workflow");

/**
 * What a timer does with the dues it missed while the host was down.
 *
 * - "once": one firing for all the missed dues.
 * - "skip": nothing for the missed dues.
 */
export type MissedRule = "once" | "skip";

/**
 * One timer: when it fires, and what it does with the dues it missed.
 *
 * A timer has one schedule: a period (`every`), a moment (`at`) or a time of day (`daily`). A
 * timer with no schedule never fires; a timer with two is refused, because two schedules for
 * one timer is not a choice anybody can make.
 */
export interface TimerDef {
  /** The id of the timer: the author's name for it, which the firings carry. */
  readonly id: string;
  /** A few words a person reads in a list. Without one, the schedule is the description. */
  readonly description?: string;
  /** The period, in milliseconds. The timer fires again every period. */
  readonly every?: number;
  /** The moment, in milliseconds since the epoch. The timer fires once. */
  readonly at?: number;
  /** The time of day, "HH:MM" in local time. The timer fires every day at that time. */
  readonly daily?: string;
  /** What to do with the dues missed while the host was down. Default: "once". */
  readonly missed?: MissedRule;
}

/**
 * A timer as a plugin offers it: the plain definition, or the trigger that carries one (`timer.daily("04:00", { id })`).
 * The data of a firing is what the trigger is a record type of.
 */
export type TimerOffer = TimerDef | (RecordType<{ timer: string; due: number; at: number }> & { readonly timer: string; readonly def?: TimerDef });

/**
 * Where a plugin offers a timer it needs (`api.offer(TIMER_OFFER, { id, daily: "04:00" })`): the timers
 * plugin schedules it with the ones it is given, so the owner does not list it. A timer of the same id in the
 * owner's list is the one that is scheduled.
 */
export const TIMER_OFFER: OfferKey<TimerOffer> = offerKey("timer", "timers");
