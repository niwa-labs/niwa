/**
 * The session actions as the cockpit calls them: name and the part of each schema the pages read.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const SessionState = z.enum(["running", "idle", "ended", "unknown"]);

export const SessionEntry = z.object({
  id: z.string().optional(),
  ref: z.string(),
  run: z.string().optional(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  state: SessionState,
});
export type SessionEntry = z.infer<typeof SessionEntry>;

export const sessionStateAction = {
  name: "session.get",
  input: z.object({ id: z.string() }),
  output: z.object({ state: SessionState }),
} as const;

export const listAction = {
  name: "session.list",
  input: z.object({ limit: z.number().int().positive().optional(), cursor: z.string().optional(), managedOnly: z.boolean().optional() }),
  output: z.object({ sessions: z.array(SessionEntry), total: z.number(), nextCursor: z.string().optional(), unreadable: z.array(z.object({ harness: z.string(), reason: z.string() })).optional(), hint: z.string().optional() }),
} as const;

const Base = { locator: z.string().optional(), at: z.number().optional() };
const Inserted = z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive() })
  .refine(({ from, to }) => to > from);
const Image = z.object({ at: z.number().int().nonnegative(), mime: z.string().optional() });

/** A record of a session's transcript. Kinds the page does not draw are `unknown`. */
export const TranscriptRecord = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string(), inserted: z.array(Inserted).optional(), images: z.array(Image).optional(), ...Base }),
  z.object({ kind: z.literal("assistant"), text: z.string(), model: z.string().optional(), ...Base }),
  z.object({ kind: z.literal("thinking"), text: z.string(), redacted: z.boolean(), ...Base }),
  z.object({ kind: z.literal("tool-call"), callId: z.string(), name: z.string(), category: z.string().optional(), target: z.string().optional(), paths: z.array(z.string()).optional(), input: z.unknown().optional(), ...Base }),
  z.object({ kind: z.literal("tool-result"), callId: z.string(), name: z.string().optional(), output: z.unknown().optional(), ok: z.boolean().optional(), ...Base }),
  z.object({ kind: z.literal("checklist"), callId: z.string().optional(), items: z.array(z.object({ text: z.string(), state: z.string() })), ...Base }),
  z.object({ kind: z.literal("permission"), callId: z.string().optional(), tool: z.string().optional(), outcome: z.string(), ...Base }),
  z.object({ kind: z.literal("compaction"), summary: z.string(), ...Base }),
  z.object({ kind: z.literal("nested"), child: z.object({ harness: z.string(), native: z.string() }), ...Base }),
  z.object({ kind: z.literal("unknown"), metadata: z.literal(true).optional(), raw: z.unknown().optional(), ...Base }),
]);
export type TranscriptRecord = z.infer<typeof TranscriptRecord>;

export const readAction = {
  name: "session.read",
  input: z.object({ session: z.string(), window: z.object({ limit: z.number().int().positive().max(250), before: z.string().optional() }).optional() }),
  output: z.object({ records: z.array(TranscriptRecord), coverage: z.object({ status: z.string(), reason: z.string().optional() }).optional(), page: z.object({ hasEarlier: z.boolean() }).optional() }),
} as const;
