/**
 * The reading side: how niwa reads what a harness already holds. One interface for every harness
 *. Niwa copies nothing: it keeps a pointer and an index and reads
 * through this side on demand.
 */

import { z } from "zod";

import { JsonValueSchema } from "@niwa-labs/core";
import type { Timestamp } from "@niwa-labs/core";

import { HarnessIdSchema } from "./instance.ts";

/** The id the harness gave a session. Niwa issues no session ids of its own. */
export const NativeSessionIdSchema = z.string().min(1).brand<"NativeSessionId">();
export type NativeSessionId = z.output<typeof NativeSessionIdSchema>;

/** The identity of a session: the harness id and the id that harness gave it. */
export const SessionIdSchema = z.object({
  harness: HarnessIdSchema,
  native: NativeSessionIdSchema,
});
export type SessionId = z.output<typeof SessionIdSchema>;

export function sessionId(harness: SessionId["harness"], native: string): SessionId {
  return { harness, native: NativeSessionIdSchema.parse(native) };
}

export function sameSession(a: SessionId, b: SessionId): boolean {
  return a.harness === b.harness && a.native === b.native;
}

/**
 * The reading side's own pointer into the harness's storage, tied to the revision of the session
 * file it was taken from. Opaque to everyone else: only the side that issued it may look inside,
 * and it is not a cursor over niwa's journal.
 */
export const LocatorSchema = z.string().min(1).brand<"Locator">();
export type Locator = z.output<typeof LocatorSchema>;

/** What the reading side knows for sure about a session; an unknown field is absent. */
export interface SessionInfo {
  readonly id: SessionId;
  /**
   * A readable title: the harness's own name or summary of the session when it has one, else its
   * first message from a person, trimmed (`titleFromText`).
   */
  readonly title?: string;
  readonly cwd?: string;
  readonly startedAt?: Timestamp;
  readonly updatedAt?: Timestamp;
}

export interface SessionFilter {
  readonly cwd?: string;
  /** Only sessions changed at or after this moment. */
  readonly since?: Timestamp;
  /**
   * Only the sessions with these native ids. The reading side leaves the others out before it
   * reads anything of them, so what a caller wants of a few sessions does not cost a look at all.
   */
  readonly natives?: readonly string[];
}

/**
 * How much of a session or a range was read. "I do not know" is never shown as "nothing": only
 * `empty` means there is nothing there.
 */
export type Coverage =
  | { readonly status: "not-scanned" }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export const NOT_SCANNED: Coverage = { status: "not-scanned" };
export const EMPTY: Coverage = { status: "empty" };

export function failedCoverage(reason: string): Coverage {
  return { status: "failed", reason };
}

export function unavailableCoverage(reason: string): Coverage {
  return { status: "unavailable", reason };
}

/** What every record carries: where it is, when it happened, and whether it is whole. */
const recordBase = {
  locator: LocatorSchema,
  at: z.number().int().nonnegative().optional(),
  /** A half-written tail of a running session: marked, and the reader does not move past it. */
  incomplete: z.boolean().default(false),
};

export const UserRecordSchema = z.object({
  kind: z.literal("user"),
  text: z.string(),
  ...recordBase,
});

export const AssistantRecordSchema = z.object({
  kind: z.literal("assistant"),
  text: z.string(),
  model: z.string().optional(),
  ...recordBase,
});

/** What the model thought before it answered; a thought the harness keeps sealed has no text. */
export const ThinkingRecordSchema = z.object({
  kind: z.literal("thinking"),
  text: z.string(),
  redacted: z.boolean(),
  ...recordBase,
});

export const ToolCallRecordSchema = z.object({
  kind: z.literal("tool-call"),
  /** The harness's id of the call, so its result can be paired with it. */
  callId: z.string().min(1),
  name: z.string().min(1),
  input: JsonValueSchema.optional(),
  ...recordBase,
});

export const ToolResultRecordSchema = z.object({
  kind: z.literal("tool-result"),
  callId: z.string().min(1),
  name: z.string().optional(),
  output: JsonValueSchema.optional(),
  ok: z.boolean().optional(),
  ...recordBase,
});

/** The harness replaced the context with its own summary. */
export const CompactionRecordSchema = z.object({
  kind: z.literal("compaction"),
  summary: z.string(),
  ...recordBase,
});

/** The harness spawned a session inside this one. */
export const NestedRecordSchema = z.object({
  kind: z.literal("nested"),
  child: SessionIdSchema,
  ...recordBase,
});

/**
 * A record niwa does not understand: an unfamiliar record is "unknown" with its raw data kept,
 * never an error.
 */
export const UnknownRecordSchema = z.object({
  kind: z.literal("unknown"),
  raw: z.unknown(),
  ...recordBase,
});

/**
 * The common record kinds: few, and the same for every harness.

 */
export const SessionRecordSchema = z.discriminatedUnion("kind", [
  UserRecordSchema,
  AssistantRecordSchema,
  ThinkingRecordSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  CompactionRecordSchema,
  NestedRecordSchema,
  UnknownRecordSchema,
]);

export type SessionRecord = z.output<typeof SessionRecordSchema>;

/** The kind of a session record, by name. */
export type SessionRecordKind = SessionRecord["kind"];

/**
 * The reading side of a harness. An undeclared ability is refused by name and an installation that
 * cannot serve one says so (capabilities.ts).
 */
export interface SessionReading {
  /** Lists sessions from the harness's files; the harness need not be running. */
  list(filter?: SessionFilter): AsyncIterable<SessionInfo>;

  /** Reads a session; `from` is a locator taken from an earlier record of the same session. */
  read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord>;

  /** Follows a session while it grows. */
  watch?(id: SessionId): AsyncIterable<SessionRecord>;

  /** The harness's own record whole, at a locator. Never written into niwa's journal. */
  raw(id: SessionId, locator: Locator): Promise<unknown>;

  /** The schema of `raw`. */
  readonly rawSchema: z.ZodType<unknown>;

  /** Coverage of a session, or of the range after `from`. */
  coverage(id: SessionId, from?: Locator): Promise<Coverage>;
}

/** About how long a title made from a message is. */
export const TITLE_LENGTH = 60;

/**
 * A readable title made from the text of a message.
 *
 * What a harness or niwa wrapped in a tag of its own (`<system-reminder>…</system-reminder>`,
 * `<environment_context>…</environment_context>`, …) is not what the person said, so it is cut
 * out. Whitespace is collapsed and the rest is cut to about 60 characters, at a word when one is
 * near. `undefined` when nothing is left.
 */
export function titleFromText(text: string): string | undefined {
  const said = text
    .replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (said.length === 0) return undefined;
  if (said.length <= TITLE_LENGTH) return said;
  const head = said.slice(0, TITLE_LENGTH);
  // A cut that falls between two words keeps the whole of the last one.
  const space = said[TITLE_LENGTH] === " " ? TITLE_LENGTH : head.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** How many records the title of a session is looked for in, at most. */
const TITLE_RECORDS = 50;

/**
 * The title of a session made from its first message from a person, among its first records.
 *
 * A message that is not what a person said can be passed over with `skip` (a harness's own
 * preamble, for one). Reading stops at the first message that gives a title.
 */
export async function firstMessageTitle(
  records: AsyncIterable<SessionRecord>,
  skip?: (text: string) => boolean,
): Promise<string | undefined> {
  let seen = 0;
  for await (const record of records) {
    if (seen >= TITLE_RECORDS) return undefined;
    seen += 1;
    if (record.kind !== "user" || (skip?.(record.text) ?? false)) continue;
    const title = titleFromText(record.text);
    if (title !== undefined) return title;
  }
  return undefined;
}

/** The file a title was made from, as it was when the title was made. */
export interface TitleKey {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * The titles made from the first messages of session files, kept in memory by the reading side
 * that made them.
 *
 * A title is found by reading the head of a file, which for a compressed one means decoding it,
 * and a listing does that for every session. A title kept under the path of its file, with the
 * size and the time the file had, is read again only when the file is not the same: a session
 * that grows is looked at again, one that does not is not. A session without a title is kept
 * too, so it is not looked for on every listing. The cache lives as long as the reading side,
 * and nothing is written to disk.
 */
export class TitleCache {
  readonly #entries = new Map<string, { key: TitleKey; title: string | undefined }>();

  /** The title kept for the file, `{ title: undefined }` for a kept absence, `undefined` for nothing kept. */
  get(path: string, key: TitleKey): { title: string | undefined } | undefined {
    const kept = this.#entries.get(path);
    if (kept === undefined || kept.key.size !== key.size || kept.key.mtimeMs !== key.mtimeMs) return undefined;
    return { title: kept.title };
  }

  /** Keep the title found in the file as it was at `key`. */
  set(path: string, key: TitleKey, title: string | undefined): void {
    this.#entries.set(path, { key, title });
  }

  /** How many files have a title or an absence kept. */
  get size(): number {
    return this.#entries.size;
  }
}
