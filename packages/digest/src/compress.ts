/**
 * The compressor: a reading of a session in the common model, kept whole (`full`), cut to what a
 * reader needs line by line (`digest`), or summed up (`brief`). It is mechanical: no model reads
 * anything here, and the same records always give the same result.
 */

import { createHash } from "node:crypto";

import { checklistProgress } from "@niwa-labs/harness";
import type { ImageMark, InsertedRange, SessionRecord, ToolCategory } from "@niwa-labs/harness";

import type { Brief, CallStatus, DigestEntry, DigestMode, DigestView, Source } from "./entries.ts";
import { FileIndexer } from "./files.ts";
import type { FileIndex } from "./files.ts";
import { cutEnd, cutMiddle } from "./truncate.ts";

/** How long the arguments of a call may be in a digest. */
export const ARGS_CHARS = 220;

/** How much of a call's result a digest keeps by default, the marker of the cut among it. */
export const RESULT_CHARS = 1_500;

/** What a compression is told beside the mode. */
export interface CompressOptions {
  /** The file index of what was read before, carried on. */
  readonly files?: FileIndex;
  /** How much of a call's result a digest keeps. */
  readonly resultChars?: number;
  /**
   * Whether the reading goes on past these records, so the last turn may not be over. A brief then
   * gives the agent's last message as `tentative`, not as the answer of the turn.
   */
  readonly more?: boolean;
}

/** A compressed reading, and the file index as it stands after it. */
export interface Compressed {
  readonly view: DigestView;
  readonly files: FileIndex;
  /** How many records left nothing in the view: a harness's own insertion, a record niwa does not know. */
  readonly omitted: number;
  /**
   * Whether the reading started over: it was asked to go on from a locator of another source, and
   * what it holds is the session from its beginning. What was gathered before it no longer holds.
   */
  readonly restarted: boolean;
}

/** A value as JSON with its keys sorted and its undefined members left out: the same value always reads the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((each) => (each === undefined ? "null" : canonical(each))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const members = Object.entries(value)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The source of an entry: the record's locator and a digest of the record. The digest is of the
 * record as the common model says it, its keys in order and without the harness's raw data, so the
 * same record read again through `session.read` has the same digest.
 */
export function sourceOf(record: SessionRecord): Source {
  const { raw: _raw, ...said } = record as SessionRecord & { raw?: unknown };
  const digest = createHash("sha256").update(canonical(said)).digest("hex").slice(0, 12);
  return { locator: record.locator, digest };
}

/**
 * The tags the harnesses niwa knows wrap their own insertions in: a reminder, the environment, a
 * slash command and what it ran. A tag a person writes (`<user-card>`) is not among them.
 */
const INSERTION_TAGS = [
  "system-reminder",
  "environment_context",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "agent-context",
  "command-name",
  "command-message",
  "command-args",
  "command-contents",
  "user-prompt-submit-hook",
  "user_instructions",
  "turn_aborted",
];

const INSERTION = new RegExp(`<(${INSERTION_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");

/**
 * The text a harness wrapped around what the person said is not what the person said: a block in
 * one of the tags of `INSERTION_TAGS`. What is left is cut of the blank lines the block stood in; a
 * message without an insertion is returned as it was written.
 */
export function withoutInsertions(text: string): string {
  const said = text.replace(INSERTION, "");
  return said === text ? text : said.replace(/\n{3,}/g, "\n\n").trim();
}

/** What stands in a digest in place of an image. */
export function imageMarker(mark: ImageMark): string {
  return mark.mime === undefined ? "[image]" : `[image ${mark.mime}]`;
}

/** The stretches of `text` that sit in a tag of `INSERTION_TAGS`. */
function taggedRanges(text: string): Array<{ from: number; to: number }> {
  return [...text.matchAll(INSERTION)].map((match) => ({ from: match.index, to: match.index + match[0].length }));
}

/** `text` with the ranges `cuts` left out and a marker for each image where its offset says; the rest is kept as it is. */
function weave(text: string, cuts: ReadonlyArray<{ from: number; to: number }>, images: readonly ImageMark[]): string {
  const merged: Array<{ from: number; to: number }> = [];
  for (const cut of [...cuts].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && cut.from <= last.to) last.to = Math.max(last.to, cut.to);
    else merged.push({ ...cut });
  }
  /** The text from `from` up to `to` that no cut covers. */
  const kept = (from: number, to: number): string => {
    let out = "";
    let cursor = from;
    for (const cut of merged) {
      if (cut.to <= cursor) continue;
      if (cut.from >= to) break;
      if (cut.from > cursor) out += text.slice(cursor, cut.from);
      cursor = Math.max(cursor, cut.to);
    }
    return cursor < to ? out + text.slice(cursor, to) : out;
  };
  let out = "";
  let position = 0;
  for (const mark of [...images].sort((a, b) => a.at - b.at)) {
    const at = Math.min(Math.max(mark.at, position), text.length);
    out += kept(position, at) + imageMarker(mark);
    position = at;
  }
  return out + kept(position, text.length);
}

/**
 * What a person said in a message, as a digest tells it: what the reader marked as inserted is cut
 * out, an image is a marker where it stood, and every other character is kept as it was written.
 * A message the reader did not mark (`inserted` absent) is cut by the tags of the harnesses niwa
 * knows; one it marked, even with nothing marked, is never cut by a tag, so a person's own
 * `<system-reminder>` stays.
 *
 * `undefined` when nothing but whitespace is left and no image stood in the message.
 */
export function saidOf(record: {
  readonly text: string;
  readonly inserted?: readonly InsertedRange[] | undefined;
  readonly images?: readonly ImageMark[] | undefined;
}): string | undefined {
  const images = record.images ?? [];
  if (record.inserted === undefined && images.length === 0) {
    const said = withoutInsertions(record.text);
    return said.length === 0 ? undefined : said;
  }
  const cuts = record.inserted ?? taggedRanges(record.text);
  const said = weave(record.text, cuts, images);
  return images.length === 0 && said.trim().length === 0 ? undefined : said;
}

/** The text of a value a tool gave or was given: a string as it is, anything else as JSON. */
function textOf(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/**
 * The output of a tool with a marker where each image stood: at its index among the blocks of a
 * list, at its offset in a text, at the end of anything else.
 */
function withImages(output: unknown, images: readonly ImageMark[] | undefined): unknown {
  if (images === undefined || images.length === 0) return output;
  const marks = [...images].sort((a, b) => a.at - b.at);
  if (Array.isArray(output)) {
    const blocks: unknown[] = [...output];
    marks.forEach((mark, placed) => blocks.splice(Math.min(mark.at + placed, blocks.length), 0, imageMarker(mark)));
    return blocks;
  }
  if (typeof output === "string") return weave(output, [], marks);
  const markers = marks.map(imageMarker).join(" ");
  return output === undefined ? markers : `${textOf(output)} ${markers}`;
}

/** The paths an edit call changes: all it names, else its target. */
export function editedPaths(record: { readonly target?: string | undefined; readonly paths?: readonly string[] | undefined }): readonly string[] {
  return record.paths ?? (record.target === undefined ? [] : [record.target]);
}

function statusOf(ok: boolean | undefined): CallStatus {
  return ok === false ? "failed" : "done";
}

/** Compress records read in the harness's order. */
export function compress(records: readonly SessionRecord[], mode: DigestMode, options: CompressOptions = {}): Compressed {
  const files = new FileIndexer(options.files);
  const restarted = records.some((record) => record.reanchored === true);
  switch (mode) {
    case "full":
      return { view: { mode, records: [...records] }, files: files.index(), omitted: 0, restarted };
    case "digest": {
      const { entries, omitted } = digestOf(records, files, options.resultChars ?? RESULT_CHARS);
      return { view: { mode, entries }, files: files.index(), omitted, restarted };
    }
    case "brief": {
      const { brief, omitted } = briefOf(records, options.more ?? false);
      return { view: { mode, brief }, files: files.index(), omitted, restarted };
    }
  }
}

function digestOf(records: readonly SessionRecord[], files: FileIndexer, resultChars: number): { entries: DigestEntry[]; omitted: number } {
  const entries: DigestEntry[] = [];
  /** The tool entries whose result has not been read yet, by call id. */
  const open = new Map<string, Extract<DigestEntry, { kind: "tool" }>>();
  let omitted = 0;
  for (const record of records) {
    const source = sourceOf(record);
    switch (record.kind) {
      case "user": {
        const text = saidOf(record);
        if (text === undefined) omitted += 1;
        else entries.push({ kind: "user", text, source });
        break;
      }
      case "assistant":
        entries.push({ kind: "assistant", text: record.text, source });
        break;
      case "thinking":
        entries.push({ kind: "thinking", text: record.text, redacted: record.redacted, source });
        break;
      case "tool-call": {
        const changed = record.category === "edit";
        const paths = editedPaths(record);
        // A call that names several files names each of them, written once and referred to after.
        const target =
          changed && paths.length > 1
            ? paths.map((path) => namedTarget(record.category, path, changed, files)).join(", ")
            : record.target === undefined
              ? undefined
              : namedTarget(record.category, record.target, changed, files);
        const args = record.input === undefined ? undefined : cutEnd(files.refer(textOf(record.input)), ARGS_CHARS);
        const entry: Extract<DigestEntry, { kind: "tool" }> = {
          kind: "tool",
          callId: record.callId,
          category: record.category,
          name: record.name,
          ...(target === undefined ? {} : { target }),
          ...(args === undefined ? {} : { args }),
          status: "pending",
          source,
        };
        entries.push(entry);
        open.set(record.callId, entry);
        break;
      }
      case "tool-result": {
        const output = textOf(withImages(record.output, record.images));
        const result = output.length === 0 ? undefined : cutMiddle(files.refer(output), { keep: resultChars, source: record.locator });
        const call = open.get(record.callId);
        if (call !== undefined) {
          open.delete(record.callId);
          const index = entries.indexOf(call);
          entries[index] = { ...call, status: statusOf(record.ok), ...(result === undefined ? {} : { result }), resultSource: source };
        } else {
          entries.push({ kind: "result", callId: record.callId, status: statusOf(record.ok), ...(result === undefined ? {} : { result }), source });
        }
        break;
      }
      case "compaction":
        entries.push({ kind: "compaction", summary: cutMiddle(record.summary, { keep: resultChars, source: record.locator }), source });
        break;
      case "checklist":
        entries.push({ kind: "checklist", ...checklistProgress(record), items: record.items, source });
        break;
      case "permission":
        entries.push({ kind: "permission", ...(record.tool === undefined ? {} : { tool: record.tool }), outcome: record.outcome, source });
        break;
      case "nested":
        entries.push({ kind: "nested", child: record.child, source });
        break;
      case "unknown":
        omitted += 1;
        break;
    }
  }
  return { entries, omitted };
}

/** The target of a call as a digest names it: a path through the file index, anything else as it is. */
function namedTarget(category: ToolCategory, target: string, changed: boolean, files: FileIndexer): string {
  const isPath = (category === "read" || category === "edit") && !/[\r\n]/.test(target);
  return isPath ? files.name(target, changed) : files.refer(target);
}

function briefOf(records: readonly SessionRecord[], more: boolean): { brief: Brief; omitted: number } {
  const asked: Brief["asked"] = [];
  const answered: Brief["answered"] = [];
  /** The edit calls, in order, with the path each named. */
  const edits: Array<{ callId: string; path: string }> = [];
  /** The calls whose result says they failed. */
  const refused = new Set<string>();
  const calls: Partial<Record<ToolCategory, number>> = {};
  let failed = 0;
  let checklist: Brief["checklist"];
  let omitted = 0;
  /** The last message of the agent in the turn that is being read. */
  let answer: Brief["answered"][number] | undefined;
  /** What spoke last: the agent, or something that waits for it. */
  let last: "answered" | "working" | "empty" = "empty";
  for (const record of records) {
    switch (record.kind) {
      case "user": {
        const text = saidOf(record);
        if (text === undefined) {
          omitted += 1;
          break;
        }
        if (answer !== undefined) answered.push(answer);
        answer = undefined;
        asked.push({ text, source: sourceOf(record) });
        last = "working";
        break;
      }
      case "assistant":
        answer = { text: record.text, source: sourceOf(record) };
        last = "answered";
        break;
      case "tool-call":
        calls[record.category] = (calls[record.category] ?? 0) + 1;
        if (record.category === "edit") for (const path of editedPaths(record)) edits.push({ callId: record.callId, path });
        last = "working";
        break;
      case "tool-result":
        if (record.ok === false) {
          failed += 1;
          refused.add(record.callId);
        }
        last = "working";
        break;
      case "checklist":
        checklist = { ...checklistProgress(record), items: record.items };
        break;
      case "unknown":
        omitted += 1;
        break;
      case "thinking":
      case "compaction":
      case "permission":
      case "nested":
        break;
    }
  }
  // A turn the reading goes on into is not over: its last message may be followed by more.
  const tentative = more ? answer : undefined;
  if (answer !== undefined && !more) answered.push(answer);
  // What a call that was refused did not change; a call whose result is not read yet may have.
  const changed = [...new Set(edits.filter((edit) => !refused.has(edit.callId)).map((edit) => edit.path))];
  return {
    brief: { asked, answered, changed, calls, failed, ...(tentative === undefined ? {} : { tentative }), ...(checklist === undefined ? {} : { checklist }), outcome: last },
    omitted,
  };
}
