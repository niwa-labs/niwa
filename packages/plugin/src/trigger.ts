/**
 * A trigger: a record type with a filter on it, made once and handed to `api.on` — the firings of one
 * timer, the messages to sessions.
 *
 * A trigger is not a record type: it is never declared, and it names the type it narrows. Its filter
 * is equality on paths of the data, as every subscription's is. Two triggers of one type are two
 * subscriptions, so each names the handler it makes. A trigger carries what its records need besides
 * the subscription: the plugin that writes them, so a host without it says what to install, and an
 * offer the subscribing plugin makes so that they are written at all (the schedule of a timer).
 */

import type { PathFilter, RecordType } from "@niwa-labs/core";

import type { OfferKey } from "./plugin-types.ts";

/** What a plugin offers when it subscribes to a trigger: a value at a point another plugin reads. */
export interface TriggerOffer<V> {
  readonly key: OfferKey<V>;
  readonly value: V;
}

export interface Trigger<T> {
  readonly kind: "trigger";
  /** The record type the trigger narrows. */
  readonly type: RecordType<T>;
  /** Equality on paths of the data: the records of the type the trigger watches. */
  readonly filter: PathFilter<T>;
  /** The name a handler of the trigger gets when it does not name itself. */
  readonly name: string;
  /** The plugin that writes the records: named when no installed plugin declares the type. */
  readonly provider?: string;
  /** What a plugin that subscribes offers, so that the records are written: the host makes the offer for it. */
  readonly offer?: TriggerOffer<any>;
}

/** A trigger over a type: the records whose data holds the filter, under a handler name of its own. */
export function trigger<T>(
  type: RecordType<T>,
  spec: { readonly name: string; readonly filter: PathFilter<T>; readonly provider?: string; readonly offer?: TriggerOffer<any> },
): Trigger<T> {
  if (spec.name.length === 0) throw new TypeError(`a trigger of "${type.name}" needs a name for its handlers`);
  return {
    kind: "trigger",
    type,
    filter: spec.filter,
    name: spec.name,
    ...(spec.provider === undefined ? {} : { provider: spec.provider }),
    ...(spec.offer === undefined ? {} : { offer: spec.offer }),
  };
}

/** What `api.on` takes: a record type, or a trigger over one. */
export type Subscribable<T> = RecordType<T> | Trigger<T>;

/** Is it a trigger, not a plain record type? */
export function isTrigger<T>(source: Subscribable<T>): source is Trigger<T> {
  return source.kind === "trigger";
}
