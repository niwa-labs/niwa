// Record types a plugin of a test host declares and a script imports: a script names them by reference.

import { queryOf, record } from "@niwa-labs/core";
import { z } from "zod";

export const Ping = record("ping.sent", z.object({ id: z.string(), size: z.number(), to: z.object({ id: z.string() }) }));
export const Pong = record("pong.sent", z.object({ id: z.string(), ok: z.boolean() }));
/** The same name at a version the host does not write. */
export const PingAhead = record("ping.sent", z.object({ id: z.string() }), { version: 2 });
/** A type no plugin of the host declares. */
export const Unheard = record("never.sent", z.object({ id: z.string() }));

/** The pings sent to one address: a query builder, as a plugin's records entry gives one. */
export const pingsTo = (id: string) => queryOf(Ping, { "to.id": id });
/** The pings of one id at a version the host does not write, made by a function declaration. */
export function aheadOf(id: string) {
  return queryOf(PingAhead, { id });
}
/** One record of a type no plugin of the host declares, as a builder gives it. */
export const unheardOf = (id: string) => queryOf(Unheard, { id });
