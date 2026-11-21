/**
 * The native format of a Codex rollout: what one line of the file says.
 *
 * A rollout is JSONL: one record per line, each line `{timestamp, ordinal, type, payload}`. The
 * record types that matter here:
 *
 * - `session_meta` — the session: its id, its working directory, when it started.
 * - `turn_context` — the turn: its model, its id.
 * - `response_item` — the conversation: what the model was given and what it produced.
 * - `event_msg` — the interface of Codex: the conversation rendered as items.
 * - `compacted` — the context was replaced by a summary.
 * - `realtime_item` — the voice mode: transcript segments of the conversation.
 *
 * Two layers live in one file, and they are not the same thing. The conversation layer
 * (`response_item`) is what the model was actually given and produced. The event layer
 * (`event_msg`) is how Codex shows it, and it repeats most of the conversation under its own ids.
 *
 * The format grows without notice, so an unfamiliar record is kept whole and never fails a read.
 */

import { z } from "zod";

import { timestamp } from "@niwa-labs/core";
import type { Timestamp } from "@niwa-labs/core";
import type { ImageMark } from "@niwa-labs/harness";

/** The wrapper Codex writes around every payload. */
export const NativeRecordSchema = z.object({
  timestamp: z.string().optional(),
  ordinal: z.number().optional(),
  type: z.string(),
  payload: z.unknown().optional(),
});

/** A native record of a rollout. */
export type NativeRecord = z.output<typeof NativeRecordSchema>;

/** A native record, or `null` when the value is not one. */
export function parseNativeRecord(value: unknown): NativeRecord | null {
  const result = NativeRecordSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** The payload of a record, as an object; an empty object when it is not one. */
export function payloadOf(record: NativeRecord): Record<string, unknown> {
  return typeof record.payload === "object" && record.payload !== null
    ? (record.payload as Record<string, unknown>)
    : {};
}

/** The moment of a native timestamp, in milliseconds; `undefined` when it cannot be read. */
export function instantOf(value: unknown): Timestamp | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return timestamp(Math.floor(ms));
}

/** The texts of a content list: Codex writes `{type, text}` parts. */
export function textsOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as Record<string, unknown>)["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/** What a part of Codex's content says of itself when it is an image: its media type when its address is a data URL. */
function imageOf(part: Record<string, unknown>): { mime?: string } | undefined {
  if (part["type"] !== "input_image" && part["type"] !== "output_image" && part["type"] !== "image") return undefined;
  const source = part["image_url"];
  const url = typeof source === "string" ? source : typeof source === "object" && source !== null ? (source as Record<string, unknown>)["url"] : undefined;
  const mime = typeof url === "string" ? /^data:([^;,]+)[;,]/.exec(url)?.[1] : undefined;
  return mime === undefined ? {} : { mime };
}

/**
 * The parts of a message or a result joined into text, one line each, with the images taken out and
 * marked where they stood in that text. `render` says what a part that is not an image is as text.
 */
function joinParts(content: readonly unknown[], render: (part: Record<string, unknown>) => string | undefined): { text: string; images: ImageMark[] } {
  let text = "";
  let any = false;
  const images: ImageMark[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    const image = imageOf(record);
    if (image !== undefined) {
      images.push({ at: text.length, ...image });
      continue;
    }
    const piece = render(record);
    if (piece === undefined) continue;
    text = any ? `${text}\n${piece}` : piece;
    any = true;
  }
  return { text, images };
}

/** What a person or the model said in a message of Codex: its text parts, and the images that stood among them. */
export function messageOf(content: unknown): { text: string; images: ImageMark[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  return joinParts(content, (part) => (typeof part["text"] === "string" && part["text"].length > 0 ? part["text"] : undefined));
}

/**
 * The arguments of a tool call, as Codex gave them.
 *
 * A JSON string is parsed; anything else is kept as it is. The result is parsed but not
 * validated: niwa does not know the schema of every tool Codex has.
 */
export function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The output of a tool result, as Codex gave it: a string or a list of parts joined into text. The
 * images of the parts are not in the text: they are marks where they stood.
 */
export function outputOf(raw: unknown): { output: unknown; images: ImageMark[] } {
  if (!Array.isArray(raw)) return { output: raw, images: [] };
  const { text, images } = joinParts(raw, (part) => (typeof part["text"] === "string" ? part["text"] : JSON.stringify(part)));
  return { output: text, images };
}

/**
 * Whether a tool result failed.
 *
 * Codex says a failure in three ways: an explicit `error`, a non-zero exit code in the metadata,
 * and a failed status. A result that says none of these succeeded. A result that says nothing at
 * all is unknown: success is never claimed for an outcome that was not reported.
 */
export function outcomeOf(
  output: unknown,
  status: unknown,
): { readonly ok: boolean; readonly text: string } | undefined {
  const text = typeof output === "string" ? output : textsOf(output);
  if (typeof status === "string" && status === "failed") return { ok: false, text };
  let parsed: unknown;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      return undefined;
    }
  } else {
    parsed = output;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["error"] !== undefined && record["error"] !== null) return { ok: false, text };
  const metadata = record["metadata"];
  const meta =
    typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const exit = meta["exit_code"];
  if (typeof exit === "number") return { ok: exit === 0, text };
  return undefined;
}

/**
 * The summary a compaction carries.
 *
 * Codex writes the messages it kept, not a prose summary: `retained_context` holds the owner's
 * and the assistant's messages by order. Those are what survived the compaction, so they are the
 * summary. A file without them says so with an empty summary rather than a made-up one.
 */
export function compactionSummary(payload: Record<string, unknown>): string {
  const message = payload["message"];
  if (typeof message === "string" && message.trim().length > 0) return message;
  const retained = payload["retained_context"];
  if (typeof retained !== "object" || retained === null) return "";
  const context = retained as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["user_messages", "assistant_messages"] as const) {
    const messages = context[key];
    if (!Array.isArray(messages)) continue;
    for (const entry of messages) {
      if (typeof entry !== "object" || entry === null) continue;
      const text = (entry as Record<string, unknown>)["text"];
      if (typeof text !== "string" || text.length === 0) continue;
      parts.push(`${key === "user_messages" ? "owner" : "assistant"}: ${text}`);
    }
  }
  return parts.join("\n");
}
