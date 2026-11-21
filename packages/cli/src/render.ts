/**
 * render.ts — printing records, traces and requests.
 *
 * Two ways to print: what a person reads, and what a machine reads. The human form is the
 * default; `--json` asks for the machine form. Both come from the same value, so the two never
 * disagree about what happened.
 *
 * The human form is deliberately plain: a line per record, the data on one line, nothing that
 * needs a terminal to understand. A person reads it in a terminal and a script reads it in a
 * pipe, and neither needs the other.
 */

import type { z } from "zod";

import { shortForm } from "@niwa-labs/core";
import type { StatusOutput, DescriptionAnswer, RecordAnswer, TracedRecordAnswer } from "@niwa-labs/client";
import type { JsonSchema } from "@niwa-labs/core";

/** How something is printed. */
export type Format = "text" | "json";

/** The value of one field, as it is printed. */
function field(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** One record as a person reads it: the position, the type, and what it says. */
export function recordLine(record: RecordAnswer): string {
  const who = record.actor.kind === "host" ? "host" : record.actor.kind;
  return `${String(record.seq).padStart(6)}  ${record.type}  ${who}  ${field(record.data)}`;
}

/** The records, one per line. */
export function renderRecords(records: RecordAnswer[]): string {
  if (records.length === 0) return "no records";
  return records.map(recordLine).join("\n");
}

/** One traced record: how deep it was found. */
export function tracedLine(record: TracedRecordAnswer): string {
  return `${"  ".repeat(record.depth)}${recordLine(record)}`;
}

/** The trace, one record per line, deeper first. */
export function renderTrace(records: TracedRecordAnswer[]): string {
  if (records.length === 0) return "nothing grew from that record";
  return records.map(tracedLine).join("\n");
}

/** The fields of an input schema, with their types. */
export function fieldsOf(schema: JsonSchema): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined) return [];
  const required = (schema as { required?: string[] }).required ?? [];
  return Object.entries(properties).map(([name, value]) => {
    const type = (value as { type?: unknown }).type;
    const shown = typeof type === "string" ? type : "any";
    return required.includes(name) ? `${name}: ${shown}` : `${name}?: ${shown}`;
  });
}

/** One action of the description, as a person reads it. */
export function actionLine(action: DescriptionAnswer["actions"][number]): string {
  const fields = fieldsOf(action.input);
  const shown = fields.length === 0 ? "no fields" : fields.join(", ");
  return `${action.name}\n    ${action.description}\n    fields: ${shown}  recovery: ${action.recovery}`;
}

/** The description, as a person reads it. */
export function renderDescription(description: DescriptionAnswer): string {
  const lines: string[] = ["actions:"];
  for (const action of description.actions) lines.push(`  ${actionLine(action)}`);
  lines.push("types:");
  for (const record of description.types) {
    lines.push(`  ${record.name} (v${String(record.version)})`);
  }
  return lines.join("\n");
}

/**
 * The value of a command, in the format that was asked for.
 *
 * The machine form is the value itself: the same JSON the host returned, so a script sees the
 * facts and not a rendering of them.
 */
export function renderValue(value: unknown, format: Format): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return shortForm(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, format)).join("\n");
  }
  if (typeof value === "object") {
    const holder = value as Record<string, unknown>;
    const lines: string[] = [];
    for (const [key, item] of Object.entries(holder)) {
      lines.push(`${key}: ${renderValue(item, format)}`);
    }
    return lines.join("\n");
  }
  return String(value);
}

/** The status of the host: one line for the host, one for each plugin that counts something. */
export function renderStatus(status: z.infer<typeof StatusOutput>): string {
  const counts = (summary: Record<string, number>): string =>
    Object.entries(summary).map(([name, count]) => `${name}=${String(count)}`).join(" ");
  return [
    `up  pid ${String(status.pid)}  ${status.home}  journal seq ${String(status.seq)}`,
    ...status.plugins.map((plugin) => `${plugin.name}  ${plugin.summary === undefined ? "" : counts(plugin.summary)}`.trimEnd()),
  ].join("\n");
}

/** The kinds of subject a line names, in the order it names them. */
const SUBJECT_FIELDS = ["run", "session", "request", "task", "invocation"] as const;

const UUID_TAIL = /^(.*?)([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An id short enough to read in a line: a uuid keeps its first eight characters, a session its harness and the start of its own id. */
export function shortId(id: string): string {
  const [harness, native] = id.split(" ");
  if (native !== undefined) return `${harness}:${shortId(native)}`;
  return id.replace(UUID_TAIL, "$1$2");
}

/**
 * What a record is about, as `run:1a2b3c4d session:s-9f8e7d`: a session niwa started is named by its
 * id (`sessions`, by its pair), another by its harness and the start of its own id.
 */
function subjectOf(data: Record<string, unknown>, id: string | undefined, sessions: ReadonlyMap<string, string>): string {
  const named = SUBJECT_FIELDS.flatMap((kind) => {
    const value = data[kind];
    const text = typeof value === "string" ? value : undefined;
    if (text === undefined) return [];
    if (kind === "session") return [`session:${sessions.get(text) ?? shortId(text)}`];
    return [`${kind}:${kind === "invocation" ? shortForm(text) : shortId(text)}`];
  });
  return named.length > 0 || id === undefined ? named.join(" ") : shortForm(shortId(id));
}

/** The data of a record as `key=value` pairs: the subject fields are in the subject, a long value is cut. */
function dataText(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return field(data);
  return Object.entries(data)
    .filter(([key]) => !(SUBJECT_FIELDS as readonly string[]).includes(key))
    .map(([key, value]) => `${key}=${cut(shortForm(field(value)), 80)}`)
    .join(" ");
}

function cut(text: string, width: number): string {
  const line = text.replace(/\s+/g, " ");
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * One record as a line to read in a terminal: the time, a short type, what it is about, and the
 * data cut to the width. The same shape for every type, so no type is special to it.
 */
export function logLine(record: RecordAnswer, width: number, sessions: ReadonlyMap<string, string> = new Map()): string {
  const time = new Date(record.at).toTimeString().slice(0, 8);
  const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {};
  const id = typeof data["id"] === "string" && record.type.includes(".") ? data["id"] : undefined;
  const type = cut(record.type.replace(/^niwa\./, ""), 26).padEnd(26);
  const subject = subjectOf(data, id, sessions);
  const line = `${time}  ${type}  ${subject}${subject === "" ? "" : "  "}${dataText(data)}`.trimEnd();
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}
