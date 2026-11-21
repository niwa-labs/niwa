// Record types a plugin of a test host declares and a script imports: a script names them by reference.

import { record } from "@niwa-labs/core";
import { z } from "zod";

export const Ping = record("ping.sent", z.object({ id: z.string(), size: z.number(), to: z.object({ id: z.string() }) }));
export const Pong = record("pong.sent", z.object({ id: z.string(), ok: z.boolean() }));
/** The same name at a version the host does not write. */
export const PingAhead = record("ping.sent", z.object({ id: z.string() }), { version: 2 });
/** A type no plugin of the host declares. */
export const Unheard = record("never.sent", z.object({ id: z.string() }));
