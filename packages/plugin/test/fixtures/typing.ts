// Code that a plugin author writes. A line ending in `// error` must not compile; every other line must.

import { record } from "@niwa-labs/core";
import { z } from "zod";

import { offerKey, plugin, trigger as triggerOf, TIMER_OFFER } from "../../src/index.ts";
import type { PluginApi, TimerDef, TimerOffer, Trigger } from "../../src/index.ts";

plugin("typing-sync", (api) => {
  api.declare();
});
plugin("typing-expression", (api) => api.declare());
plugin("typing-named", function setup(api: PluginApi) {
  api.declare();
});
plugin("typing-async", async (api) => { // error
  api.declare();
});
plugin("typing-promise", (api) => Promise.resolve(api.declare())); // error
plugin("typing-async-named", async function setup(api: PluginApi) { api.declare(); }); // error
plugin("typing-maybe-async", (api: PluginApi): void | Promise<void> => api.declare()); // error

export const every: TimerDef = { id: "a", every: 1000 };
export const at: TimerDef = { id: "a", at: 1000, missed: "skip" };
export const daily: TimerDef = { id: "a", daily: "04:00", description: "d" };
export const none: TimerDef = { id: "a" }; // error
export const two: TimerDef = { id: "a", every: 1000, daily: "04:00" }; // error
export const three: TimerDef = { id: "a", every: 1000, at: 1, daily: "04:00" }; // error

type Firing = Trigger<{ timer: string; due: number; at: number }>;
declare const trigger: Firing & { readonly timer: string; readonly def: TimerDef };
declare const unscheduled: Firing & { readonly timer: string };
export const plain: TimerOffer = { id: "a", every: 1000 };
export const carried: TimerOffer = trigger;
export const bare: TimerOffer = unscheduled; // error

const Ping = record("typing.ping", z.object({ who: z.string() }));
export const offered = triggerOf(Ping, { name: "ping", filter: {}, offer: { key: TIMER_OFFER, value: { id: "a", every: 1000 } } });
export const offerOfAnother = triggerOf(Ping, { name: "ping", filter: {}, offer: { key: TIMER_OFFER, value: 123 } }); // error
export const offerOfNone = triggerOf(Ping, { name: "ping", filter: {}, offer: { key: offerKey<string>("typing.point", "reader"), value: "x" } });
export const wrongOffer = triggerOf(Ping, { name: "ping", filter: {}, offer: { key: offerKey<string>("typing.point", "reader"), value: 1 } }); // error
